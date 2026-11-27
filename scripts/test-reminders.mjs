#!/usr/bin/env node
/**
 * Проверки расписания напоминаний (src/lib/utils/reminders.ts).
 *
 * Модуль чистый: текущее время передаётся параметром, поэтому тест не зависит
 * от часового пояса машины и проходит одинаково в CI (UTC) и локально.
 *
 * Запуск: npm run test:reminders
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
const reminders = await load('src/lib/utils/reminders.ts');
const { localDate } = await load('src/lib/utils/planner.ts');
const { weekdayIndex } = await load('src/lib/utils/tasks.ts');

const {
  DEFAULT_REMINDERS,
  REMINDER_MAX_ITEMS,
  buildReminders,
  leadLabel,
  normalizeReminderSettings,
  planSignature,
  reminderLabel,
  remindersSummary,
  toPlanItems
} = reminders;

const at = (iso, hours, minutes = 0) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, hours, minutes).getTime();
};

const addDays = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
};

// Пятница, 27 ноября 2026, 08:00 — «сейчас» во всех проверках.
const NOW = new Date(2026, 10, 27, 8, 0, 0, 0);
const TODAY = localDate(NOW);
const TOMORROW = addDays(TODAY, 1);

const base = {
  enabled: true,
  events: true,
  tasks: true,
  leadMinutes: 15,
  digestTime: '09:00',
  quietFrom: '',
  quietTo: '',
  horizonHours: 48
};

const build = (overrides = {}) =>
  buildReminders({
    events: overrides.events ?? [],
    tasks: overrides.tasks ?? [],
    settings: { ...base, ...(overrides.settings ?? {}) },
    now: NOW
  });

const tags = (items) => items.map((item) => item.tag);

// --- 1. настройки ---
console.log('\nnormalizeReminderSettings');
{
  const empty = normalizeReminderSettings(undefined);
  check(empty.leadMinutes === DEFAULT_REMINDERS.leadMinutes, 'без настроек — за 15 минут по умолчанию');
  check(empty.digestTime === '09:00', 'без настроек — сводка в 09:00');
  check(empty.enabled === false, 'напоминания по умолчанию выключены');
  check(empty.quietFrom === '22:00' && empty.quietTo === '08:00', 'тихие часы по умолчанию 22:00–08:00');

  const cleared = normalizeReminderSettings({ ...base, quietFrom: '', quietTo: '', digestTime: '' });
  check(cleared.quietFrom === '' && cleared.quietTo === '', 'явно пустые тихие часы остаются пустыми');
  check(cleared.digestTime === '', 'явно пустая сводка отключает её');

  const clamped = normalizeReminderSettings({ leadMinutes: 9999, horizonHours: 1 });
  check(clamped.leadMinutes === 720, 'leadMinutes ограничен 720', String(clamped.leadMinutes));
  check(clamped.horizonHours === 6, 'horizonHours не меньше 6', String(clamped.horizonHours));

  const broken = normalizeReminderSettings({ quietFrom: '25:00', quietTo: '08:00' });
  check(broken.quietFrom === '' && broken.quietTo === '', 'неверное время тихих часов отключает окно');
}

// --- 2. событие со временем ---
console.log('\nсобытие со временем');
{
  const items = build({
    events: [{ id: 'e1', title: 'Созвон', date: TODAY, time: '14:00', allDay: false }]
  });
  check(items.length === 1, 'одно напоминание', JSON.stringify(tags(items)));
  const item = items[0] ?? {};
  check(item.at === at(TODAY, 13, 45), 'за 15 минут до начала (13:45)', String(item.at));
  check(item.tag === `event:e1:${TODAY}`, 'стабильный tag события', item.tag);
  check(item.kind === 'event', 'kind = event', item.kind);
  check(item.url === '#/calendar', 'по нажатию открывается календарь', item.url);
  check(
    item.body.includes('через 15 мин') && item.body.includes('14:00'),
    'в теле — за сколько и во сколько',
    item.body
  );
}

// --- 3. событие «весь день» попадает в утреннюю сводку ---
console.log('\nсобытие «весь день»');
{
  const items = build({
    events: [{ id: 'e2', title: 'День рождения', date: TODAY, time: '', allDay: true }]
  });
  check(items.length === 1, 'одно напоминание-сводка', JSON.stringify(tags(items)));
  const item = items[0] ?? {};
  check(item.tag === `digest:${TODAY}`, 'tag сводки дня', item.tag);
  check(item.at === at(TODAY, 9, 0), 'сводка в 09:00', String(item.at));
  check(item.title.startsWith('Сегодня'), 'заголовок «Сегодня»', item.title);
  check(item.body.includes('Событие: День рождения'), 'событие перечислено в сводке', item.body);
}


// --- 4. дела: со временем и без ---
console.log('\nдела');
{
  const day = weekdayIndex(TODAY);
  const items = build({
    tasks: [
      { id: 't1', title: 'Зарядка', days: [day], onceDate: '', time: '18:00', done: [] },
      { id: 't2', title: 'Прочитать главу', days: [day], onceDate: '', time: '', done: [] }
    ]
  });
  const task = items.find((item) => item.tag === `task:t1:${TODAY}`);
  check(Boolean(task), 'дело со временем — отдельное напоминание');
  check(task?.at === at(TODAY, 18, 0), 'время дела совпадает', String(task?.at));
  check(task?.kind === 'task' && task?.url === '#/tasks', 'kind = task и переход в «Дела»');
  const digest = items.find((item) => item.tag === `digest:${TODAY}`);
  check(Boolean(digest), 'дело без времени — в сводке');
  check(digest?.body.includes('Дело: Прочитать главу'), 'дело без времени перечислено', digest?.body ?? '');
}

// --- 5. выполненные дела не напоминают ---
console.log('\nотметка выполнения');
{
  const day = weekdayIndex(TODAY);
  const items = build({
    tasks: [{ id: 't3', title: 'Витамины', days: [day], onceDate: '', time: '10:00', done: [TODAY] }]
  });
  check(items.length === 0, 'выполненное дело не напоминает', JSON.stringify(tags(items)));

  const other = build({
    tasks: [{ id: 't4', title: 'Витамины', days: [day], onceDate: '', time: '10:00', done: [TOMORROW] }]
  });
  check(tags(other).includes(`task:t4:${TODAY}`), 'отметка другого дня не мешает');
}

// --- 6. разовое дело ---
console.log('\nразовое дело');
{
  const items = build({
    tasks: [{ id: 't5', title: 'Оплатить счёт', days: [], onceDate: TOMORROW, time: '12:00', done: [] }]
  });
  check(tags(items).includes(`task:t5:${TOMORROW}`), 'напоминание в свою дату');
  check(!tags(items).includes(`task:t5:${TODAY}`), 'в другие дни не напоминает');
}

// --- 7. тихие часы ---
console.log('\nтихие часы');
{
  const day = weekdayIndex(TODAY);
  const items = build({
    settings: { quietFrom: '22:00', quietTo: '08:00' },
    tasks: [{ id: 't6', title: 'Позднее дело', days: [day], onceDate: '', time: '23:30', done: [] }]
  });
  const item = items.find((entry) => entry.tag === `task:t6:${TODAY}`);
  check(Boolean(item), 'ночное дело не потеряно');
  check(item?.at === at(TOMORROW, 8, 0), 'перенесено на конец тихих часов', String(item?.at));
}

// --- 8. сводка выключена ---
console.log('\nвыключенная сводка');
{
  const day = weekdayIndex(TODAY);
  const items = build({
    settings: { digestTime: '' },
    tasks: [{ id: 't7', title: 'Без времени', days: [day], onceDate: '', time: '', done: [] }]
  });
  check(items.length === 0, 'без сводки дело без времени не напоминает', JSON.stringify(tags(items)));
}

// --- 9. выключенные разделы ---
console.log('\nвыключенные разделы');
{
  const day = weekdayIndex(TODAY);
  const items = build({
    settings: { events: false, tasks: false },
    events: [{ id: 'e3', title: 'Созвон', date: TODAY, time: '14:00' }],
    tasks: [{ id: 't8', title: 'Зарядка', days: [day], onceDate: '', time: '18:00', done: [] }]
  });
  check(items.length === 0, 'ни событий, ни дел', JSON.stringify(tags(items)));

  const onlyEvents = build({
    settings: { tasks: false },
    events: [{ id: 'e4', title: 'Созвон', date: TODAY, time: '14:00' }],
    tasks: [{ id: 't9', title: 'Зарядка', days: [day], onceDate: '', time: '18:00', done: [] }]
  });
  check(
    tags(onlyEvents).every((tag) => tag.startsWith('event:')),
    'задачи выключены — только события',
    JSON.stringify(tags(onlyEvents))
  );
}

// --- 10. горизонт и прошедшее время ---
console.log('\nгоризонт');
{
  const far = build({
    settings: { horizonHours: 6 },
    events: [{ id: 'e5', title: 'Через два дня', date: addDays(TODAY, 2), time: '12:00' }]
  });
  check(far.length === 0, 'событие за горизонтом не планируется', JSON.stringify(tags(far)));

  const past = build({ events: [{ id: 'e6', title: 'Уже прошло', date: TODAY, time: '07:00' }] });
  check(past.length === 0, 'прошедшее событие не планируется', JSON.stringify(tags(past)));

  const soon = build({ events: [{ id: 'e7', title: 'Через 5 минут', date: TODAY, time: '08:05' }] });
  check(soon.length === 0, 'напоминание за 15 минут до события через 5 минут уже не нужно', JSON.stringify(tags(soon)));
}

// --- 11. повтор и сортировка ---
console.log('\nповтор и порядок');
{
  const items = build({
    tasks: [{ id: 't10', title: 'Каждый день', days: [0, 1, 2, 3, 4, 5, 6], onceDate: '', time: '18:00', done: [] }]
  });
  check(tags(items).includes(`task:t10:${TODAY}`), 'сегодня есть напоминание');
  check(tags(items).includes(`task:t10:${TOMORROW}`), 'завтра есть напоминание');
  check(
    items.every((item, i) => i === 0 || items[i - 1].at <= item.at),
    'список отсортирован по времени',
    items.map((i) => i.at).join(',')
  );
}

// --- 12. дубликаты ---
console.log('\nдубликаты');
{
  const items = build({
    events: [
      { id: 'dup', title: 'Созвон', date: TODAY, time: '14:00' },
      { id: 'dup', title: 'Созвон ещё раз', date: TODAY, time: '14:00' }
    ]
  });
  check(items.length === 1, 'одинаковый tag не задваивает уведомление', JSON.stringify(tags(items)));
}

// --- 13. полностью выключено ---
console.log('\nвыключено');
{
  const items = build({
    settings: { enabled: false },
    events: [{ id: 'e8', title: 'Созвон', date: TODAY, time: '14:00' }]
  });
  check(items.length === 0, 'enabled=false — пустой список');
}

// --- 14. подписи ---
console.log('\nподписи');
{
  check(leadLabel(0) === 'сейчас', '0 минут — «сейчас»', leadLabel(0));
  check(leadLabel(15) === 'через 15 мин', '15 минут', leadLabel(15));
  check(leadLabel(60) === 'через час', 'час', leadLabel(60));
  check(leadLabel(90) === 'через 1 ч 30 мин', 'полтора часа', leadLabel(90));
  const label = reminderLabel({ at: at(TODAY, 14, 0), title: 'Созвон' }, NOW);
  check(label === 'Сегодня 14:00 · Созвон', 'подпись ближайшего напоминания', label);
  check(remindersSummary(base) === 'события и дела · за 15 мин', 'сводка настроек', remindersSummary(base));
  check(remindersSummary({ ...base, events: false, tasks: false }) === 'выключены', 'без разделов — выключены');
}

// --- 15. план для Firestore ---
console.log('\nплан для Firestore');
{
  check(
    DEFAULT_REMINDERS.horizonHours === 336,
    'по умолчанию горизонт — две недели',
    String(DEFAULT_REMINDERS.horizonHours)
  );
  check(normalizeReminderSettings({ horizonHours: 9999 }).horizonHours === 336, 'горизонт ограничен 336 часами');
  check(REMINDER_MAX_ITEMS >= 400, 'в план влезает две недели дел', String(REMINDER_MAX_ITEMS));

  const longRange = build({
    settings: { horizonHours: 336 },
    tasks: [{ id: 't11', title: 'Зарядка', days: [0, 1, 2, 3, 4, 5, 6], onceDate: '', time: '18:00', done: [] }]
  });
  check(
    tags(longRange).includes(`task:t11:${addDays(TODAY, 10)}`),
    'дело через 10 дней попадает в план',
    JSON.stringify(tags(longRange).slice(-3))
  );

  const items = build({ events: [{ id: 'e9', title: 'Созвон', date: TODAY, time: '14:00' }] });
  const plan = toPlanItems(items);
  check(plan.length === 1, 'toPlanItems переносит элементы', JSON.stringify(plan));
  check(plan[0]?.key === `event:e9:${TODAY}`, 'ключ дедупликации — tag', plan[0]?.key);
  check(plan[0]?.tag === plan[0]?.key, 'tag и key совпадают');
  check(!Number.isNaN(Date.parse(plan[0]?.at ?? '')), 'момент в плане — ISO-строка', plan[0]?.at);
  check(plan[0]?.url === '#/calendar', 'маршрут перенесён', plan[0]?.url);

  check(planSignature(plan, 15) === planSignature(toPlanItems(items), 15), 'отпечаток стабилен');
  check(planSignature(plan, 15) !== planSignature(plan, 30), 'смена leadMinutes меняет отпечаток');
  check(planSignature([], 0) === '0|', 'пустой план — пустой отпечаток', planSignature([], 0));
  check(
    toPlanItems([{ at: Number.NaN, title: 'x', body: '', tag: 'bad', kind: 'event', url: '' }]).length === 0,
    'битая дата в плане отбрасывается'
  );
}

console.log(`\n${total - failures.length}/${total} проверок пройдено`);
if (failures.length) {
  console.log('\nОшибки:');
  for (const failure of failures) console.log(`  ✖ ${failure}`);
  process.exit(1);
}

