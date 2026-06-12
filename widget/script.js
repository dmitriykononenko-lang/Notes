/**
 * Виджет «Шаблоны задач» для amoCRM.
 *
 * Позволяет завести набор шаблонов задач (текст, тип, срок выполнения,
 * ответственный) и ставить задачи в один клик из карточки сделки,
 * контакта или компании.
 *
 * Шаблоны хранятся в настройках виджета в виде JSON-строки (поле `templates`),
 * поэтому виджету не нужен собственный бэкенд. Редактор шаблонов встроен
 * в окно настроек виджета.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    var STYLE_ID = 'yp-tt-styles';

    // Сопоставление области карточки (system().area) с типом сущности API v4
    var AREA_ENTITY = [
      { prefix: 'lcard', entity: 'leads' },
      { prefix: 'ccard', entity: 'contacts' },
      { prefix: 'comcard', entity: 'companies' }
    ];

    /* ------------------------------ локализация ------------------------------ */

    function t(key, fallback) {
      var node = self.langs || {};
      var parts = key.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (node && typeof node === 'object' && parts[i] in node) {
          node = node[parts[i]];
        } else {
          return fallback;
        }
      }
      return typeof node === 'string' ? node : fallback;
    }

    /* --------------------------------- данные -------------------------------- */

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Шаблоны из сохранённых настроек виджета
    function getTemplates() {
      var settings = self.get_settings() || {};
      if (!settings.templates) {
        return [];
      }
      try {
        var parsed = JSON.parse(settings.templates);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }

    // Типы задач аккаунта (звонок, встреча и пользовательские типы)
    function getTaskTypes() {
      var list = [];
      try {
        var types = (AMOCRM.constant('account') || {}).task_types || {};
        if (Array.isArray(types)) {
          types.forEach(function (type) {
            if (type && type.id) {
              list.push({ id: parseInt(type.id, 10), name: type.option || type.name || ('#' + type.id) });
            }
          });
        } else {
          Object.keys(types).forEach(function (key) {
            var type = types[key] || {};
            var id = parseInt(type.id || key, 10);
            if (id) {
              list.push({ id: id, name: type.option || type.name || ('#' + id) });
            }
          });
        }
      } catch (e) { /* подставим стандартные типы ниже */ }
      if (!list.length) {
        list = [
          { id: 1, name: t('editor.default_types.call', 'Звонок') },
          { id: 2, name: t('editor.default_types.meeting', 'Встреча') }
        ];
      }
      return list;
    }

    // Активные пользователи аккаунта
    function getManagers() {
      var list = [];
      try {
        var managers = AMOCRM.constant('managers') || {};
        Object.keys(managers).forEach(function (key) {
          var manager = managers[key] || {};
          if (manager.active === false) {
            return;
          }
          var id = parseInt(manager.id || key, 10);
          if (id) {
            list.push({ id: id, name: manager.title || manager.name || ('#' + id) });
          }
        });
      } catch (e) { /* список останется пустым */ }
      return list;
    }

    function getCurrentUserId() {
      try {
        return parseInt((AMOCRM.constant('user') || {}).id, 10) || null;
      } catch (e) {
        return null;
      }
    }

    // Определяем сущность и id открытой карточки
    function detectEntity() {
      var area = '';
      try {
        area = String((self.system() || {}).area || '');
      } catch (e) { /* area останется пустой */ }

      var entity = null;
      for (var i = 0; i < AREA_ENTITY.length; i++) {
        if (area.indexOf(AREA_ENTITY[i].prefix) === 0) {
          entity = AREA_ENTITY[i].entity;
          break;
        }
      }

      var id = null;
      try {
        id = parseInt((AMOCRM.data.current_card || {}).id, 10) || null;
      } catch (e) { /* возьмём id из URL */ }

      var match = window.location.pathname.match(/\/(leads|contacts|companies)\/detail\/(\d+)/);
      if (match) {
        if (!entity) {
          entity = match[1];
        }
        if (!id) {
          id = parseInt(match[2], 10);
        }
      }

      return entity && id ? { type: entity, id: id } : null;
    }

    /* ------------------------------ срок и ответственный ------------------------------ */

    function computeCompleteTill(deadline) {
      deadline = deadline || {};
      var amount = parseInt(deadline.amount, 10);
      if (isNaN(amount) || amount < 0) {
        amount = 0;
      }
      var unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[deadline.unit] || 86400000;
      var date = new Date(Date.now() + amount * unitMs);
      if (deadline.endOfDay) {
        date.setHours(23, 59, 0, 0);
      }
      return Math.floor(date.getTime() / 1000);
    }

    function deadlineLabel(deadline) {
      deadline = deadline || {};
      var amount = parseInt(deadline.amount, 10) || 0;
      var parts = [];
      if (amount > 0) {
        parts.push(t('editor.form.deadline_in', 'через') + ' ' + amount + ' ' + t('editor.units.' + deadline.unit, deadline.unit || ''));
      } else {
        parts.push(t('editor.deadline_now', 'сразу'));
      }
      if (deadline.endOfDay) {
        parts.push(t('editor.form.end_of_day', 'перенести на конец дня'));
      }
      return parts.join(', ');
    }

    function resolveResponsibleId(template, entity, callback) {
      var fallback = getCurrentUserId();
      if (template.responsible === 'entity') {
        // Ответственный за карточку — берём из API, это надёжнее данных интерфейса
        $.ajax({
          url: '/api/v4/' + entity.type + '/' + entity.id,
          method: 'GET',
          dataType: 'json'
        }).done(function (response) {
          callback(parseInt(response && response.responsible_user_id, 10) || fallback);
        }).fail(function () {
          callback(fallback);
        });
        return;
      }
      if (template.responsible && template.responsible !== 'current') {
        var id = parseInt(template.responsible, 10);
        if (id) {
          callback(id);
          return;
        }
      }
      callback(fallback);
    }

    /* ------------------------------ создание задачи ------------------------------ */

    function createTaskFromTemplate(template, done) {
      var entity = detectEntity();
      if (!entity) {
        showToast(t('card.no_entity', 'Не удалось определить карточку'), true);
        done();
        return;
      }
      resolveResponsibleId(template, entity, function (responsibleId) {
        var task = {
          text: template.text || template.name || '',
          task_type_id: parseInt(template.task_type_id, 10) || 1,
          complete_till: computeCompleteTill(template.deadline),
          entity_id: entity.id,
          entity_type: entity.type
        };
        if (responsibleId) {
          task.responsible_user_id = responsibleId;
        }
        $.ajax({
          url: '/api/v4/tasks',
          method: 'POST',
          contentType: 'application/json',
          data: JSON.stringify([task]),
          dataType: 'json'
        }).done(function () {
          showToast(t('card.created', 'Задача создана'), false);
          done();
        }).fail(function () {
          showToast(t('card.create_failed', 'Не удалось создать задачу'), true);
          done();
        });
      });
    }

    /* --------------------------------- интерфейс --------------------------------- */

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }
      var css = [
        '.yp-tt{padding:4px 0}',
        '.yp-tt__empty{color:#92989b;font-size:13px;line-height:17px}',
        '.yp-tt__item{padding:7px 10px;margin-bottom:6px;border:1px solid #e2e4e7;border-radius:4px;cursor:pointer;background:#fff;transition:background .15s,border-color .15s}',
        '.yp-tt__item:hover{background:#f5f6f7;border-color:#c9ccd0}',
        '.yp-tt__item_busy{opacity:.5;pointer-events:none}',
        '.yp-tt__item-name{font-size:13px;font-weight:bold;color:#313942}',
        '.yp-tt__item-meta{font-size:12px;color:#92989b;margin-top:2px}',
        '.yp-tt-toast{position:fixed;right:20px;bottom:20px;z-index:99999;background:#313942;color:#fff;padding:10px 16px;border-radius:4px;font-size:13px;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}',
        '.yp-tt-toast_visible{opacity:1;transform:translateY(0)}',
        '.yp-tt-toast_error{background:#e05c5c}',
        '.yp-tt-editor{margin:0 0 15px}',
        '.yp-tt-editor__hint{font-size:13px;color:#92989b;margin-bottom:12px;line-height:17px}',
        '.yp-tt-editor__list{margin-bottom:10px}',
        '.yp-tt-editor__empty{color:#92989b;font-size:13px;margin-bottom:10px}',
        '.yp-tt-editor__row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #e2e4e7;border-radius:4px;margin-bottom:6px;background:#fff}',
        '.yp-tt-editor__row-name{font-size:13px;font-weight:bold;color:#313942}',
        '.yp-tt-editor__row-meta{font-size:12px;color:#92989b;margin-top:2px}',
        '.yp-tt-editor__row-actions{display:flex;gap:10px;margin-left:10px;flex-shrink:0}',
        '.yp-tt-editor__btn{cursor:pointer;color:#92989b;font-size:14px}',
        '.yp-tt-editor__btn:hover{color:#313942}',
        '.yp-tt-editor__add{display:inline-block;cursor:pointer;color:#2e80b6;font-size:13px;margin-bottom:12px}',
        '.yp-tt-editor__add:hover{text-decoration:underline}',
        '.yp-tt-editor__form{border:1px solid #e2e4e7;border-radius:4px;padding:12px;background:#fbfbfb}',
        '.yp-tt-editor__form label{display:block;font-size:13px;color:#313942;margin-bottom:10px}',
        '.yp-tt-editor__form input[type=text],.yp-tt-editor__form textarea,.yp-tt-editor__form select{width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px;background:#fff}',
        '.yp-tt-editor__form input[type=number]{width:70px;padding:6px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px;background:#fff}',
        '.yp-tt-editor__deadline{display:flex;align-items:center;gap:6px;margin-top:4px}',
        '.yp-tt-editor__deadline select{width:auto;margin-top:0}',
        '.yp-tt-editor__checkbox{display:flex;align-items:center;gap:6px}',
        '.yp-tt-editor__checkbox input{margin:0}',
        '.yp-tt-editor__form-buttons{display:flex;gap:10px;margin-top:4px}',
        '.yp-tt-editor__form-buttons button{padding:7px 14px;border-radius:3px;border:1px solid #d4d7da;background:#fff;cursor:pointer;font-size:13px}',
        '.yp-tt-editor__form-save{background:#4c8bf7 !important;border-color:#4c8bf7 !important;color:#fff}'
      ].join('');
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }

    function showToast(message, isError) {
      injectStyles();
      var $toast = $('<div class="yp-tt-toast"></div>')
        .toggleClass('yp-tt-toast_error', !!isError)
        .text(message)
        .appendTo(document.body);
      setTimeout(function () {
        $toast.addClass('yp-tt-toast_visible');
      }, 10);
      setTimeout(function () {
        $toast.removeClass('yp-tt-toast_visible');
        setTimeout(function () {
          $toast.remove();
        }, 300);
      }, 2600);
    }

    // Блок со списком шаблонов в правой колонке карточки
    function renderCardWidget() {
      injectStyles();
      var templates = getTemplates();
      var html = '<div class="yp-tt">';
      if (!templates.length) {
        html += '<div class="yp-tt__empty">' + escapeHtml(t('card.empty', 'Шаблоны не настроены.')) + '</div>';
      } else {
        var typeNames = {};
        getTaskTypes().forEach(function (type) {
          typeNames[type.id] = type.name;
        });
        templates.forEach(function (template) {
          html += '<div class="yp-tt__item" data-tpl-id="' + escapeHtml(String(template.id)) + '" title="' + escapeHtml(template.text || '') + '">' +
            '<div class="yp-tt__item-name">' + escapeHtml(template.name || '') + '</div>' +
            '<div class="yp-tt__item-meta">' + escapeHtml((typeNames[template.task_type_id] || '') + ' · ' + deadlineLabel(template.deadline)) + '</div>' +
            '</div>';
        });
      }
      html += '</div>';

      self.render_template({
        caption: { class_name: 'yp-tt-card' },
        body: html,
        render: ''
      });
    }

    /* ------------------------------ редактор шаблонов ------------------------------ */

    function renderSettingsEditor($modal_body) {
      injectStyles();

      var $field = $modal_body.find('input[name="templates"], textarea[name="templates"]').first();

      var templates = getTemplates();
      try {
        var fieldValue = JSON.parse($field.val());
        if (Array.isArray(fieldValue)) {
          templates = fieldValue;
        }
      } catch (e) { /* используем сохранённые настройки */ }

      var taskTypes = getTaskTypes();
      var managers = getManagers();
      var editIndex = -1;

      var typeOptions = taskTypes.map(function (type) {
        return '<option value="' + escapeHtml(String(type.id)) + '">' + escapeHtml(type.name) + '</option>';
      }).join('');
      var managerOptions = managers.map(function (manager) {
        return '<option value="' + escapeHtml(String(manager.id)) + '">' + escapeHtml(manager.name) + '</option>';
      }).join('');

      var $editor = $(
        '<div class="yp-tt-editor">' +
          '<div class="yp-tt-editor__hint">' + escapeHtml(t('editor.hint', '')) + '</div>' +
          '<div class="yp-tt-editor__list"></div>' +
          '<span class="yp-tt-editor__add">' + escapeHtml(t('editor.add', '+ Добавить шаблон')) + '</span>' +
          '<div class="yp-tt-editor__form" style="display:none">' +
            '<label>' + escapeHtml(t('editor.form.name', 'Название шаблона')) +
              '<input type="text" name="tpl_name">' +
            '</label>' +
            '<label>' + escapeHtml(t('editor.form.text', 'Текст задачи')) +
              '<textarea name="tpl_text" rows="3"></textarea>' +
            '</label>' +
            '<label>' + escapeHtml(t('editor.form.type', 'Тип задачи')) +
              '<select name="tpl_type">' + typeOptions + '</select>' +
            '</label>' +
            '<label>' + escapeHtml(t('editor.form.deadline', 'Срок выполнения')) +
              '<span class="yp-tt-editor__deadline">' +
                escapeHtml(t('editor.form.deadline_in', 'через')) +
                '<input type="number" name="tpl_amount" min="0" value="1">' +
                '<select name="tpl_unit">' +
                  '<option value="minutes">' + escapeHtml(t('editor.units.minutes', 'минут')) + '</option>' +
                  '<option value="hours">' + escapeHtml(t('editor.units.hours', 'часов')) + '</option>' +
                  '<option value="days" selected>' + escapeHtml(t('editor.units.days', 'дней')) + '</option>' +
                '</select>' +
              '</span>' +
            '</label>' +
            '<label class="yp-tt-editor__checkbox">' +
              '<input type="checkbox" name="tpl_eod"> ' + escapeHtml(t('editor.form.end_of_day', 'перенести на конец дня')) +
            '</label>' +
            '<label>' + escapeHtml(t('editor.form.responsible', 'Ответственный')) +
              '<select name="tpl_responsible">' +
                '<option value="current">' + escapeHtml(t('editor.form.responsible_current', 'Текущий пользователь')) + '</option>' +
                '<option value="entity">' + escapeHtml(t('editor.form.responsible_entity', 'Ответственный за карточку')) + '</option>' +
                (managerOptions
                  ? '<optgroup label="' + escapeHtml(t('editor.form.responsible_users', 'Сотрудники')) + '">' + managerOptions + '</optgroup>'
                  : '') +
              '</select>' +
            '</label>' +
            '<div class="yp-tt-editor__form-buttons">' +
              '<button type="button" class="yp-tt-editor__form-save">' + escapeHtml(t('editor.form.save', 'Сохранить шаблон')) + '</button>' +
              '<button type="button" class="yp-tt-editor__form-cancel">' + escapeHtml(t('editor.form.cancel', 'Отмена')) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );

      // Прячем техническое JSON-поле и ставим редактор на его место
      if ($field.length) {
        var $fieldWrap = $field.closest('.widget_settings_block__item_field');
        ($fieldWrap.length ? $fieldWrap : $field).hide().before($editor);
      } else {
        $modal_body.append($editor);
      }

      var $form = $editor.find('.yp-tt-editor__form');

      // Записываем актуальный JSON в поле настроек: амо сохранит его по кнопке «Сохранить»
      function sync() {
        if ($field.length) {
          $field.val(JSON.stringify(templates)).trigger('input').trigger('change');
        }
      }

      function renderList() {
        var $list = $editor.find('.yp-tt-editor__list').empty();
        if (!templates.length) {
          $list.append($('<div class="yp-tt-editor__empty"></div>').text(t('editor.empty', 'Пока нет ни одного шаблона.')));
          return;
        }
        var typeNames = {};
        taskTypes.forEach(function (type) {
          typeNames[type.id] = type.name;
        });
        templates.forEach(function (template, index) {
          var $row = $(
            '<div class="yp-tt-editor__row">' +
              '<div class="yp-tt-editor__row-info">' +
                '<div class="yp-tt-editor__row-name"></div>' +
                '<div class="yp-tt-editor__row-meta"></div>' +
              '</div>' +
              '<div class="yp-tt-editor__row-actions">' +
                '<span class="yp-tt-editor__btn yp-tt-editor__btn-edit" title="' + escapeHtml(t('editor.edit', 'Редактировать')) + '">&#9998;</span>' +
                '<span class="yp-tt-editor__btn yp-tt-editor__btn-delete" title="' + escapeHtml(t('editor.delete', 'Удалить')) + '">&#10005;</span>' +
              '</div>' +
            '</div>'
          );
          $row.find('.yp-tt-editor__row-name').text(template.name || '');
          $row.find('.yp-tt-editor__row-meta').text((typeNames[template.task_type_id] || '') + ' · ' + deadlineLabel(template.deadline));
          $row.find('.yp-tt-editor__btn-edit').on('click', function () {
            openForm(index);
          });
          $row.find('.yp-tt-editor__btn-delete').on('click', function () {
            templates.splice(index, 1);
            sync();
            renderList();
            if (editIndex === index) {
              closeForm();
            }
          });
          $list.append($row);
        });
      }

      function openForm(index) {
        editIndex = index;
        var template = templates[index] || {
          name: '',
          text: '',
          task_type_id: taskTypes[0] ? taskTypes[0].id : 1,
          deadline: { amount: 1, unit: 'days', endOfDay: false },
          responsible: 'current'
        };
        var deadline = template.deadline || {};
        $form.find('[name="tpl_name"]').val(template.name || '');
        $form.find('[name="tpl_text"]').val(template.text || '');
        $form.find('[name="tpl_type"]').val(String(template.task_type_id || ''));
        $form.find('[name="tpl_amount"]').val(deadline.amount != null ? deadline.amount : 1);
        $form.find('[name="tpl_unit"]').val(deadline.unit || 'days');
        $form.find('[name="tpl_eod"]').prop('checked', !!deadline.endOfDay);
        $form.find('[name="tpl_responsible"]').val(String(template.responsible || 'current'));
        $form.show();
      }

      function closeForm() {
        editIndex = -1;
        $form.hide();
      }

      $editor.find('.yp-tt-editor__add').on('click', function () {
        openForm(templates.length);
      });

      $form.find('.yp-tt-editor__form-cancel').on('click', closeForm);

      $form.find('.yp-tt-editor__form-save').on('click', function () {
        var name = $.trim($form.find('[name="tpl_name"]').val());
        var text = $.trim($form.find('[name="tpl_text"]').val());
        if (!name || !text) {
          showToast(t('editor.validation', 'Заполните название и текст задачи'), true);
          return;
        }
        var existing = templates[editIndex];
        var template = {
          id: (existing && existing.id) || ('tpl_' + Date.now() + '_' + Math.floor(Math.random() * 10000)),
          name: name,
          text: text,
          task_type_id: parseInt($form.find('[name="tpl_type"]').val(), 10) || 1,
          deadline: {
            amount: Math.max(0, parseInt($form.find('[name="tpl_amount"]').val(), 10) || 0),
            unit: $form.find('[name="tpl_unit"]').val() || 'days',
            endOfDay: $form.find('[name="tpl_eod"]').is(':checked')
          },
          responsible: $form.find('[name="tpl_responsible"]').val() || 'current'
        };
        if (editIndex >= 0 && editIndex < templates.length) {
          templates[editIndex] = template;
        } else {
          templates.push(template);
        }
        sync();
        renderList();
        closeForm();
      });

      renderList();
    }

    /* --------------------------------- callbacks --------------------------------- */

    this.callbacks = {
      render: function () {
        var area = '';
        try {
          area = String((self.system() || {}).area || '');
        } catch (e) { /* не карточка */ }
        var isCard = AREA_ENTITY.some(function (item) {
          return area.indexOf(item.prefix) === 0;
        });
        if (isCard) {
          renderCardWidget();
        }
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        // Делегированный обработчик переживает перерисовки карточки,
        // неймспейс защищает от дублей при повторных вызовах bind_actions
        $(document).off('click.ypTT').on('click.ypTT', '.yp-tt__item', function () {
          var $item = $(this);
          if ($item.hasClass('yp-tt__item_busy')) {
            return;
          }
          var id = $item.attr('data-tpl-id');
          var template = null;
          getTemplates().forEach(function (item) {
            if (String(item.id) === String(id)) {
              template = item;
            }
          });
          if (!template) {
            return;
          }
          $item.addClass('yp-tt__item_busy');
          createTaskFromTemplate(template, function () {
            $item.removeClass('yp-tt__item_busy');
          });
        });
        return true;
      },

      settings: function ($modal_body) {
        renderSettingsEditor($modal_body);
        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        $(document).off('click.ypTT');
        $('.yp-tt-toast').remove();
      },

      contacts: {
        selected: function () {}
      },

      leads: {
        selected: function () {}
      },

      advancedSettings: function () {}
    };

    return this;
  };

  return CustomWidget;
});
