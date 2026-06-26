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
    const body = JSON.parse(call.data)[0];
    fakeCatalog = { id: ++nextId, fieldId: null, elements: [], canAddElements: body.can_add_elements !== false };
    return { ok: true, data: { _embedded: { catalogs: [{ id: fakeCatalog.id }] } } };
  }
  if (url === '/api/v4/catalogs' && method === 'PATCH') {
    const body = JSON.parse(call.data)[0];
    if (fakeCatalog && fakeCatalog.id === body.id && typeof body.can_add_elements === 'boolean') {
      fakeCatalog.canAddElements = body.can_add_elements;
    }
    return { ok: true, data: {} };
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
      if (fakeCatalog.canAddElements === false) {
        return { ok: false }; // амо запрещает добавление элементов в такой список
      }
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

let allWidgets = [];

function makeWidget(templates, area) {
  const widget = new CustomWidget();
  allWidgets.push(widget);
  widget.langs = ruLang;
  widget.get_settings = () => ({ templates: JSON.stringify(templates) });
  widget.system = () => ({ area: area || 'lcard-1' });
  widget.params = { widget_code: 'task_templates' };
  // эмулируем секцию правой панели amoCRM: плашка (caption) + тело.
  // amoCRM вешает на плашку класс из opts.caption.class_name — повторяем это.
  widget.render_template = (opts) => {
    $('#card-zone').remove();
    var capClass = (opts.caption && opts.caption.class_name) || '';
    $('<div id="card-zone"><div class="amo-caption ' + capClass + '">KO:AGENCY</div>' +
      '<div class="amo-body"></div></div>').appendTo(document.body);
    $('#card-zone .amo-body').html(opts.body);
  };
  return widget;
}

function resetEnv() {
  // уничтожаем ВСЕ созданные инстансы (снимаем observer'ы, capture-listener'ы
  // и интервалы), чтобы тесты не пересекались
  allWidgets.splice(0).forEach((w) => {
    try { w.callbacks.destroy(); } catch (e) { /* уже уничтожен */ }
  });
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
  assert($('#card-zone .yp-tt__banner').length === 1, 'баннер KO:AGENCY в теле блока присутствует');
  assert(/KO:AGENCY/.test($('#card-zone .yp-tt__banner').text()), 'баннер содержит KO:AGENCY');
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

/* 9в. Авторемонт списка, созданного с запретом на добавление элементов */
section('Ремонт списка с can_add_elements:false');
{
  resetEnv();
  // эмулируем список, созданный ранней версией виджета: писать в него нельзя
  fakeCatalog = { id: ++nextId, fieldId: ++nextId, elements: [], canAddElements: false };
  const widget = makeWidget([]);
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .yp-tt__editor-open').trigger('click');
  lastModal().$body.find('.yp-tt-list__add').trigger('click');
  const form = lastModal();
  form.$body.find('[name="tpl_name"]').val('После ремонта');
  form.$body.find('.yp-tt-form__save').trigger('click');
  assert(ajaxCalls.some((call) => call.url === '/api/v4/catalogs' && (call.method || '').toUpperCase() === 'PATCH'),
    'виджет починил список через PATCH (can_add_elements:true)');
  assert(fakeCatalog.canAddElements === true, 'флаг can_add_elements включён');
  const saved = savedCatalogTemplates();
  assert(saved && saved.length === 1 && saved[0].name === 'После ремонта',
    'после ремонта шаблон записан со второй попытки');
  assert($('.yp-tt-toast').length === 0, 'ошибка пользователю не показывалась — ремонт прозрачный');
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
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($menu.find('.yp-tt-menu-item').length === 1, 'пункт «Редактор шаблонов» добавлен в меню «...»');
  assert($menu.find('.yp-tt-menu-item .button-input__context-menu__item__text').text() === ruLang.card.editor,
    'текст пункта из локализации');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($menu.find('.yp-tt-menu-item').length === 1, 'пункт не дублируется при повторных мутациях DOM');
  $menu.find('.yp-tt-menu-item').trigger('click');
  const editor = lastModal();
  assert(editor && editor.$body.find('.yp-tt-list__add').length === 1, 'клик по пункту открывает редактор шаблонов');
  widget.callbacks.destroy();
  $menu.remove();

  /* 12. Пункт «Шаблоны задач» в переключателе Чат/E-mail/Примечание/Задача */
  section('Пункт в переключателе типа сообщения карточки');
  resetEnv();
  const cardWidget = makeWidget([TPL_TOMORROW], 'lcard-1');
  cardWidget.callbacks.render();
  cardWidget.callbacks.bind_actions();
  // эмулируем переключатель из нижней части карточки
  const $switcher = $(
    '<div class="feed-compose-switcher">' +
      '<div class="feed-compose-switcher__item" data-id="chat">Чат</div>' +
      '<div class="feed-compose-switcher__item" data-id="email">E-mail</div>' +
      '<div class="feed-compose-switcher__item" data-id="note">Примечание</div>' +
      '<div class="feed-compose-switcher__item" data-id="task"><span class="icon-check"></span>Задача</div>' +
    '</div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const $added = $switcher.find('.yp-tt-compose-item');
  assert($added.length === 1, 'пункт «Шаблоны задач» добавлен в переключатель');
  assert($added.text().trim() === ruLang.widget.name, 'текст пункта — название виджета');
  assert(!$added.attr('data-id'), 'data-атрибуты у клона удалены (амо не перехватит клик)');
  assert($added.find('.icon-check').length === 0, 'иконка-галочка активного пункта удалена');
  assert($added.index() === 4, 'пункт стоит после «Задачи»');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($switcher.find('.yp-tt-compose-item').length === 1, 'пункт не дублируется при повторных мутациях');
  $added.trigger('click');
  const picker = lastModal();
  assert(picker && picker.$body.find('.yp-tt-picker__card').length === 1,
    'клик по пункту открывает окно выбора шаблона');
  assert($switcher.is(':hidden'), 'переключатель скрывается после клика');
  cardWidget.callbacks.destroy();
  $switcher.remove();

  /* 13. Меню без «говорящих» классов (как на живом аккаунте) */
  section('Переключатель без CSS-классов switcher');
  resetEnv();
  const w13 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w13.callbacks.render();
  w13.callbacks.bind_actions();
  // вёрстка без классов вида switcher/compose — детект только по текстам
  const $menu13 = $(
    '<div class="tips"><ul>' +
      '<li>Чат</li>' +
      '<li>E-mail</li>' +
      '<li>Примечание</li>' +
      '<li><span class="icon"></span>Задача</li>' +
    '</ul></div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const $added13 = $menu13.find('.yp-tt-compose-item');
  assert($added13.length === 1, 'пункт добавлен в меню без «говорящих» классов');
  assert($added13.text().trim() === ruLang.widget.name, 'текст пункта — название виджета');
  assert($added13.prev().text().trim() === 'Задача', 'пункт стоит сразу после «Задачи»');
  $added13.trigger('click');
  assert(lastModal() && lastModal().$body.find('.yp-tt-picker__card').length === 1,
    'клик открывает окно выбора шаблона');
  w13.callbacks.destroy();
  $menu13.remove();

  /* 14. Триггер по клику: меню отрисовано заранее, без мутаций DOM */
  section('Инжект по клику в карточке');
  resetEnv();
  const w14 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w14.callbacks.render();
  w14.callbacks.bind_actions();
  // меню уже в DOM ДО запуска наблюдателя/инжекта
  const $menu14 = $(
    '<div class="dd"><div>Чат</div><div>E-mail</div><div>Примечание</div><div>Задача</div></div>'
  ).appendTo(document.body);
  // дать пройти первичному runInjections из bind_actions-наблюдателя
  await new Promise((resolve) => setTimeout(resolve, 250));
  // эмулируем, что меню «раскрылось» по клику пользователя
  $(document).trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($menu14.find('.yp-tt-compose-item').length === 1, 'клик по документу дотягивает инжект пункта');
  w14.callbacks.destroy();
  $menu14.remove();

  /* 15. Реальная вёрстка amoCRM (tips__inner / js-tip-items, скрытые пункты) */
  section('Реальная вёрстка переключателя amoCRM');
  resetEnv();
  const w15 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w15.callbacks.render();
  w15.callbacks.bind_actions();
  const $menu15 = $(
    '<div class="tips__inner custom-scroll js-tip-items">' +
      '<div class="tips-item js-tips-item js-switcher-chat tips-item_selected" data-id="chat">Чат</div>' +
      '<div class="tips-item js-tips-item js-switcher-email hidden" data-id="email">E-mail</div>' +
      '<div class="tips-item js-tips-item js-switcher-note" data-id="note">Примечание</div>' +
      '<div class="tips-item js-tips-item js-switcher-task" data-id="task">Задача</div>' +
      '<div class="tips-item js-tips-item js-switcher-appointment hidden" data-id="appointment">Запись</div>' +
      '<div class="tips-item js-tips-item js-switcher-sms hidden" data-id="sms">SMS</div>' +
    '</div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const $added15 = $menu15.find('.yp-tt-compose-item');
  assert($added15.length === 1, 'пункт вставлен в реальную вёрстку amoCRM');
  assert($added15.attr('data-id') === undefined, 'data-id у клона удалён');
  assert($added15.prev().hasClass('js-switcher-task'), 'пункт стоит сразу после «Задачи»');
  assert(!$added15.hasClass('tips-item_selected'), 'класс выбранного пункта снят с клона');
  assert($added15.text().trim() === ruLang.widget.name, 'текст пункта — название виджета');
  $added15.trigger('click');
  assert(lastModal() && lastModal().$body.find('.yp-tt-picker__card').length === 1,
    'клик по пункту открывает окно выбора шаблона');
  w15.callbacks.destroy();
  $menu15.remove();

  /* 16. Capture-клик переживает stopPropagation и восстанавливает пункт */
  section('Capture-клик при stopPropagation');
  resetEnv();
  const w16 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w16.callbacks.render();
  w16.callbacks.bind_actions();
  const $menu16 = $(
    '<div class="js-tip-items">' +
      '<div class="js-switcher-note">Примечание</div>' +
      '<div class="js-switcher-task">Задача</div>' +
    '</div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($menu16.find('.yp-tt-compose-item').length === 1, 'пункт вставлен при появлении меню');
  // эмулируем перерисовку amoCRM: наш пункт стёрт, на меню висит bubble-stopPropagation
  $menu16.find('.yp-tt-compose-item').remove();
  $menu16.get(0).addEventListener('click', function (e) { e.stopPropagation(); }, false);
  // нативный клик в фазе перехвата (jQuery.trigger не доходит до capture)
  $menu16.get(0).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert($menu16.find('.yp-tt-compose-item').length === 1,
    'capture-клик восстановил пункт несмотря на stopPropagation');
  w16.callbacks.destroy();
  $menu16.remove();

  /* 17. Закрытие модального окна по Esc */
  section('Закрытие модалки по Esc');
  resetEnv();
  const w17 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w17.callbacks.render();
  w17.callbacks.bind_actions();
  $('#card-zone .yp-tt__open').trigger('click');
  const m17 = lastModal();
  assert(m17 && !m17.destroyed, 'окно выбора открыто');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(m17.destroyed, 'окно закрылось по Esc');
  w17.callbacks.destroy();

  /* 18. Периодический ре-инжект восстанавливает пункт после перерисовки amoCRM */
  section('Ре-инжект после перерисовки переключателя');
  resetEnv();
  const w18 = makeWidget([TPL_TOMORROW], 'lcard-1');
  w18.callbacks.render();
  w18.callbacks.bind_actions();
  const $menu18 = $(
    '<div class="js-tip-items">' +
      '<div class="js-switcher-note">Примечание</div>' +
      '<div class="js-switcher-task">Задача</div>' +
    '</div>'
  ).appendTo(document.body);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert($menu18.find('.yp-tt-compose-item').length === 1, 'пункт вставлен при появлении меню');
  // эмулируем перерисовку amoCRM БЕЗ каких-либо событий: просто стираем пункт.
  // observer/click не сработают — восстановить должен только интервал.
  $menu18.find('.yp-tt-compose-item').remove();
  assert($menu18.find('.yp-tt-compose-item').length === 0, 'пункт убран (эмуляция wipe)');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert($menu18.find('.yp-tt-compose-item').length === 1,
    'периодический ре-инжект восстановил пункт без событий');
  w18.callbacks.destroy();
  // после destroy таймер снят — повторного восстановления нет
  $menu18.find('.yp-tt-compose-item').remove();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert($menu18.find('.yp-tt-compose-item').length === 0,
    'после destroy интервал остановлен — пункт не возвращается');
  $menu18.remove();

  console.log('\nИтого: ' + passed + ' проверок пройдено, ' + failures + ' провалено');
  process.exit(failures ? 1 : 0);
})();
