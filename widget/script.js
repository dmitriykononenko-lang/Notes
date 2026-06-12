/**
 * Виджет «Шаблоны задач» для amoCRM.
 *
 * Позволяет завести набор шаблонов задач (комментарий, тип, срок выполнения,
 * ответственный) и ставить задачи в один клик из карточки сделки,
 * контакта или компании.
 *
 * UX повторяет виджет-пример YouPlatform:
 *  - в карточке кнопка открывает модальное окно «Выберите шаблон для
 *    постановки задачи» с карточками шаблонов (вычисленный срок,
 *    ответственный, тип — комментарий);
 *  - «Редактор шаблонов» — модальное окно со списком шаблонов и формой
 *    «Создать шаблон» (срок-пресет, выбор даты вручную, ответственный,
 *    тип задачи, комментарий).
 *
 * Хранение: служебный список «Шаблоны задач (данные виджета)» (catalogs
 * API v4) — один элемент с JSON шаблонов в текстовом поле. Виджет создаёт
 * список автоматически при первом сохранении. Поле настроек `templates`
 * используется как резервная копия и для миграции.
 */
define(['jquery', 'lib/components/base/modal'], function ($, Modal) {
  var CustomWidget = function () {
    var self = this;

    var STYLE_ID = 'yp-tt-styles';

    // Сопоставление области карточки (system().area) с типом сущности API v4
    var AREA_ENTITY = [
      { prefix: 'lcard', entity: 'leads' },
      { prefix: 'ccard', entity: 'contacts' },
      { prefix: 'comcard', entity: 'companies' }
    ];

    // Пресеты срока выполнения: ключ -> смещение от момента постановки
    var DEADLINE_PRESETS = [
      { key: 'now', ms: 0 },
      { key: 'min15', ms: 15 * 60000 },
      { key: 'min30', ms: 30 * 60000 },
      { key: 'hour1', ms: 3600000 },
      { key: 'today_end', endOfDay: true },
      { key: 'tomorrow', ms: 86400000 },
      { key: 'days2', ms: 2 * 86400000 },
      { key: 'days3', ms: 3 * 86400000 },
      { key: 'week', ms: 7 * 86400000 }
    ];

    // Кэш шаблонов после сохранения через API (настройки обновятся
    // только после перезагрузки страницы)
    var templatesCache = null;

    // Наблюдатель за появлением меню «...» в разделе Задачи
    var todoMenuObserver = null;

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

    // Синхронное чтение шаблонов из поля настроек виджета
    // (резерв и миграция; основное хранилище — служебный список, см. ниже)
    function readSettingsTemplates() {
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

    function getTemplates() {
      if (templatesCache !== null) {
        return templatesCache;
      }
      return readSettingsTemplates();
    }

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

    function getTaskTypeName(id) {
      var name = '';
      getTaskTypes().forEach(function (type) {
        if (String(type.id) === String(id)) {
          name = type.name;
        }
      });
      return name;
    }

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

    function getCurrentUser() {
      try {
        var user = AMOCRM.constant('user') || {};
        return { id: parseInt(user.id, 10) || null, name: user.name || '' };
      } catch (e) {
        return { id: null, name: '' };
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

    /* ------------------------------ срок выполнения ------------------------------ */

    function pad(n) {
      return (n < 10 ? '0' : '') + n;
    }

    function formatTs(ts) {
      var date = new Date(ts * 1000);
      return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear() +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function deadlinePresetLabel(key) {
      return t('deadlines.' + key, key);
    }

    function computeCompleteTill(template) {
      var deadline = template.deadline;

      // Совместимость со старым форматом {amount, unit, endOfDay}
      if (deadline && typeof deadline === 'object') {
        var amount = parseInt(deadline.amount, 10);
        if (isNaN(amount) || amount < 0) {
          amount = 0;
        }
        var unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[deadline.unit] || 86400000;
        var legacy = new Date(Date.now() + amount * unitMs);
        if (deadline.endOfDay) {
          legacy.setHours(23, 59, 0, 0);
        }
        return Math.floor(legacy.getTime() / 1000);
      }

      var preset = null;
      DEADLINE_PRESETS.forEach(function (item) {
        if (item.key === deadline) {
          preset = item;
        }
      });
      if (!preset) {
        preset = DEADLINE_PRESETS[0];
      }
      var date = new Date(Date.now() + (preset.ms || 0));
      if (preset.endOfDay) {
        date.setHours(23, 59, 0, 0);
      }
      return Math.floor(date.getTime() / 1000);
    }

    /* ------------------------------ ответственный ------------------------------ */

    function responsibleName(template) {
      if (template.responsible === 'entity') {
        return t('picker.entity_responsible', 'ответственного за карточку');
      }
      if (template.responsible && template.responsible !== 'current') {
        var name = '';
        getManagers().forEach(function (manager) {
          if (String(manager.id) === String(template.responsible)) {
            name = manager.name;
          }
        });
        if (name) {
          return name;
        }
      }
      return getCurrentUser().name || t('form.responsible_current', 'Текущий пользователь');
    }

    function resolveResponsibleId(template, entity, callback) {
      var fallback = getCurrentUser().id;
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

    function createTaskFromTemplate(template, completeTillOverride, done) {
      var entity = detectEntity();
      if (!entity) {
        showToast(t('card.no_entity', 'Не удалось определить карточку'), true);
        done(false);
        return;
      }
      resolveResponsibleId(template, entity, function (responsibleId) {
        var task = {
          text: template.text || template.name || '',
          task_type_id: parseInt(template.task_type_id, 10) || 1,
          complete_till: completeTillOverride || computeCompleteTill(template),
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
          done(true);
        }).fail(function () {
          showToast(t('card.create_failed', 'Не удалось создать задачу'), true);
          done(false);
        });
      });
    }

    /* ------------------------------ хранилище шаблонов ------------------------------ */

    // Основное хранилище — служебный список (catalogs API v4): один элемент
    // с JSON шаблонов в текстовом поле. Документированный API, доступен из
    // интерфейса всем пользователям с правами на списки; в отличие от
    // настроек виджета, запись работает не только из окна настроек.

    var STORAGE_CATALOG_NAME = 'Шаблоны задач (данные виджета)';
    var STORAGE_FIELD_NAME = 'Данные';
    var STORAGE_ELEMENT_NAME = 'config';
    var storage = { catalogId: null, fieldId: null, elementId: null };

    function logStorageError(stage, xhr) {
      console.error('[Шаблоны задач] Ошибка хранилища на шаге «' + stage + '», HTTP ' +
        (xhr && xhr.status), xhr && xhr.responseText);
    }

    // Ищем служебный список и текстовое поле в нём
    function findStorage(callback) {
      if (storage.catalogId && storage.fieldId) {
        callback(true);
        return;
      }
      $.ajax({
        url: '/api/v4/catalogs?limit=250',
        method: 'GET',
        dataType: 'json'
      }).done(function (response) {
        var catalogs = (response && response._embedded && response._embedded.catalogs) || [];
        var found = null;
        catalogs.forEach(function (catalog) {
          if (catalog && catalog.name === STORAGE_CATALOG_NAME) {
            found = catalog;
          }
        });
        if (!found) {
          callback(false);
          return;
        }
        storage.catalogId = found.id;
        findStorageField(callback);
      }).fail(function (xhr) {
        logStorageError('поиск списка', xhr);
        callback(false);
      });
    }

    function findStorageField(callback) {
      $.ajax({
        url: '/api/v4/catalogs/' + storage.catalogId + '/custom_fields',
        method: 'GET',
        dataType: 'json'
      }).done(function (response) {
        var fields = (response && response._embedded && response._embedded.custom_fields) || [];
        var found = null;
        fields.forEach(function (field) {
          if (!found && field && (field.name === STORAGE_FIELD_NAME || field.type === 'textarea')) {
            found = field;
          }
        });
        if (found) {
          storage.fieldId = found.id;
        }
        callback(!!found);
      }).fail(function (xhr) {
        logStorageError('поиск поля', xhr);
        callback(false);
      });
    }

    // Создаём служебный список с текстовым полем (первое сохранение)
    function createStorage(callback) {
      $.ajax({
        url: '/api/v4/catalogs',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify([{ name: STORAGE_CATALOG_NAME, type: 'regular', can_add_elements: false }]),
        dataType: 'json'
      }).done(function (response) {
        var created = response && response._embedded && response._embedded.catalogs &&
          response._embedded.catalogs[0];
        if (!created || !created.id) {
          callback(false);
          return;
        }
        storage.catalogId = created.id;
        $.ajax({
          url: '/api/v4/catalogs/' + storage.catalogId + '/custom_fields',
          method: 'POST',
          contentType: 'application/json',
          data: JSON.stringify([{ name: STORAGE_FIELD_NAME, type: 'textarea' }]),
          dataType: 'json'
        }).done(function (fieldResponse) {
          var field = fieldResponse && fieldResponse._embedded && fieldResponse._embedded.custom_fields &&
            fieldResponse._embedded.custom_fields[0];
          if (field && field.id) {
            storage.fieldId = field.id;
            callback(true);
          } else {
            callback(false);
          }
        }).fail(function (xhr) {
          logStorageError('создание поля', xhr);
          callback(false);
        });
      }).fail(function (xhr) {
        logStorageError('создание списка', xhr);
        callback(false);
      });
    }

    // Загрузка шаблонов: кэш страницы → служебный список → поле настроек
    function loadTemplates(callback) {
      if (templatesCache !== null) {
        callback(templatesCache);
        return;
      }
      findStorage(function (found) {
        if (!found) {
          templatesCache = readSettingsTemplates();
          callback(templatesCache);
          return;
        }
        $.ajax({
          url: '/api/v4/catalogs/' + storage.catalogId + '/elements?limit=50',
          method: 'GET',
          dataType: 'json'
        }).done(function (response) {
          var elements = (response && response._embedded && response._embedded.elements) || [];
          var list = readSettingsTemplates();
          elements.forEach(function (element) {
            var values = (element && element.custom_fields_values) || [];
            values.forEach(function (value) {
              if (value && value.field_id === storage.fieldId &&
                  value.values && value.values[0] && value.values[0].value) {
                try {
                  var parsed = JSON.parse(value.values[0].value);
                  if (Array.isArray(parsed)) {
                    list = parsed;
                    storage.elementId = element.id;
                  }
                } catch (e) { /* битый JSON — остаёмся на настройках */ }
              }
            });
          });
          templatesCache = list;
          callback(list);
        }).fail(function (xhr) {
          logStorageError('чтение элементов', xhr);
          templatesCache = readSettingsTemplates();
          callback(templatesCache);
        });
      });
    }

    // Сохранение шаблонов в служебный список
    function saveTemplates(templates, done) {
      var json = JSON.stringify(templates);

      function writeElement() {
        var values = [{ field_id: storage.fieldId, values: [{ value: json }] }];
        var isUpdate = !!storage.elementId;
        var payload = isUpdate
          ? [{ id: storage.elementId, name: STORAGE_ELEMENT_NAME, custom_fields_values: values }]
          : [{ name: STORAGE_ELEMENT_NAME, custom_fields_values: values }];
        $.ajax({
          url: '/api/v4/catalogs/' + storage.catalogId + '/elements',
          method: isUpdate ? 'PATCH' : 'POST',
          contentType: 'application/json',
          data: JSON.stringify(payload),
          dataType: 'json'
        }).done(function (response) {
          if (!isUpdate) {
            var element = response && response._embedded && response._embedded.elements &&
              response._embedded.elements[0];
            if (element && element.id) {
              storage.elementId = element.id;
            }
          }
          templatesCache = templates;
          done(true);
        }).fail(function (xhr) {
          logStorageError('запись элемента', xhr);
          done(false, 'http_' + (xhr && xhr.status));
        });
      }

      findStorage(function (found) {
        if (found) {
          writeElement();
          return;
        }
        createStorage(function (created) {
          if (!created) {
            done(false, 'storage');
            return;
          }
          writeElement();
        });
      });
    }

    function persistWithToast(templates, done) {
      saveTemplates(templates, function (ok, errInfo) {
        if (!ok) {
          var message = t('editor.save_failed', 'Не удалось сохранить шаблоны. Изменить их можно в настройках виджета.');
          if (errInfo && errInfo !== 'storage') {
            message += ' [' + errInfo.replace('http_', 'HTTP ') + ']';
          }
          showToast(message, true);
        }
        done(ok);
      });
    }

    /* --------------------------------- стили --------------------------------- */

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }
      var css = [
        /* блок в карточке */
        '.yp-tt{padding:4px 0}',
        '.yp-tt__open{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:none;border-radius:3px;background:#4c8bf7;color:#fff;font-size:13px;cursor:pointer;text-align:center}',
        '.yp-tt__open:hover{background:#3f7be0}',
        '.yp-tt__editor-open{display:inline-block;margin-top:8px;font-size:12px;color:#92989b;cursor:pointer;border-bottom:1px dashed #c4c8cb}',
        '.yp-tt__editor-open:hover{color:#313942}',
        /* всплывающее уведомление */
        '.yp-tt-toast{position:fixed;right:20px;bottom:20px;z-index:999999;background:#313942;color:#fff;padding:10px 16px;border-radius:4px;font-size:13px;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}',
        '.yp-tt-toast_visible{opacity:1;transform:translateY(0)}',
        '.yp-tt-toast_error{background:#e05c5c}',
        /* общее для модальных окон */
        '.yp-tt-modal{padding:25px 30px;box-sizing:border-box}',
        '.yp-tt-modal__title{font-size:18px;color:#313942;margin:0 0 18px;font-weight:normal}',
        /* окно выбора шаблона */
        '.yp-tt-picker__card{border:1px solid #e2e4e7;border-radius:4px;padding:12px 15px;margin-bottom:12px;cursor:pointer;background:#fff;transition:border-color .15s,box-shadow .15s}',
        '.yp-tt-picker__card:hover{border-color:#b9bdc2;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
        '.yp-tt-picker__card_busy{opacity:.5;pointer-events:none}',
        '.yp-tt-picker__card-name{font-size:15px;font-weight:bold;color:#313942;margin-bottom:6px}',
        '.yp-tt-picker__card-line{font-size:13px;color:#92989b;line-height:18px}',
        '.yp-tt-picker__manual{display:flex;gap:8px;align-items:center;margin-top:10px}',
        '.yp-tt-picker__manual input{padding:6px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px}',
        '.yp-tt-picker__manual button{padding:6px 12px;border:none;border-radius:3px;background:#4c8bf7;color:#fff;font-size:13px;cursor:pointer}',
        '.yp-tt-picker__empty{font-size:13px;color:#92989b;margin-bottom:15px}',
        '.yp-tt-picker__editor-link{display:inline-block;font-size:13px;color:#2e80b6;cursor:pointer}',
        '.yp-tt-picker__editor-link:hover{text-decoration:underline}',
        /* редактор шаблонов */
        '.yp-tt-list__row{display:flex;align-items:center;gap:12px;margin-bottom:10px}',
        '.yp-tt-list__row-name{flex:1;padding:10px 14px;border:1px solid #e2e4e7;border-radius:3px;background:#fff;font-size:14px;color:#313942;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.yp-tt-list__row-name:hover{border-color:#b9bdc2}',
        '.yp-tt-list__row-delete{cursor:pointer;flex-shrink:0;display:inline-flex;color:#d99b9b}',
        '.yp-tt-list__row-delete:hover{color:#cd5c5c}',
        '.yp-tt-list__empty{font-size:13px;color:#92989b;margin-bottom:12px}',
        '.yp-tt-list__add{display:inline-block;padding:9px 16px;border:1px solid #e2e4e7;border-radius:3px;background:#fff;font-size:13px;font-weight:bold;color:#313942;cursor:pointer}',
        '.yp-tt-list__add:hover{background:#f5f6f7}',
        /* пункт в меню «...» раздела Задачи */
        '.yp-tt-menu-item{cursor:pointer}',
        '.yp-tt-menu-item__icon svg{vertical-align:middle}',
        /* форма шаблона */
        '.yp-tt-form__field{margin-bottom:12px}',
        '.yp-tt-form input[type=text],.yp-tt-form select,.yp-tt-form textarea,.yp-tt-form input[type=datetime-local]{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d4d7da;border-radius:3px;font-size:13px;background:#fff;color:#313942}',
        '.yp-tt-form textarea{resize:vertical;min-height:70px}',
        '.yp-tt-form__checkbox{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;cursor:pointer}',
        '.yp-tt-form__checkbox input{margin:0}',
        '.yp-tt-form__buttons{display:flex;align-items:center;gap:16px;margin-top:18px}',
        '.yp-tt-form__save{padding:9px 18px;border:1px solid #d4d7da;border-radius:3px;background:#fff;font-size:13px;font-weight:bold;color:#313942;cursor:pointer}',
        '.yp-tt-form__save:hover{background:#f5f6f7}',
        '.yp-tt-form__cancel{font-size:13px;color:#92989b;cursor:pointer}',
        '.yp-tt-form__cancel:hover{color:#313942}',
        /* редактор внутри настроек виджета */
        '.yp-tt-settings{margin:0 0 15px}',
        '.yp-tt-settings__hint{font-size:13px;color:#92989b;margin-bottom:12px;line-height:17px}'
      ].join('');
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }

    var TRASH_SVG = '<svg width="15" height="16" viewBox="0 0 15 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1.5 4h12M5.5 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4m2.5 0v9.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V4" ' +
      'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M6 7v5M9 7v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

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

    /* ------------------------------ модальные окна ------------------------------ */

    function openYpModal(className, html, onReady) {
      injectStyles();
      // init вызывается синхронно из конструктора Modal, поэтому экземпляр
      // окна берём из this, а не из ещё не присвоенной переменной
      return new Modal({
        class_name: 'yp-tt-modal-holder',
        init: function ($modal_body) {
          var modalInstance = this;
          $modal_body
            .addClass('yp-tt-modal ' + className)
            .css({ width: '650px' })
            .html(html)
            .trigger('modal:loaded')
            .trigger('modal:centrify');
          if (onReady) {
            onReady($modal_body, modalInstance);
          }
        },
        destroy: function () {}
      });
    }

    function closeYpModal(modal) {
      try {
        modal.destroy();
      } catch (e) { /* окно уже закрыто */ }
    }

    /* ----------------------------- выбор шаблона ----------------------------- */

    function pickerCardHtml(template) {
      var deadlineLine;
      if (template.manualDate) {
        deadlineLine = t('picker.manual_date', 'Дата выбирается вручную') +
          ' ' + t('picker.for', 'для') + ' ' + responsibleName(template);
      } else {
        deadlineLine = t('picker.till', 'До') + ' ' + formatTs(computeCompleteTill(template)) +
          ' ' + t('picker.for', 'для') + ' ' + responsibleName(template);
      }
      var typeName = getTaskTypeName(template.task_type_id);
      var infoLine = typeName + (template.text ? ' — ' + template.text : '');
      return '<div class="yp-tt-picker__card" data-tpl-id="' + escapeHtml(String(template.id)) + '">' +
        '<div class="yp-tt-picker__card-name">' + escapeHtml(template.name || '') + '</div>' +
        '<div class="yp-tt-picker__card-line">' + escapeHtml(deadlineLine) + '</div>' +
        '<div class="yp-tt-picker__card-line">' + escapeHtml(infoLine) + '</div>' +
        '</div>';
    }

    function datetimeLocalValue(date) {
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function openPickerModal() {
      loadTemplates(function (templates) {
        openPickerModalWith(templates);
      });
    }

    function openPickerModalWith(templates) {
      var html = '<div class="yp-tt-picker">' +
        '<h2 class="yp-tt-modal__title">' + escapeHtml(t('picker.title', 'Выберите шаблон для постановки задачи:')) + '</h2>';
      if (!templates.length) {
        html += '<div class="yp-tt-picker__empty">' + escapeHtml(t('picker.empty', 'Шаблоны не настроены. Добавьте их в редакторе шаблонов.')) + '</div>';
      } else {
        templates.forEach(function (template) {
          html += pickerCardHtml(template);
        });
      }
      html += '<span class="yp-tt-picker__editor-link">' + escapeHtml(t('card.editor', 'Редактор шаблонов')) + '</span>' +
        '</div>';

      openYpModal('yp-tt-picker-modal', html, function ($body, modal) {
        $body.find('.yp-tt-picker__editor-link').on('click', function () {
          closeYpModal(modal);
          openEditorModal(persistWithToast);
        });

        $body.find('.yp-tt-picker__card').on('click', function () {
          var $card = $(this);
          if ($card.hasClass('yp-tt-picker__card_busy')) {
            return;
          }
          var id = $card.attr('data-tpl-id');
          var template = null;
          templates.forEach(function (item) {
            if (String(item.id) === String(id)) {
              template = item;
            }
          });
          if (!template) {
            return;
          }

          if (template.manualDate) {
            // Срок выбирается вручную: показываем поле даты внутри карточки
            if ($card.find('.yp-tt-picker__manual').length) {
              return;
            }
            var defaultDate = new Date(Date.now() + 3600000);
            var $manual = $(
              '<div class="yp-tt-picker__manual">' +
                '<input type="datetime-local" value="' + datetimeLocalValue(defaultDate) + '">' +
                '<button type="button">' + escapeHtml(t('picker.create', 'Поставить задачу')) + '</button>' +
              '</div>'
            );
            $manual.on('click', function (event) {
              event.stopPropagation();
            });
            $manual.find('button').on('click', function () {
              var value = $manual.find('input').val();
              var parsed = value ? new Date(value) : null;
              if (!parsed || isNaN(parsed.getTime())) {
                return;
              }
              $card.addClass('yp-tt-picker__card_busy');
              createTaskFromTemplate(template, Math.floor(parsed.getTime() / 1000), function (ok) {
                $card.removeClass('yp-tt-picker__card_busy');
                if (ok) {
                  closeYpModal(modal);
                }
              });
            });
            $card.append($manual);
            return;
          }

          $card.addClass('yp-tt-picker__card_busy');
          createTaskFromTemplate(template, null, function (ok) {
            $card.removeClass('yp-tt-picker__card_busy');
            if (ok) {
              closeYpModal(modal);
            }
          });
        });
      });
    }

    /* ----------------------------- форма шаблона ----------------------------- */

    function buildFormFieldsHtml() {
      var deadlineOptions = DEADLINE_PRESETS.map(function (preset) {
        return '<option value="' + preset.key + '">' +
          escapeHtml(t('form.deadline_prefix', 'Со сроком выполнения:') + ' ' + deadlinePresetLabel(preset.key)) +
          '</option>';
      }).join('');

      var typeOptions = getTaskTypes().map(function (type) {
        return '<option value="' + escapeHtml(String(type.id)) + '">' + escapeHtml(type.name) + '</option>';
      }).join('');

      var managerOptions = getManagers().map(function (manager) {
        return '<option value="' + escapeHtml(String(manager.id)) + '">' + escapeHtml(manager.name) + '</option>';
      }).join('');

      return '<div class="yp-tt-form__field">' +
          '<input type="text" name="tpl_name" placeholder="' + escapeHtml(t('form.name_placeholder', 'Название шаблона')) + '">' +
        '</div>' +
        '<div class="yp-tt-form__field">' +
          '<select name="tpl_deadline">' + deadlineOptions + '</select>' +
        '</div>' +
        '<div class="yp-tt-form__field">' +
          '<label class="yp-tt-form__checkbox">' +
            '<input type="checkbox" name="tpl_manual"> ' + escapeHtml(t('form.manual_date', 'Выбор даты вручную')) +
          '</label>' +
        '</div>' +
        '<div class="yp-tt-form__field">' +
          '<select name="tpl_responsible">' +
            '<option value="current">' + escapeHtml(t('form.responsible', 'Ответственный') + ': ' + t('form.responsible_current', 'Текущий пользователь')) + '</option>' +
            '<option value="entity">' + escapeHtml(t('form.responsible', 'Ответственный') + ': ' + t('form.responsible_entity', 'Ответственный за карточку')) + '</option>' +
            managerOptions +
          '</select>' +
        '</div>' +
        '<div class="yp-tt-form__field">' +
          '<select name="tpl_type">' + typeOptions + '</select>' +
        '</div>' +
        '<div class="yp-tt-form__field">' +
          '<textarea name="tpl_text" rows="3" placeholder="' + escapeHtml(t('form.comment_placeholder', 'Добавьте комментарий')) + '"></textarea>' +
        '</div>';
    }

    function fillForm($root, template) {
      template = template || {};
      $root.find('[name="tpl_name"]').val(template.name || '');
      $root.find('[name="tpl_deadline"]').val(typeof template.deadline === 'string' ? template.deadline : 'now');
      $root.find('[name="tpl_manual"]').prop('checked', !!template.manualDate);
      $root.find('[name="tpl_responsible"]').val(String(template.responsible || 'current'));
      var types = getTaskTypes();
      $root.find('[name="tpl_type"]').val(String(template.task_type_id || (types[0] && types[0].id) || 1));
      $root.find('[name="tpl_text"]').val(template.text || '');
    }

    function readForm($root, existing) {
      var name = String($root.find('[name="tpl_name"]').val() || '').trim();
      if (!name) {
        showToast(t('form.validation', 'Укажите название шаблона'), true);
        return null;
      }
      return {
        id: (existing && existing.id) || ('tpl_' + Date.now() + '_' + Math.floor(Math.random() * 10000)),
        name: name,
        text: String($root.find('[name="tpl_text"]').val() || '').trim(),
        task_type_id: parseInt($root.find('[name="tpl_type"]').val(), 10) || 1,
        deadline: $root.find('[name="tpl_deadline"]').val() || 'now',
        manualDate: $root.find('[name="tpl_manual"]').is(':checked'),
        responsible: $root.find('[name="tpl_responsible"]').val() || 'current'
      };
    }

    // Модальное окно «Создать шаблон» / редактирование существующего
    function openFormModal(existing, onSave) {
      var title = existing
        ? t('form.title_edit', 'Редактировать шаблон')
        : t('form.title_new', 'Создать шаблон');
      var html = '<div class="yp-tt-form">' +
        '<h2 class="yp-tt-modal__title">' + escapeHtml(title) + '</h2>' +
        buildFormFieldsHtml() +
        '<div class="yp-tt-form__buttons">' +
          '<button type="button" class="yp-tt-form__save">' + escapeHtml(t('form.save', 'Сохранить')) + '</button>' +
          '<span class="yp-tt-form__cancel">' + escapeHtml(t('form.cancel', 'Отменить')) + '</span>' +
        '</div>' +
        '</div>';

      openYpModal('yp-tt-form-modal', html, function ($body, modal) {
        fillForm($body, existing);
        $body.find('.yp-tt-form__cancel').on('click', function () {
          closeYpModal(modal);
          onSave(null);
        });
        $body.find('.yp-tt-form__save').on('click', function () {
          var template = readForm($body, existing);
          if (!template) {
            return;
          }
          closeYpModal(modal);
          onSave(template);
        });
      });
    }

    /* --------------------------- редактор шаблонов --------------------------- */

    function editorListHtml(templates) {
      var html = '';
      if (!templates.length) {
        html += '<div class="yp-tt-list__empty">' + escapeHtml(t('editor.empty', 'Пока нет ни одного шаблона.')) + '</div>';
      } else {
        templates.forEach(function (template, index) {
          html += '<div class="yp-tt-list__row" data-index="' + index + '">' +
            '<div class="yp-tt-list__row-name">' + escapeHtml(template.name || '') + '</div>' +
            '<span class="yp-tt-list__row-delete" title="' + escapeHtml(t('editor.delete', 'Удалить')) + '">' + TRASH_SVG + '</span>' +
            '</div>';
        });
      }
      return html;
    }

    // Модальное окно «Редактор шаблонов».
    // persist(templates, done) отвечает за сохранение изменений.
    // templatesOverride сохраняет локальное состояние списка между
    // переоткрытиями окна, чтобы введённое не терялось при ошибке сохранения.
    function openEditorModal(persist, templatesOverride) {
      if (!templatesOverride) {
        loadTemplates(function (loaded) {
          openEditorModal(persist, loaded);
        });
        return;
      }
      var templates = templatesOverride.slice();

      var html = '<div class="yp-tt-list">' +
        '<h2 class="yp-tt-modal__title">' + escapeHtml(t('editor.title', 'Редактор шаблонов')) + '</h2>' +
        '<div class="yp-tt-list__items">' + editorListHtml(templates) + '</div>' +
        '<button type="button" class="yp-tt-list__add">' + escapeHtml(t('editor.new', '+ новый шаблон')) + '</button>' +
        '</div>';

      openYpModal('yp-tt-editor-modal', html, function ($body, modal) {
        function refresh() {
          $body.find('.yp-tt-list__items').html(editorListHtml(templates));
        }

        function persistAndRefresh() {
          persist(templates.slice(), function () {
            refresh();
          });
        }

        $body.on('click', '.yp-tt-list__row-delete', function (event) {
          event.stopPropagation();
          var index = parseInt($(this).closest('.yp-tt-list__row').attr('data-index'), 10);
          templates.splice(index, 1);
          persistAndRefresh();
        });

        $body.on('click', '.yp-tt-list__row-name', function () {
          var index = parseInt($(this).closest('.yp-tt-list__row').attr('data-index'), 10);
          closeYpModal(modal);
          openFormModal(templates[index], function (updated) {
            if (updated) {
              templates[index] = updated;
              persist(templates.slice(), function () {
                openEditorModal(persist, templates);
              });
            } else {
              openEditorModal(persist, templates);
            }
          });
        });

        $body.find('.yp-tt-list__add').on('click', function () {
          closeYpModal(modal);
          openFormModal(null, function (created) {
            if (created) {
              templates.push(created);
              persist(templates.slice(), function () {
                openEditorModal(persist, templates);
              });
            } else {
              openEditorModal(persist, templates);
            }
          });
        });
      });
    }

    /* ------------------------ меню «...» в разделе Задачи ------------------------ */

    function safeArea() {
      try {
        return String((self.system() || {}).area || '');
      } catch (e) {
        return '';
      }
    }

    function isTodoArea() {
      var area = safeArea();
      if (area.indexOf('todo') === 0 || area.indexOf('tlist') === 0) {
        return true;
      }
      return window.location.pathname.indexOf('/todo') === 0;
    }

    var MENU_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1.5 3.5l1.5 1.5L5.5 2M1.5 12.2h3M8 4h6.5M8 8h6.5M8 12h6.5" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Добавляем пункт «Редактор шаблонов» в выпадающее меню «...»
    // в правом верхнем углу раздела Задачи (как у виджета-примера)
    function tryInjectTodoMenuItem() {
      if (!isTodoArea()) {
        return;
      }
      $('.button-input__context-menu').each(function () {
        var $menu = $(this);
        if ($menu.find('.yp-tt-menu-item').length) {
          return;
        }
        var $list = $menu.is('ul') ? $menu : $menu.find('ul').first();
        var $target = $list.length ? $list : $menu;
        var $item = $(
          '<li class="button-input__context-menu__item yp-tt-menu-item">' +
            '<div class="button-input__context-menu__item__inner">' +
              '<span class="button-input__context-menu__item__icon-container yp-tt-menu-item__icon">' + MENU_ICON_SVG + '</span>' +
              '<span class="button-input__context-menu__item__text"></span>' +
            '</div>' +
          '</li>'
        );
        $item.find('.button-input__context-menu__item__text').text(t('card.editor', 'Редактор шаблонов'));
        $item.on('click', function () {
          openEditorModal(persistWithToast);
        });
        $target.append($item);
      });
    }

    function setupTodoMenuObserver() {
      if (todoMenuObserver || !window.MutationObserver) {
        return;
      }
      injectStyles();
      todoMenuObserver = new window.MutationObserver(function () {
        tryInjectTodoMenuItem();
      });
      todoMenuObserver.observe(document.body, { childList: true, subtree: true });
      tryInjectTodoMenuItem();
    }

    /* ---------------------------- блок в карточке ---------------------------- */

    function renderCardWidget() {
      injectStyles();
      var html = '<div class="yp-tt">' +
        '<button type="button" class="yp-tt__open">' + escapeHtml(t('card.open', 'Поставить задачу по шаблону')) + '</button>' +
        '<span class="yp-tt__editor-open">' + escapeHtml(t('card.editor', 'Редактор шаблонов')) + '</span>' +
        '</div>';

      self.render_template({
        caption: { class_name: 'yp-tt-card' },
        body: html,
        render: ''
      });
    }

    /* ------------------------- редактор в настройках ------------------------- */

    // Тот же редактор в окне настроек виджета. Изменения сразу пишутся в
    // служебный список (persistWithToast), а скрытое JSON-поле настроек
    // синхронизируется как резервная копия — её амо сохранит по кнопке
    // «Сохранить» (используется для миграции и при недоступности списков).
    function renderSettingsEditor($modal_body) {
      injectStyles();
      loadTemplates(function (loaded) {
        buildSettingsEditor($modal_body, loaded);
      });
    }

    function buildSettingsEditor($modal_body, loadedTemplates) {
      var $field = $modal_body.find('input[name="templates"], textarea[name="templates"]').first();
      var templates = loadedTemplates.slice();

      var $editor = $(
        '<div class="yp-tt-settings">' +
          '<div class="yp-tt-settings__hint">' + escapeHtml(t('editor.hint', '')) + '</div>' +
          '<div class="yp-tt-list__items">' + editorListHtml(templates) + '</div>' +
          '<button type="button" class="yp-tt-list__add">' + escapeHtml(t('editor.new', '+ новый шаблон')) + '</button>' +
        '</div>'
      );

      if ($field.length) {
        var $fieldWrap = $field.closest('.widget_settings_block__item_field');
        ($fieldWrap.length ? $fieldWrap : $field).hide().before($editor);
      } else {
        $modal_body.append($editor);
      }

      // Записываем в служебный список и дублируем в поле настроек
      function sync() {
        if ($field.length) {
          $field.val(JSON.stringify(templates)).trigger('input').trigger('change');
        }
        persistWithToast(templates.slice(), function () {});
      }

      function refresh() {
        $editor.find('.yp-tt-list__items').html(editorListHtml(templates));
      }

      $editor.on('click', '.yp-tt-list__row-delete', function (event) {
        event.stopPropagation();
        var index = parseInt($(this).closest('.yp-tt-list__row').attr('data-index'), 10);
        templates.splice(index, 1);
        sync();
        refresh();
      });

      $editor.on('click', '.yp-tt-list__row-name', function () {
        var index = parseInt($(this).closest('.yp-tt-list__row').attr('data-index'), 10);
        openFormModal(templates[index], function (updated) {
          if (updated) {
            templates[index] = updated;
            sync();
            refresh();
          }
        });
      });

      $editor.find('.yp-tt-list__add').on('click', function () {
        openFormModal(null, function (created) {
          if (created) {
            templates.push(created);
            sync();
            refresh();
          }
        });
      });
    }

    /* --------------------------------- callbacks --------------------------------- */

    this.callbacks = {
      render: function () {
        var area = safeArea();
        var isCard = AREA_ENTITY.some(function (item) {
          return area.indexOf(item.prefix) === 0;
        });
        if (isCard) {
          renderCardWidget();
        }
        // Наблюдатель дешёвый и сам проверяет, что мы в разделе Задачи;
        // запускаем всегда — переходы в амо происходят без перезагрузки страницы
        setupTodoMenuObserver();
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        // Делегированные обработчики переживают перерисовки карточки,
        // неймспейс защищает от дублей при повторных вызовах bind_actions
        $(document)
          .off('click.ypTT')
          .on('click.ypTT', '.yp-tt__open', function () {
            openPickerModal();
          })
          .on('click.ypTT', '.yp-tt__editor-open', function () {
            openEditorModal(persistWithToast);
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
        $('.yp-tt-menu-item').remove();
        if (todoMenuObserver) {
          todoMenuObserver.disconnect();
          todoMenuObserver = null;
        }
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
