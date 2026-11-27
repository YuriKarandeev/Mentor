/**
 * Проверки календаря: даты/время, действия помощника и промпт
 * (src/lib/utils/planner.ts, api/planner-actions.ts, api/planner-tools.ts, api/prompts.ts).
 *
 * Чистые функции: без браузера, Dexie, сети и ключа API.
 * Запуск: npm run test:planner
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let total = 0;
const failures = [];
const check = (ok, message) => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

const load = (file) => import(pathToFileURL(path.resolve(file)).href);

const planner = await load('src/lib/utils/planner.ts');
const actions = await load('src/lib/api/planner-actions.ts');
const tools = await load('src/lib/api/planner-tools.ts');
const prompts = await load('src/lib/api/prompts.ts');

const {
  addDaysIso,
  compareEvents,
  eventTimeLabel,
  eventsByDay,
  formatDateHuman,
  isWithinDays,
  localDate,
  validDate,
  validTime
} = planner;

/* ---------- даты и время ---------- */

check(validDate('2026-11-27') === '2026-11-27', 'validDate принимает настоящую дату');
check(validDate('2026-02-30') === '', 'validDate не превращает 30 февраля в 2 марта');
check(validDate('2026-13-01') === '', 'validDate отвергает несуществующий месяц');
check(validDate('27.11.2026') === '', 'validDate не принимает русский формат');
check(validDate('') === '' && validDate(null) === '', 'validDate терпит пустые значения');

check(validTime('9:5') === '09:05', 'validTime дополняет «9:5» до «09:05»');
check(validTime('15:00:00') === '15:00', 'validTime отбрасывает секунды');
check(validTime('24:00') === '', 'validTime отвергает 24:00');
check(validTime('12:60') === '', 'validTime отвергает 60 минут');
check(validTime('') === '', 'validTime пустой строки — пустая строка');

check(addDaysIso('2026-11-30', 1) === '2026-12-01', 'addDaysIso переходит через границу месяца');
check(addDaysIso('2026-12-31', 1) === '2027-01-01', 'addDaysIso переходит через границу года');
check(addDaysIso('', 1) === '', 'addDaysIso не выдумывает дату из пустой строки');

const now = new Date(2026, 10, 27, 9, 15);
check(localDate(now) === '2026-11-27', 'localDate берёт локальный день, а не UTC');
check(formatDateHuman('2026-11-27', now) === 'Сегодня', 'formatDateHuman: сегодня');
check(formatDateHuman('2026-11-28', now) === 'Завтра', 'formatDateHuman: завтра');
check(formatDateHuman('2026-11-26', now) === 'Вчера', 'formatDateHuman: вчера');
check(formatDateHuman('2026-12-01', now) === 'вт, 1 декабря', 'formatDateHuman: далёкая дата с днём недели');
check(formatDateHuman('2026-02-30', now) === '', 'formatDateHuman не подписывает несуществующий день');

check(isWithinDays('2026-11-27', 14, now), 'isWithinDays включает сегодня');
check(isWithinDays('2026-12-11', 14, now), 'isWithinDays включает последний день окна');
check(!isWithinDays('2026-12-12', 14, now), 'isWithinDays отсекает день за окном');
check(!isWithinDays('2026-11-26', 14, now), 'isWithinDays отсекает вчера');

/* ---------- сортировка и группировка ---------- */

const ev = (id, title, date, time = '', allDay = false, endTime = '') => ({
  id,
  title,
  date,
  time,
  endTime,
  allDay,
  notes: '',
  createdAt: 1,
  updatedAt: 1,
  dirty: 1
});

check(eventTimeLabel(ev('a', 'x', '2026-11-27')) === 'весь день', 'eventTimeLabel: без времени — весь день');
check(eventTimeLabel(ev('a', 'x', '2026-11-27', '10:00', false, '11:30')) === '10:00–11:30', 'eventTimeLabel: интервал');
check(eventTimeLabel(ev('a', 'x', '2026-11-27', '10:00', false, '09:00')) === '10:00', 'eventTimeLabel: конец раньше начала не показывается');

const unordered = [
  ev('c', 'Вечер', '2026-11-28', '18:00'),
  ev('a', 'Утро', '2026-11-27', '09:00'),
  ev('b', 'Весь день', '2026-11-27', '', true)
];
check(compareEvents(unordered[1], unordered[0]) < 0, 'compareEvents: ранняя дата идёт первой');
check(compareEvents(unordered[2], unordered[1]) < 0, 'compareEvents: «весь день» идёт перед временем');

const groups = eventsByDay(unordered);
check(groups.length === 2, 'eventsByDay собирает два дня');
check(groups[0].date === '2026-11-27' && groups[0].items.length === 2, 'в первом дне два события');
check(groups[0].items[0].id === 'b', 'событие «весь день» стоит первым');
check(groups[1].items[0].id === 'c', 'следующий день на своём месте');

/* ---------- разбор действий ---------- */

const { applyPlannerActions, describeEventActions, normalizeEventAction } = actions;

const createdAction = normalizeEventAction({
  type: 'event.create',
  title: '  Созвон  ',
  date: '2026-11-27',
  time: ''
});
check(createdAction && createdAction.title === 'Созвон', 'название очищается от лишних пробелов');
check(createdAction && createdAction.allDay === true && createdAction.time === '', 'без времени событие становится «на весь день»');
check(normalizeEventAction({ type: 'event.create', title: 'Без даты' }) === null, 'событие без даты не создаётся');
check(normalizeEventAction({ type: 'event.create', title: '   ', date: '2026-11-27' }) === null, 'событие без названия не создаётся');
check(normalizeEventAction({ type: 'event.create', title: 'x', date: '2026-02-30' }) === null, 'событие с 30 февраля не создаётся');

const withEnd = normalizeEventAction({
  type: 'event.create',
  title: 'Встреча',
  date: '2026-11-27',
  time: '15:00',
  endTime: '14:00'
});
check(withEnd && withEnd.endTime === '', 'окончание раньше начала отбрасывается');
check(normalizeEventAction({ type: 'event.update', id: 'e1' }) === null, 'пустая правка не применяется');
check(normalizeEventAction({ type: 'event.update', id: 'e1', date: '2026-02-30' }) === null, 'битая дата в правке отбрасывается');
check(normalizeEventAction({ type: 'event.delete' }) === null, 'удаление без id отбрасывается');
check(normalizeEventAction({ type: 'project.create', title: 'x' }) === null, 'действия других сущностей не поддерживаются');

/* ---------- применение к списку ---------- */

const base = [ev('e1', 'Старое', '2026-11-27', '10:00'), ev('e2', 'Удалить', '2026-11-28', '12:00')];
let seq = 0;
const result = applyPlannerActions(
  [
    { type: 'event.create', title: 'Новое', date: '2026-11-29', time: '18:30' },
    { type: 'event.update', id: 'e1', time: '11:00' },
    { type: 'event.delete', id: 'e2' },
    { type: 'event.delete', id: 'e404' },
    { type: 'event.create', title: 'Мусор' }
  ],
  base,
  { now: 1000, newId: () => `new_${++seq}` }
);

check(result.changes.put.length === 2, 'create и update попадают в put');
check(result.changes.remove.length === 1 && result.changes.remove[0] === 'e2', 'delete попадает в remove');
check(result.applied.length === 3, 'применено три действия');
check(result.skipped.length === 2, 'два действия пропущены с причинами');

const madeRow = result.changes.put.find((row) => row.id === 'new_1');
check(
  Boolean(madeRow && madeRow.date === '2026-11-29' && madeRow.time === '18:30' && madeRow.dirty === 1),
  'новое событие получает id, время и dirty'
);
check(Boolean(madeRow && madeRow.createdAt === 1000 && madeRow.updatedAt === 1000), 'метки времени берутся из now');

const editedRow = result.changes.put.find((row) => row.id === 'e1');
check(Boolean(editedRow && editedRow.time === '11:00' && editedRow.title === 'Старое'), 'правка меняет только переданное поле');
check(Boolean(editedRow && editedRow.updatedAt === 1000 && editedRow.createdAt === 1), 'у правки обновляется только updatedAt');

check(result.undo.remove.length === 1 && result.undo.remove[0] === 'new_1', 'отмена удаляет созданные события');
check(result.undo.put.some((row) => row.id === 'e1' && row.time === '10:00'), 'отмена возвращает прежнюю версию правки');
check(result.undo.put.some((row) => row.id === 'e2'), 'отмена возвращает удалённое событие');
check(
  Array.isArray(result.undo.restore) && result.undo.restore.includes('e2'),
  'отмена снимает надгробие удалённого события'
);
check(base[0].time === '10:00' && base.length === 2, 'исходный массив не меняется');

const many = Array.from({ length: 10 }, (_, i) => ({
  type: 'event.create',
  title: `Событие ${i}`,
  date: '2026-11-29'
}));
const limited = applyPlannerActions(many, [], { now: 5, newId: () => `x${++seq}` });
check(limited.applied.length === 8, 'за ответ применяется не больше 8 действий');
check(
  limited.skipped.some((reason) => reason.includes('Слишком много действий')),
  'лишние действия объяснены'
);

const labels = describeEventActions(
  [
    { type: 'event.create', title: 'Созвон', date: '2026-11-27', time: '10:00' },
    { type: 'event.delete', id: 'e1' },
    { type: 'nonsense' }
  ],
  base
);
check(labels[0] === 'Добавить событие «Созвон» на 27.11.2026 в 10:00', 'подпись создания содержит дату и время');
check(labels[1] === 'Удалить событие «Старое»', 'подпись удаления берёт название из списка');
check(labels[2].includes('пропущено'), 'мусор подписывается как пропущенный');

/* ---------- импорт из «Ассистента» ---------- */

const backup = await load('src/lib/utils/assistant-backup.ts');

const exported = backup.parseAssistantBackup({
  app: 'planer',
  schema: 3,
  state: {
    events: [
      { id: 'a1', title: 'Занятие', date: '2026-11-27', time: '18:00', endTime: '19:00', notes: 'глава 3' },
      { id: 'a2', title: 'Весь день', date: '2026-11-28', time: '', allDay: true, createdAt: 700 },
      { id: 'a3', title: 'Без даты' },
      'мусор',
      { id: 'a4', title: '   ', date: '2026-11-29' }
    ]
  }
});
check(exported.source === 'planer', 'импорт: источник берётся из поля app');
check(exported.events.length === 2, 'импорт: события без даты и названия отброшены');
check(exported.invalid === 3, 'импорт: мусор посчитан отдельно');
check(
  exported.events[0].date === '2026-11-27' && exported.events[0].time === '18:00' && exported.events[0].endTime === '19:00',
  'импорт: дата, время и окончание сохраняются'
);
check(exported.events[1].allDay && exported.events[1].time === '', 'импорт: событие на весь день');
check(exported.events[1].createdAt === 700, 'импорт: исходный createdAt сохраняется');

const bare = backup.parseAssistantBackup({ events: [{ title: 'x', date: '2026-11-27' }] });
check(bare.source === 'assistant' && bare.events.length === 1, 'импорт: принимается «голое» состояние');

const badEnd = backup.parseAssistantBackup({
  events: [{ title: 'x', date: '2026-11-27', time: '10:00', endTime: '09:00' }]
});
check(badEnd.events[0].endTime === '', 'импорт: окончание раньше начала отбрасывается');

let threwNoEvents = false;
try {
  backup.parseAssistantBackup({ app: 'planer', state: { tasks: [] } });
} catch {
  threwNoEvents = true;
}
check(threwNoEvents, 'импорт: файл без state.events отвергается');

let threwNotObject = false;
try {
  backup.parseAssistantBackup('строка');
} catch {
  threwNotObject = true;
}
check(threwNotObject, 'импорт: не-объект отвергается с ошибкой');

/* ---------- инструмент модели ---------- */

const good = tools.parsePlannerArgs(
  JSON.stringify({ reply: 'Готово', actions: [{ type: 'event.delete', id: 'e1' }] })
);
check(good.ok && good.value.reply === 'Готово' && good.value.actions.length === 1, 'parsePlannerArgs читает ответ инструмента');
check(!tools.parsePlannerArgs('{').ok, 'parsePlannerArgs отвергает битый JSON');
check(!tools.parsePlannerArgs(JSON.stringify({ reply: '   ' })).ok, 'пустой ответ без действий — ошибка');
const noActions = tools.parsePlannerArgs(JSON.stringify({ reply: 'Какой день?' }));
check(noActions.ok && noActions.value.actions.length === 0, 'ответ без действий допустим');
check(tools.PLANNER_ACTIONS_TOOL.function.name === 'planner_actions', 'имя инструмента стабильно');
check(
  tools.PLANNER_ACTIONS_TOOL.function.parameters.properties.actions.maxItems === 8,
  'схема инструмента ограничивает ответ восемью действиями'
);

/* ---------- контекст и промпт ---------- */

const ctxEvents = [
  ev('e1', 'Сегодня', '2026-11-27', '10:00'),
  ev('e2', 'Позже', '2026-12-05', '09:00'),
  ev('e3', 'Далеко', '2027-01-10', '09:00'),
  ev('e4', 'Вчера', '2026-11-26', '09:00')
];
const ctx = prompts.buildPlannerContext(ctxEvents, now, { days: 14, maxEvents: 20 });
check(ctx.today === '2026-11-27' && ctx.weekday === 'пятница', 'контекст: сегодня и день недели');
check(ctx.horizon === '2026-12-11', 'контекст: окно 14 дней');
check(ctx.events.length === 2, 'контекст: вчера и далёкое будущее отсечены');
check(ctx.events[0].id === 'e1' && ctx.events[1].id === 'e2', 'контекст: события отсортированы по дате');
const ctxLimited = prompts.buildPlannerContext(ctxEvents, now, { days: 14, maxEvents: 1 });
check(ctxLimited.events.length === 1 && ctxLimited.hidden === 1, 'контекст: лимит и счётчик скрытых');

const system = prompts.plannerAssistantSystem(ctx);
check(system.includes('2026-11-27') && system.includes('пятница'), 'промпт: дата и день недели');
check(system.includes('id: e1') && system.includes('id: e2'), 'промпт: id событий для правок');
check(system.includes('planner_actions'), 'промпт: имя инструмента');
check(system.includes('Выдуманные даты запрещены'), 'промпт: запрет придумывать даты');
check(system.includes('Не больше 8 действий'), 'промпт: лимит действий');
check(!system.includes('2027-01-10'), 'промпт не показывает события за окном');
check(!system.includes('project.create'), 'промпт не обещает действия с проектами');

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки календаря пройдены (${total}).`);

