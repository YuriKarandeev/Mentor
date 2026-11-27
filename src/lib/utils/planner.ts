/**
 * Календарь: чистые функции дат, времени и группировки событий.
 *
 * Модуль намеренно не зависит ни от Dexie, ни от Svelte, ни от сети: его
 * проверяет `npm run test:planner` обычным импортом из Node. Логика портирована
 * из «Ассистента» (`ai.js`) вместе с защитой от «30 февраля»: `new Date(2026, 1, 30)`
 * молча превращается в 2 марта, поэтому дата сверяется по компонентам.
 */

/** Колонки канбана старых проектов: словарь оставлен для будущего среза «проекты». */
export type ProjectColumn = 'idea' | 'planned' | 'progress' | 'done';

export const PROJECT_COLUMNS: ProjectColumn[] = ['idea', 'planned', 'progress', 'done'];

export const COLUMN_TITLES: Record<ProjectColumn, string> = {
  idea: 'Идея',
  planned: 'Запланировано',
  progress: 'В работе',
  done: 'Готово'
};

/** Лимиты, которые «Ассистент» передавал модели. Держим те же значения. */
export const AI_MAX_ACTIONS = 8;
export const AI_MAX_TITLE = 120;
export const AI_MAX_NOTES = 400;

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

/** Схлопывает пробелы и обрезает строку — так же, как это делал Ассистент. */
export function text(value: unknown, max = 0): string {
  if (value === null || value === undefined) return '';
  const out = String(value).replace(/\s+/g, ' ').trim();
  return max > 0 && out.length > max ? out.slice(0, max).trim() : out;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDate(value?: Date | number | string): Date {
  if (value instanceof Date) return value;
  return new Date(value === undefined ? Date.now() : value);
}

/**
 * Локальная дата «ГГГГ-ММ-ДД». Именно локальная: `toISOString()` даёт UTC
 * и вечером легко показывает вчерашний или завтрашний день.
 */
export function localDate(value?: Date | number | string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localTime(value?: Date | number | string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function todayIso(now?: Date | number | string): string {
  return localDate(now);
}

export function addDays(value: Date | number | string | undefined, days: number): Date {
  const d = new Date(toDate(value).getTime());
  if (Number.isNaN(d.getTime())) return d;
  d.setDate(d.getDate() + (Number(days) || 0));
  return d;
}

/** Прибавляет дни к «ГГГГ-ММ-ДД»; невалидная дата остаётся пустой. */
export function addDaysIso(iso: string, days: number): string {
  const valid = validDate(iso);
  if (!valid) return '';
  return localDate(addDays(`${valid}T12:00:00`, days));
}

export function weekdayRu(value?: Date | number | string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return WEEKDAYS[d.getDay()];
}

/** Дата без подмены дней: 2026-02-30 не должен стать 2 марта. */
export function validDate(value: unknown): string {
  const raw = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return '';
  return raw;
}

/** Время «ЧЧ:ММ»: модель иногда присылает «15:00:00» или «9:5». */
export function validTime(value: unknown): string {
  const raw = text(value);
  const m = raw.match(/^(\d{1,2})[:. ](\d{1,2})(?::\d{1,2})?$/);
  if (!m) return '';
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return '';
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/** «27.11.2026» — компактно, для карточек и подписей. */
export function formatDateRu(value: unknown): string {
  const raw = validDate(value);
  if (!raw) return '';
  return `${raw.slice(8, 10)}.${raw.slice(5, 7)}.${raw.slice(0, 4)}`;
}


/**
 * Человеческая подпись дня: «Сегодня», «Завтра», «Вчера», иначе «пт, 27 ноября».
 * Считается от локального дня — так же, как события группируются в списке.
 */
export function formatDateHuman(value: unknown, now?: Date | number | string): string {
  const raw = validDate(value);
  if (!raw) return '';
  const today = todayIso(now);
  if (raw === today) return 'Сегодня';
  if (raw === addDaysIso(today, 1)) return 'Завтра';
  if (raw === addDaysIso(today, -1)) return 'Вчера';
  const d = new Date(`${raw}T12:00:00`);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}`;
}

/** Ключ сортировки: дата, затем время; события «весь день» — первыми в дне. */
export function eventSortKey(ev: {
  date: string;
  time?: string;
  allDay?: boolean;
  title?: string;
}): string {
  const time = ev.allDay ? '' : validTime(ev.time);
  return `${ev.date || '9999-12-31'} ${time || '00:00'} ${text(ev.title)}`;
}

export function compareEvents(
  a: { date: string; time?: string; allDay?: boolean; title?: string },
  b: { date: string; time?: string; allDay?: boolean; title?: string }
): number {
  return eventSortKey(a).localeCompare(eventSortKey(b), 'ru');
}

export interface DayGroup<T> {
  date: string;
  items: T[];
}

/** Раскладывает события по дням, сохраняя порядок внутри дня. */
export function eventsByDay<
  T extends { date: string; time?: string; allDay?: boolean; title?: string }
>(events: T[]): DayGroup<T>[] {
  const sorted = [...events].sort(compareEvents);
  const groups: DayGroup<T>[] = [];
  for (const ev of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === ev.date) last.items.push(ev);
    else groups.push({ date: ev.date, items: [ev] });
  }
  return groups;
}

/** Событие попадает в окно «сегодня + N дней» — это же окно видит модель. */
export function isWithinDays(date: string, days: number, now?: Date | number | string): boolean {
  const today = todayIso(now);
  const horizon = addDaysIso(today, Math.max(0, Number(days) || 0));
  return Boolean(validDate(date)) && date >= today && date <= horizon;
}

/** Подпись времени для карточки события. */
export function eventTimeLabel(ev: { time?: string; endTime?: string; allDay?: boolean }): string {
  if (ev.allDay) return 'весь день';
  const time = validTime(ev.time);
  if (!time) return 'весь день';
  const end = validTime(ev.endTime);
  return end && end > time ? `${time}–${end}` : time;
}
