/**
 * Локальный тестовый стенд для widget/script.js.
 *
 * Эмулирует окружение amoCRM: jsdom + jQuery, заглушки Modal и глобального
 * AMOCRM, перехват $.ajax. Прогоняет основные сценарии: рендер блока в
 * карточке, постановка задачи из окна выбора шаблона (пресеты срока,
 * ручная дата, резолв ответственного), редактор шаблонов с сохранением
 * через API, редактор в настройках с синхронизацией JSON-поля,
 * совместимость со старым форматом срока и покрытие ключей локализации.
 *
 * Запуск: node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://test.amocrm.ru/leads/detail/123'
});
global.window = dom.window;
global.document = dom.window.document;

const jqueryModule = require('jquery');
const $ = jqueryModule.fn ? jqueryModule : jqueryModule(dom.window);

/* ----------------------------- заглушки amoCRM ----------------------------- */

global.AMOCRM = {
  constant(key) {
    if (key === 'user') {
      return { id: 101, name: 'Viktor Borisenko' };
    }
    if (key === 'account') {
      return {
        task_types: [
          { id: 1, option: 'Связаться с клиентом' },
          { id: 2, option: 'Встреча' }
        ]
      };
    }
    if (key === 'managers') {
      return {
        101: { id: 101, title: 'Viktor Borisenko', active: true },
        202: { id: 202, title: 'Алексей Савченко', active: true },
        303: { id: 303, title: 'Уволенный Сотрудник', active: false }
      };
    }
    return {};
  },
  data: { current_card: { id: 123 } }
};

const modals = [];
class ModalStub {
  constructor(opts) {
    this.destroyed = false;
    this.$body = $('<div class="modal-stub"></div>').appendTo(document.body);
    modals.push(this);
    opts.init.call(this, this.$body);
  }
  destroy() {
    this.destroyed = true;
    this.$body.remove();
  }
}
function lastModal() {
  for (let i = modals.length - 1; i >= 0; i--) {
    if (!modals[i].destroyed) {
      return modals[i];
    }
  }
  return null;
}

let ajaxCalls = [];
let ajaxOverrides = []; // [{match(call), respond(call)}] — одноразовые перехваты
let fakeCatalog = null; // эмуляция служебного списка: {id, fieldId, elements:[{id, value}]}
let nextId = 1000;

const STORAGE_NAME = 'Шаблоны задач (данные виджета)';

function routerHandler(call) {
  const method = (call.method || 'GET').toUpperCase();
  const url = call.url;
  if (url.startsWith('/api/v4/catalogs?') && method === 'GET') {
    return {
      ok: true,
      data: { _embedded: { catalogs: fakeCatalog ? [{ id: fakeCatalog.id, name: STORAGE_NAME }] : [] } }
    };
  }
  if (url === '/api/v4/catalogs' && method === 'POST') {
    fakeCatalog = { id: ++nextId, fieldId: null, elements: [] };
    return { ok: true, data: { _embedded: { catalogs: [{ id: fakeCatalog.id }] } } };
  }
  if (fakeCatalog && url === '/api/v4/catalogs/' + fakeCatalog.id + '/custom_fields') {
    if (method === 'GET') {
      return {
        ok: true,
        data: {
          _embedded: {
            custom_fields: fakeCatalog.fieldId
              ? [{ id: fakeCatalog.fieldId, name: 'Данные', type: 'textarea' }]
              : []
          }
        }
      };
    }
    if (method === 'POST') {
      fakeCatalog.fieldId = ++nextId;
      return { ok: true, data: { _embedded: { custom_fields: [{ id: fakeCatalog.fieldId }] } } };
    }
  }
  if (fakeCatalog && url.startsWith('/api/v4/catalogs/' + fakeCatalog.id + '/elements')) {
    if (method === 'GET') {
      return {
        ok: true,
        data: {
          _embedded: {
            elements: fakeCatalog.elements.map((el) => ({
              id: el.id,
              name: 'config',
              custom_fields_values: [{ field_id: fakeCatalog.fieldId, values: [{ value: el.value }] }]
            }))
          }
        }
      };
    }
    if (method === 'POST') {
      const body = JSON.parse(call.data)[0];
      const el = { id: ++nextId, value: body.custom_fields_values[0].values[0].value };
      fakeCatalog.elements.push(el);
      return { ok: true, data: { _embedded: { elements: [{ id: el.id }] } } };
    }
    if (method === 'PATCH') {
      const body = JSON.parse(call.data)[0];
      const el = fakeCatalog.elements.find((item) => item.id === body.id);
      if (el) {
        el.value = body.custom_fields_values[0].values[0].value;
      }
      return { ok: true, data: {} };
    }
  }
  return { ok: true, data: {} };
}

function savedCatalogTemplates() {
  if (!fakeCatalog || !fakeCatalog.elements.length) {
    return null;
  }
  return JSON.parse(fakeCatalog.elements[0].value);
}

$.ajax = function (opts) {
  ajaxCalls.push(opts);
  let result = null;
  for (let i = 0; i < ajaxOverrides.length; i++) {
    if (ajaxOverrides[i].match(opts)) {
      result = ajaxOverrides[i].respond(opts);
      ajaxOverrides.splice(i, 1);
      break;
    }
  }
  if (!result) {
    result = routerHandler(opts);
  }
  return {
    done(cb) {
      if (result.ok) cb(result.data);
      return this;
    },
    fail(cb) {
      if (!result.ok) cb();
      return this;
    }
  };
};

/* ------------------------------ загрузка виджета ------------------------------ */

let CustomWidget = null;
global.define = function (deps, factory) {
  CustomWidget = factory($, ModalStub);
};
require(path.join(__dirname, '..', 'widget', 'script.js'));

const ruLang = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget', 'i18n', 'ru.json'), 'utf8'));
const enLang = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget', 'i18n', 'en.json'), 'utf8'));

function makeWidget(templates, area) {
  const widget = new CustomWidget();
  widget.langs = ruLang;
  widget.get_settings = () => ({ templates: JSON.stringify(templates) });
  widget.system = () => ({ area: area || 'lcard-1' });
  widget.params = { widget_code: 'task_templates' };
  widget.render_template = (opts) => {
    $('#card-zone').remove();
    $('<div id="card-zone"></div>').html(opts.body).appendTo(document.body);
  };
  return widget;
}

function resetEnv() {
  ajaxCalls = [];
  ajaxOverrides = [];
  fakeCatalog = null;
  modals.splice(0).forEach((modal) => modal.destroyed || modal.$body.remove());
  $('.yp-tt-toast').remove();
  $('#card-zone').remove();
  $(document).off('.ypTT');
}

/* --------------------------------- проверки --------------------------------- */

let failures = 0;
let passed = 0;
function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failures++;
    console.error('  FAIL: ' + message);
  }
}
function section(name) {
  console.log('\n== ' + name);
}

const TPL_TOMORROW = {
  id: 'tpl_1', name: 'Demo 1', text: 'Встреча завтра',
  task_type_id: 2, deadline: 'tomorrow', manualDate: false, responsible: 'current'
};
const TPL_ENTITY = {
  id: 'tpl_2', name: 'Demo 2', text: 'Получить оплату от клиента',
  task_type_id: 1, deadline: 'days2', manualDate: false, responsible: 'entity'
};
const TPL_MANUAL = {
  id: 'tpl_3', name: 'Demo 3', text: 'Ручная дата',
  task_type_id: 1, deadline: 'now', manualDate: true, responsible: '202'
};
const TPL_LEGACY = {
  id: 'tpl_4', name: 'Legacy', text: 'Старый формат',
  task_type_id: 1, deadline: { amount: 2, unit: 'hours', endOfDay: false }, responsible: 'current'
};

/* 1. Рендер блока в карточке */
section('Рендер блока в карточке');
{
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW]);
  widget.callbacks.render();
  assert($('#card-zone .yp-tt__open').length === 1, 'есть кнопка «Поставить задачу по шаблону»');
  assert($('#card-zone .yp-tt__editor-open').length === 1, 'есть ссылка «Редактор шаблонов»');
  assert($('#card-zone .yp-tt__open').text() === ruLang.card.open, 'текст кнопки из локализации');
}

/* 2. Окно выбора шаблона и постановка задачи по пресету */
section('Постановка задачи: пресет «завтра»');
{
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW, TPL_ENTITY]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');

  const picker = lastModal();
  assert(!!picker, 'окно выбора шаблона открылось');
  assert(picker.$body.find('.yp-tt-picker__card').length === 2, 'в окне две карточки шаблонов');
  const firstCard = picker.$body.find('.yp-tt-picker__card').first();
  assert(firstCard.find('.yp-tt-picker__card-name').text() === 'Demo 1', 'название шаблона на карточке');
  const deadlineLine = firstCard.find('.yp-tt-picker__card-line').first().text();
  assert(/^До \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} для Viktor Borisenko$/.test(deadlineLine),
    'строка срока в формате «До dd.mm.yyyy hh:mm для {имя}», получено: ' + deadlineLine);
  assert(firstCard.find('.yp-tt-picker__card-line').last().text() === 'Встреча — Встреча завтра',
    'строка «{тип} — {комментарий}»');

  const before = Math.floor(Date.now() / 1000);
  firstCard.trigger('click');
  const post = ajaxCalls.find((call) => call.url === '/api/v4/tasks');
  assert(!!post, 'выполнен POST /api/v4/tasks');
  const payload = JSON.parse(post.data)[0];
  assert(payload.entity_type === 'leads' && payload.entity_id === 123, 'entity_type/entity_id из карточки сделки');
  assert(payload.text === 'Встреча завтра', 'текст задачи из комментария шаблона');
  assert(payload.task_type_id === 2, 'тип задачи из шаблона');
  assert(payload.responsible_user_id === 101, 'ответственный — текущий пользователь');
  const expected = before + 86400;
  assert(Math.abs(payload.complete_till - expected) <= 2,
    'complete_till ≈ сейчас + 24 часа (' + payload.complete_till + ' vs ' + expected + ')');
  assert(picker.destroyed, 'окно выбора закрылось после успешной постановки');
}

/* 3. Ответственный за карточку */
section('Постановка задачи: ответственный за карточку');
{
  resetEnv();
  const widget = makeWidget([TPL_ENTITY]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  ajaxOverrides.push({
    match: (call) => call.url === '/api/v4/leads/123',
    respond: (call) => {
      assert(call.method === 'GET', 'GET карточки за ответственным');
      return { ok: true, data: { responsible_user_id: 777 } };
    }
  });
  $('#card-zone .yp-tt__open').trigger('click');
  lastModal().$body.find('.yp-tt-picker__card').trigger('click');
  const post = ajaxCalls.find((call) => call.url === '/api/v4/tasks');
  assert(!!post, 'выполнен POST /api/v4/tasks');
  assert(JSON.parse(post.data)[0].responsible_user_id === 777, 'ответственный взят из карточки (777)');
}

/* 4. Ручная дата */
section('Постановка задачи: выбор даты вручную');
{
  resetEnv();
  const widget = makeWidget([TPL_MANUAL]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const picker = lastModal();
  const card = picker.$body.find('.yp-tt-picker__card');
  assert(card.find('.yp-tt-picker__card-line').first().text().indexOf(ruLang.picker.manual_date) === 0,
    'на карточке отметка «Дата выбирается вручную»');
  card.trigger('click');
  assert(ajaxCalls.filter((call) => call.url === '/api/v4/tasks').length === 0,
    'задача не создаётся сразу — ждём дату');
  const manual = card.find('.yp-tt-picker__manual');
  assert(manual.length === 1, 'появилось поле выбора даты');
  manual.find('input').val('2026-06-20T15:30');
  manual.find('button').trigger('click');
  const post = ajaxCalls.find((call) => call.url === '/api/v4/tasks');
  assert(!!post, 'после выбора даты выполнен POST /api/v4/tasks');
  const payload = JSON.parse(post.data)[0];
  assert(payload.complete_till === Math.floor(new Date('2026-06-20T15:30').getTime() / 1000),
    'complete_till равен выбранной дате');
  assert(payload.responsible_user_id === 202, 'ответственный — выбранный сотрудник (202)');
}

/* 5. Совместимость со старым форматом срока */
section('Совместимость со старым форматом deadline');
{
  resetEnv();
  const widget = makeWidget([TPL_LEGACY]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const before = Math.floor(Date.now() / 1000);
  lastModal().$body.find('.yp-tt-picker__card').trigger('click');
  const post = ajaxCalls.find((call) => call.url === '/api/v4/tasks');
  assert(!!post, 'задача из legacy-шаблона создана');
  assert(Math.abs(JSON.parse(post.data)[0].complete_till - (before + 7200)) <= 2,
    'complete_till ≈ сейчас + 2 часа (legacy {amount:2, unit:hours})');
}

/* 6. Редактор шаблонов: удаление и добавление с сохранением через API */
section('Редактор шаблонов (модальное окно)');
{
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW, TPL_ENTITY]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__editor-open').trigger('click');
  const editor = lastModal();
  assert(editor.$body.find('.yp-tt-list__row').length === 2, 'в редакторе две строки шаблонов');
  assert(editor.$body.find('.yp-tt-list__add').length === 1, 'есть кнопка «+ новый шаблон»');

  // удаление: при первом сохранении виджет сам создаёт служебный список
  editor.$body.find('.yp-tt-list__row').first().find('.yp-tt-list__row-delete').trigger('click');
  assert(!!fakeCatalog, 'служебный список создан при первом сохранении');
  assert(!!fakeCatalog.fieldId, 'в списке создано текстовое поле');
  let savedTemplates = savedCatalogTemplates();
  assert(savedTemplates && savedTemplates.length === 1 && savedTemplates[0].id === 'tpl_2',
    'после удаления в хранилище остался только второй шаблон');
  assert(editor.$body.find('.yp-tt-list__row').length === 1, 'список в редакторе обновился');

  // добавление
  ajaxCalls = [];
  editor.$body.find('.yp-tt-list__add').trigger('click');
  assert(editor.destroyed, 'редактор закрылся перед открытием формы');
  const form = lastModal();
  assert(form.$body.find('[name="tpl_name"]').length === 1, 'открылась форма «Создать шаблон»');
  assert(form.$body.find('[name="tpl_deadline"] option').length === 9, 'в селекте срока 9 пресетов');
  assert(form.$body.find('[name="tpl_responsible"] option[value="303"]').length === 0,
    'неактивный сотрудник не предлагается в ответственных');

  form.$body.find('[name="tpl_name"]').val('Перезвонить');
  form.$body.find('[name="tpl_text"]').val('Перезвонить клиенту');
  form.$body.find('[name="tpl_deadline"]').val('hour1');
  form.$body.find('[name="tpl_type"]').val('1');
  form.$body.find('[name="tpl_responsible"]').val('202');
  form.$body.find('.yp-tt-form__save').trigger('click');

  savedTemplates = savedCatalogTemplates();
  assert(savedTemplates && savedTemplates.length === 2, 'в хранилище два шаблона (обновление элемента списка)');
  assert(fakeCatalog.elements.length === 1, 'элемент списка один — обновляется, а не плодится');
  const created = savedTemplates[1];
  assert(created.name === 'Перезвонить' && created.deadline === 'hour1' &&
    created.responsible === '202' && created.task_type_id === 1 && !created.manualDate,
    'новый шаблон сохранён с введёнными полями');
  const reopened = lastModal();
  assert(reopened && reopened.$body.find('.yp-tt-list__row').length === 2,
    'редактор переоткрылся с обновлённым списком');

  // кэш: после сохранения через API картина в окне выбора актуальна без перезагрузки
  resetCacheCheck(widget, created.id);
}
function resetCacheCheck(widget, createdId) {
  $('.modal-stub').remove();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const picker = lastModal();
  assert(picker.$body.find('.yp-tt-picker__card[data-tpl-id="' + createdId + '"]').length === 1,
    'кэш: новый шаблон сразу виден в окне выбора');
}

/* 6б. Ошибка сохранения: введённое не теряется */
section('Редактор: ошибка сохранения через API');
{
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__editor-open').trigger('click');
  lastModal().$body.find('.yp-tt-list__add').trigger('click');
  const form = lastModal();
  form.$body.find('[name="tpl_name"]').val('Несохранённый');
  // создание служебного списка падает (например, нет прав на списки)
  ajaxOverrides.push({
    match: (call) => call.url === '/api/v4/catalogs' && (call.method || '').toUpperCase() === 'POST',
    respond: () => ({ ok: false })
  });
  form.$body.find('.yp-tt-form__save').trigger('click');
  const reopened = lastModal();
  assert(reopened.$body.find('.yp-tt-list__row').length === 2,
    'после ошибки редактор переоткрылся и введённый шаблон остался в списке');
  assert($('.yp-tt-toast').text().indexOf('Не удалось сохранить') === 0,
    'показан тост об ошибке сохранения');
  reopened.$body.remove();
  // кэш не обновился: в окне выбора по-прежнему один шаблон
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  assert(lastModal().$body.find('.yp-tt-picker__card').length === 1,
    'кэш не обновлён — в окне выбора только сохранённый шаблон');
  $('.yp-tt-toast').remove();
}

/* 7. Валидация формы */
section('Валидация формы шаблона');
{
  resetEnv();
  const widget = makeWidget([]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__editor-open').trigger('click');
  lastModal().$body.find('.yp-tt-list__add').trigger('click');
  const form = lastModal();
  form.$body.find('.yp-tt-form__save').trigger('click');
  assert(!form.destroyed, 'форма не закрывается без названия');
  assert(ajaxCalls.filter((call) => call.url === '/api/v4/widgets/task_templates').length === 0,
    'сохранение не вызывается без названия');
}

/* 8. Редактор в настройках виджета: синхронизация JSON-поля */
section('Редактор в настройках виджета');
{
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW]);
  const $modalBody = $('<div><input type="text" name="templates" value=""></div>').appendTo(document.body);
  $modalBody.find('input').val(JSON.stringify([TPL_TOMORROW]));
  widget.callbacks.settings($modalBody);
  assert($modalBody.find('.yp-tt-settings .yp-tt-list__row').length === 1, 'в настройках одна строка шаблона');

  $modalBody.find('.yp-tt-list__add').trigger('click');
  const form = lastModal();
  form.$body.find('[name="tpl_name"]').val('Из настроек');
  form.$body.find('[name="tpl_manual"]').prop('checked', true);
  form.$body.find('.yp-tt-form__save').trigger('click');

  const fieldValue = JSON.parse($modalBody.find('input[name="templates"]').val());
  assert(fieldValue.length === 2 && fieldValue[1].name === 'Из настроек' && fieldValue[1].manualDate === true,
    'JSON-поле настроек синхронизировано как резервная копия');
  const stored = savedCatalogTemplates();
  assert(stored && stored.length === 2 && stored[1].name === 'Из настроек',
    'изменения из настроек записаны и в служебный список');
  $modalBody.remove();
}

/* 9. Пустой список шаблонов */
section('Пустой список шаблонов');
{
  resetEnv();
  const widget = makeWidget([]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const picker = lastModal();
  assert(picker.$body.find('.yp-tt-picker__empty').length === 1, 'в окне выбора подсказка о пустом списке');
  assert(picker.$body.find('.yp-tt-picker__editor-link').length === 1, 'есть ссылка на редактор шаблонов');
}

/* 9б. Шаблоны переживают «перезагрузку страницы» */
section('Чтение из служебного списка после перезагрузки');
{
  resetEnv();
  // первый «сеанс»: создаём и сохраняем шаблон
  const widget1 = makeWidget([]);
  widget1.callbacks.render();
  widget1.callbacks.bind_actions();
  $('#card-zone .yp-tt__editor-open').trigger('click');
  lastModal().$body.find('.yp-tt-list__add').trigger('click');
  const form = lastModal();
  form.$body.find('[name="tpl_name"]').val('Постоянный');
  form.$body.find('.yp-tt-form__save').trigger('click');
  assert(savedCatalogTemplates() !== null, 'шаблон записан в служебный список');

  // второй «сеанс»: новый инстанс виджета с пустыми настройками и пустым кэшем
  $('.modal-stub').remove();
  const widget2 = makeWidget([]);
  widget2.callbacks.render();
  widget2.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const picker = lastModal();
  assert(picker.$body.find('.yp-tt-picker__card').length === 1 &&
    picker.$body.find('.yp-tt-picker__card-name').text() === 'Постоянный',
    'после «перезагрузки» шаблоны прочитаны из служебного списка');
}

/* 10. Покрытие ключей локализации */
section('Покрытие ключей локализации (ru/en)');
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'widget', 'script.js'), 'utf8');
  const keys = new Set();
  const re = /\bt\('([^']+)'/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  // динамические ключи: deadlines.{preset}
  ['now', 'min15', 'min30', 'hour1', 'today_end', 'tomorrow', 'days2', 'days3', 'week'].forEach((preset) => {
    keys.add('deadlines.' + preset);
  });
  keys.forEach((key) => {
    if (key.indexOf('deadlines.') === 0 && key.split('.').length === 2 && !/^deadlines\.(now|min15|min30|hour1|today_end|tomorrow|days2|days3|week)$/.test(key)) {
      return; // шаблонный ключ вида deadlines.' + ...
    }
    [['ru', ruLang], ['en', enLang]].forEach(([locale, lang]) => {
      let node = lang;
      const ok = key.split('.').every((part) => {
        if (node && typeof node === 'object' && part in node) {
          node = node[part];
          return true;
        }
        return false;
      });
      assert(ok && typeof node === 'string', 'ключ «' + key + '» есть в ' + locale + '.json');
    });
  });
}

/* 11. Пункт меню «Редактор шаблонов» в разделе Задачи */
(async () => {
  section('Пункт меню в разделе Задачи');
  resetEnv();
  const widget = makeWidget([TPL_TOMORROW], 'todo');
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  // эмулируем выпадающее меню «...» из интерфейса амо
  const $menu = $(
    '<div class="button-input__context-menu"><ul>' +
      '<li class="button-input__context-menu__item">' +
        '<div class="button-input__context-menu__item__inner">' +
          '<span class="button-input__context-menu__item__text">Экспорт</span>' +
        '</div>' +
      '</li>' +
    '</ul></div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert($menu.find('.yp-tt-menu-item').length === 1, 'пункт «Редактор шаблонов» добавлен в меню «...»');
  assert($menu.find('.yp-tt-menu-item .button-input__context-menu__item__text').text() === ruLang.card.editor,
    'текст пункта из локализации');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert($menu.find('.yp-tt-menu-item').length === 1, 'пункт не дублируется при повторных мутациях DOM');
  $menu.find('.yp-tt-menu-item').trigger('click');
  const editor = lastModal();
  assert(editor && editor.$body.find('.yp-tt-list__add').length === 1, 'клик по пункту открывает редактор шаблонов');
  widget.callbacks.destroy();

  console.log('\nИтого: ' + passed + ' проверок пройдено, ' + failures + ' провалено');
  process.exit(failures ? 1 : 0);
})();
