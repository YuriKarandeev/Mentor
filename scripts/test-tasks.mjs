/**
 * Проверки дел: дни недели, отметки по датам, действия помощника и промпт
 * (src/lib/utils/tasks.ts, api/planner-actions.ts, api/planner-apply.ts,
 * api/prompts.ts, api/planner-tools.ts).
 *
 * Чистые функции: без браузера, Dexie, сети и ключа API.
 * Запуск: npm run test:tasks
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

const tasksUtil = await load('src/lib/utils/tasks.ts');
const actions = await load('src/lib/api/planner-actions.ts');
const prompts = await load('src/lib/api/prompts.ts');
const tools = await load('src/lib/api/planner-tools.ts');

const {
  WEEKDAY_LABELS,
  compareTasks,
  dayProgress,
  isTaskDone,
  nextTaskDate,
  normalizeDays,
  normalizeDoneDates,
  parseDays,
  repeatLabel,
  taskOccursOn,
  tasksForDay,
  weekdayIndex,
  withTaskDone
} = tasksUtil;

/* ---------- дни недели ---------- */

const friday = new Date(2026, 10, 27, 9, 15);
check(weekdayIndex('2026-11-27') === 4, 'weekdayIndex: пятница — 4 (0 = понедельник)');
check(weekdayIndex('2026-11-30') === 0, 'weekdayIndex: понедельник — 0');
check(weekdayIndex(friday) === 4, 'weekdayIndex принимает Date');
check(weekdayIndex('2026-02-30') === -1, 'weekdayIndex не гадает по несуществующей дате');
check(WEEKDAY_LABELS[4] === 'пт', 'подписи дней недели начинаются с понедельника');

check(JSON.stringify(normalizeDays([3, 1, 1, 9, 2])) === '[1,2,3]', 'normalizeDays убирает повторы и мусор');
check(normalizeDays('пн').length === 0, 'normalizeDays не разбирает строки — это делает parseDays');
check(JSON.stringify(parseDays('пн, ср, пт')) === '[0,2,4]', 'parseDays понимает сокращения');
check(JSON.stringify(parseDays([1, 3])) === '[1,3]', 'parseDays принимает массив чисел');
check(JSON.stringify(parseDays('каждый день')) === '[0,1,2,3,4,5,6]', 'parseDays: «каждый день»');
check(JSON.stringify(parseDays('по будням')) === '[0,1,2,3,4]', 'parseDays: «по будням»');
check(JSON.stringify(parseDays('выходные')) === '[5,6]', 'parseDays: «выходные»');
check(parseDays('когда-нибудь').length === 0, 'parseDays не выдумывает дни');

check(repeatLabel([0, 1, 2, 3, 4, 5, 6]) === 'каждый день', 'repeatLabel: каждый день');
check(repeatLabel([0, 1, 2, 3, 4]) === 'по будням', 'repeatLabel: будни');
check(repeatLabel([5, 6]) === 'по выходным', 'repeatLabel: выходные');
check(repeatLabel([0, 2, 4]) === 'пн, ср, пт', 'repeatLabel: перечисление');
check(repeatLabel([], '2026-11-28') === '28.11.2026', 'repeatLabel: разовая дата');
check(repeatLabel([]) === 'без расписания', 'repeatLabel: без расписания');

/* ---------- отметки за день ---------- */

check(JSON.stringify(normalizeDoneDates(['2026-11-28', '2026-11-27', '2026-02-30', '2026-11-28'])) === '["2026-11-27","2026-11-28"]', 'normalizeDoneDates: только настоящие даты');

const repeatTask = { id: 't1', title: 'Зарядка', days: [0, 2, 4], onceDate: '', done: [] };
check(taskOccursOn(repeatTask, '2026-11-27'), 'дело с повтором выполняется в свой день');
check(!taskOccursOn(repeatTask, '2026-11-28'), 'дело с повтором не выполняется в чужой день');
check(!taskOccursOn(repeatTask, '2026-02-30'), 'несуществующий день не попадает в расписание');

const onceTask = { id: 't2', title: 'Экзамен', days: [4], onceDate: '2026-11-28', done: [] };
check(taskOccursOn(onceTask, '2026-11-28'), 'разовое дело выполняется в свою дату');
check(!taskOccursOn(onceTask, '2026-11-27'), 'разовая дата важнее дней недели');

check(isTaskDone({ ...repeatTask, done: ['2026-11-27'] }, '2026-11-27'), 'отметка за день видна');
check(!isTaskDone({ ...repeatTask, done: ['2026-11-26'] }, '2026-11-27'), 'чужая отметка не считается');

const marked = withTaskDone(repeatTask, '2026-11-27', true);
check(marked.done.length === 1 && marked.done[0] === '2026-11-27', 'withTaskDone ставит отметку');
check(repeatTask.done.length === 0, 'withTaskDone не меняет исходное дело');
check(withTaskDone(marked, '2026-11-27', false).done.length === 0, 'withTaskDone снимает отметку');
check(withTaskDone(marked, '2026-02-30', true).done.length === 1, 'битая дата отметку не меняет');

/* ---------- сортировка и выборка ---------- */

const list = [
  { id: 'b', title: 'Вечер', days: [4], onceDate: '', time: '18:00', done: [] },
  { id: 'a', title: 'Утро', days: [4], onceDate: '', time: '08:00', done: [] },
  { id: 'c', title: 'Без времени', days: [4], onceDate: '', time: '', done: [] },
  { id: 'd', title: 'Другой день', days: [5], onceDate: '', time: '09:00', done: [] }
];
check(compareTasks(list[1], list[0]) < 0, 'compareTasks: раннее время идёт первым');
check(compareTasks(list[0], list[2]) < 0, 'compareTasks: дело без времени идёт последним');

const forFriday = tasksForDay(list, '2026-11-27');
check(forFriday.length === 3, 'tasksForDay отбирает только дела этого дня');
check(forFriday[0].id === 'a' && forFriday[2].id === 'c', 'tasksForDay сортирует по времени');
check(list.length === 4, 'tasksForDay не меняет исходный массив');

check(nextTaskDate({ days: [0], onceDate: '' }, '2026-11-27') === '2026-11-30', 'nextTaskDate: ближайший понедельник');
check(nextTaskDate({ days: [], onceDate: '2026-11-20' }, '2026-11-27') === '', 'nextTaskDate: прошедшая разовая дата не возвращается');

const progress = dayProgress(
  [
    { ...list[0], done: ['2026-11-27'] },
    { ...list[1] },
    { ...list[3], done: ['2026-11-27'] }
  ],
  '2026-11-27'
);
check(progress.done === 1 && progress.total === 2, 'dayProgress считает только дела этого дня');

/* ---------- разбор действий ---------- */

const { applyPlannerActions, describePlannerActions, normalizeTaskAction } = actions;

const created = normalizeTaskAction({ type: 'task.create', title: '  Зарядка  ', days: ['пн', 'ср'] });
check(Boolean(created && created.title === 'Зарядка' && created.days.join() === '0,2'), 'task.create: название и дни из строки');
check(normalizeTaskAction({ type: 'task.create', title: 'Дело' }) === null, 'дело без дней и даты не создаётся');
check(normalizeTaskAction({ type: 'task.create', title: '   ', days: [1] }) === null, 'дело без названия не создаётся');

const oneTime = normalizeTaskAction({
  type: 'task.create',
  title: 'Экзамен',
  date: '2026-11-28',
  days: [4]
});
check(Boolean(oneTime && oneTime.date === '2026-11-28' && oneTime.days.length === 0), 'дата важнее дней недели');

const doneAction = normalizeTaskAction({ type: 'task.done', id: 't1' }, '2026-11-27');
check(Boolean(doneAction && doneAction.date === '2026-11-27' && doneAction.done === true), 'task.done по умолчанию: сегодня');
const undoneAction = normalizeTaskAction({ type: 'task.done', id: 't1', done: false }, '2026-11-27');
check(Boolean(undoneAction && undoneAction.done === false), 'task.done понимает «сними отметку»');

check(normalizeTaskAction({ type: 'task.update', id: 't1' }) === null, 'пустая правка дела не применяется');
check(normalizeTaskAction({ type: 'task.update', id: 't1', date: '2026-02-30' }) === null, 'битая дата в правке дела отбрасывается');
check(normalizeTaskAction({ type: 'task.delete' }) === null, 'удаление дела без id отбрасывается');

/* ---------- применение к спискам ---------- */

const taskRow = (id, title, days = [4], done = [], onceDate = '', time = '') => ({
  id,
  title,
  notes: '',
  days,
  onceDate,
  time,
  done,
  createdAt: 1,
  updatedAt: 1,
  dirty: 1
});

const state = {
  events: [],
  tasks: [taskRow('t1', 'Зарядка', [4]), taskRow('t2', 'Удалить', [5])]
};

let seq = 0;
const applied = applyPlannerActions(
  [
    { type: 'task.create', title: 'Чтение', days: [1, 3] },
    { type: 'task.update', id: 't1', time: '08:00' },
    { type: 'task.done', id: 't1', date: '2026-11-27' },
    { type: 'task.delete', id: 't2' },
    { type: 'task.create', title: 'Без расписания' }
  ],
  state,
  { now: 5000, today: '2026-11-27', newId: () => `new_${++seq}` }
);

check(applied.applied.length === 4, 'применены четыре действия с делами');
check(applied.skipped.length === 1, 'дело без расписания пропущено с причиной');
check(applied.changes.tasks.put.length === 2, 'создание и правка одного дела попадают в put');
check(applied.changes.tasks.remove.length === 1 && applied.changes.tasks.remove[0] === 't2', 'удаление дела попадает в remove');
check(applied.undo.tasks.remove[0] === 'new_1', 'отмена удаляет созданное дело');
check(applied.undo.tasks.restore.includes('t2'), 'отмена снимает надгробие удалённого дела');
check(state.tasks[0].done.length === 0 && state.tasks[0].time === '', 'исходный список дел не меняется');

const madeTask = applied.changes.tasks.put.find((row) => row.id === 'new_1');
check(
  Boolean(madeTask && madeTask.days.join() === '1,3' && madeTask.dirty === 1 && madeTask.createdAt === 5000),
  'новое дело получает дни, dirty и метки времени'
);

const checkedTask = applied.changes.tasks.put.find((row) => row.id === 't1');
check(Boolean(checkedTask && checkedTask.time === '08:00' && checkedTask.done.includes('2026-11-27')), 'правка и отметка применяются к одному делу');
check(applied.undo.tasks.put.some((row) => row.id === 't1' && row.time === '' && row.done.length === 0), 'отмена возвращает дело в исходное состояние');

const sharedLimit = applyPlannerActions(
  [
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'event.create', title: `С${i}`, date: '2026-11-28' })),
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'task.create', title: `Д${i}`, days: [4] }))
  ],
  { events: [], tasks: [] },
  { now: 10, newId: () => `x${++seq}` }
);
check(sharedLimit.applied.length === 8, 'лимит в 8 действий общий для событий и дел');
check(
  sharedLimit.skipped.some((reason) => reason.includes('Слишком много действий')),
  'лишние действия объяснены'
);

/* ---------- подписи ---------- */

const labels = describePlannerActions(
  [
    { type: 'task.create', title: 'Чтение', days: [1, 3] },
    { type: 'task.done', id: 't1', date: '2026-11-27' },
    { type: 'task.done', id: 't1', date: '2026-11-27', done: false },
    { type: 'task.delete', id: 't2' },
    { type: 'task.create', title: 'Без расписания' }
  ],
  state
);
check(labels[0] === 'Добавить дело «Чтение»: вт, чт', 'подпись создания дела');
check(labels[1] === 'Отметить дело «Зарядка» выполненным на 27.11.2026', 'подпись отметки');
check(labels[2] === 'Снять отметку с дела «Зарядка» на 27.11.2026', 'подпись снятия отметки');
check(labels[3] === 'Удалить дело «Удалить»', 'подпись удаления берёт название');
check(labels[4].includes('пропущено'), 'мусор подписывается как пропущенный');

/* ---------- контекст и промпт ---------- */

const now = new Date(2026, 10, 27, 9, 15);
const ctx = prompts.buildPlannerContext(
  {
    events: [],
    tasks: [
      taskRow('t1', 'Зарядка', [0, 2, 4], ['2026-11-27']),
      taskRow('t2', 'Разовое', [], [], '2026-11-28'),
      { ...taskRow('t3', 'Без расписания', []), days: [], onceDate: '' }
    ]
  },
  now,
  { maxTasks: 1 }
);
check(ctx.tasks.length === 1 && ctx.hiddenTasks === 1, 'контекст: лимит и счётчик скрытых дел');
check(ctx.tasks[0].repeat === 'пн, ср, пт', 'контекст: расписание дела подписано');
check(ctx.tasks[0].doneToday === true, 'контекст: отметка за сегодня видна модели');

const system = prompts.plannerAssistantSystem(ctx);
check(system.includes('Дела (повторяющиеся задачи)'), 'промпт: блок дел');
check(system.includes('id: t1'), 'промпт: id дела для отметки');
check(system.includes('task.done'), 'промпт: действие отметки дела');
check(system.includes('спроси, когда его повторять'), 'промпт: запрет создавать дело без расписания');
check(!system.includes('id: t3'), 'промпт не показывает дела без расписания');

/* ---------- схема инструмента ---------- */

const schema = tools.PLANNER_ACTIONS_TOOL.function.parameters.properties.actions.items.properties;
check(
  schema.type.enum.includes('task.create') && schema.type.enum.includes('task.done'),
  'схема инструмента знает действия с делами'
);
check(schema.days.items.maximum === 6, 'схема: дни недели 0…6');
check(schema.days.description.includes('понедельник'), 'схема объясняет нумерацию дней');

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки дел пройдены (${total}).`);
