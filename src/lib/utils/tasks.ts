/**
 * Дела: повторяющиеся задачи по дням недели и отметки выполнения по датам.
 *
 * Модуль без Dexie, Svelte и сети — его проверяет `npm run test:tasks`.
 * Дни недели здесь нумеруются как в календаре пользователя: 0 — понедельник,
 * 6 — воскресенье. Это не `Date.getDay()` (там 0 — воскресенье), поэтому
 * перевод всегда идёт через `weekdayIndex()`.
 */
import { addDaysIso, text, validDate, validTime } from './planner.ts';

export const TASK_MAX_TITLE = 120;
export const TASK_MAX_NOTES = 400;
/** Сколько отметок храним в одной задаче: старые обрезаем, иначе массив растёт вечно. */
export const TASK_MAX_DONE = 400;

/** Дни недели в порядке отображения: пн … вс. */
export const WEEKDAY_ORDER: number[] = [0, 1, 2, 3, 4, 5, 6];
/** Сколько дел максимум уходит модели: без id она не отметит и не удалит дело. */
export const AI_MAX_TASKS = 24;
export const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const WEEKDAY_FULL = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье'
];

const DAY_ALIASES: Record<string, number> = {
  пн: 0,
  пон: 0,
  понедельник: 0,
  вт: 1,
  вторник: 1,
  ср: 2,
  среда: 2,
  срд: 2,
  чт: 3,
  чет: 3,
  четверг: 3,
  пт: 4,
  пят: 4,
  пятница: 4,
  сб: 5,
  суб: 5,
  суббота: 5,
  вс: 6,
  вос: 6,
  воскресенье: 6
};

/** День недели локальной даты: 0 — понедельник, 6 — воскресенье. */
export function weekdayIndex(value?: Date | number | string): number {
  let d: Date;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = new Date(value);
  else if (typeof value === 'string' && value) {
    // Строка — только настоящая локальная дата: «2026-02-30» не должна стать мартом.
    const iso = validDate(value);
    if (!iso) return -1;
    d = new Date(`${iso}T12:00:00`);
  } else d = new Date();
  if (Number.isNaN(d.getTime())) return -1;
  return (d.getDay() + 6) % 7;
}

/** Приводит массив дней к безопасному виду: только 0…6, без повторов, по порядку. */
export function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const item of value) {
    const day = typeof item === 'number' ? item : Number(text(item));
    if (Number.isInteger(day) && day >= 0 && day <= 6) out.add(day);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Разбор дней из ответа модели: массив чисел, «пн, ср, пт», «по будням»,
 * «каждый день», «выходные». Непонятное просто отбрасывается.
 */
export function parseDays(value: unknown): number[] {
  const raw = Array.isArray(value) ? value.join(' ') : value;
  const phrase = text(raw).toLowerCase();
  if (!phrase) return [];
  if (/(каждый день|ежедневно|daily|все дни)/.test(phrase)) return [...WEEKDAY_ORDER];
  if (/(будн|рабочие дни|weekday)/.test(phrase)) return [0, 1, 2, 3, 4];
  if (/(выходн|weekend)/.test(phrase)) return [5, 6];

  const tokens = phrase.split(/[,;/.\s]+/).filter(Boolean);
  const out = new Set<number>();
  for (const token of tokens) {
    if (/^\d$/.test(token)) {
      const day = Number(token);
      if (day >= 0 && day <= 6) out.add(day);
      continue;
    }
    const day = DAY_ALIASES[token];
    if (day !== undefined) out.add(day);
  }
  return [...out].sort((a, b) => a - b);
}

/** Отметки выполнения: только настоящие даты, без повторов, по возрастанию. */
export function normalizeDoneDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const iso = validDate(item);
    if (iso) out.add(iso);
  }
  return [...out].sort().slice(-TASK_MAX_DONE);
}

/** «28.11.2026» — короткая подпись разовой даты. */
function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** Подпись расписания: «каждый день», «по будням», «пн, ср, пт» или дата. */
export function repeatLabel(days: number[], onceDate = ''): string {
  const list = normalizeDays(days);
  const once = validDate(onceDate);
  if (list.length === 0) return once ? shortDate(once) : 'без расписания';
  if (list.length === 7) return 'каждый день';
  if (list.length === 5 && list.every((d, i) => d === i)) return 'по будням';
  if (list.length === 2 && list[0] === 5 && list[1] === 6) return 'по выходным';
  const named = list.map((d) => WEEKDAY_LABELS[d]).join(', ');
  return once ? `${named} с ${shortDate(once)}` : named;
}

interface ScheduleLike {
  days?: number[];
  onceDate?: string;
}

/** Выполняется ли дело в этот день: разовое — только в свою дату, повтор — по дням. */
export function taskOccursOn(task: ScheduleLike, iso: string): boolean {
  const date = validDate(iso);
  if (!date) return false;
  const once = validDate(task.onceDate);
  if (once) return once === date;
  const days = normalizeDays(task.days);
  if (days.length === 0) return false;
  return days.includes(weekdayIndex(date));
}

interface TaskDoneLike extends ScheduleLike {
  done?: string[];
}

export function isTaskDone(task: TaskDoneLike, iso: string): boolean {
  const date = validDate(iso);
  return Boolean(date) && normalizeDoneDates(task.done).includes(date);
}

/** Иммутабельная отметка: возвращает копию дела с новой датой в `done`. */
export function withTaskDone<T extends TaskDoneLike>(task: T, iso: string, done: boolean): T {
  const date = validDate(iso);
  if (!date) return task;
  const set = new Set(normalizeDoneDates(task.done));
  if (done) set.add(date);
  else set.delete(date);
  return { ...task, done: [...set].sort().slice(-TASK_MAX_DONE) };
}

interface SortableTask extends ScheduleLike {
  title?: string;
  time?: string;
}

/** Сортировка: по времени (без времени — в конец), затем по названию. */
export function compareTasks(a: SortableTask, b: SortableTask): number {
  const at = validTime(a.time);
  const bt = validTime(b.time);
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return at.localeCompare(bt);
  }
  return text(a.title).localeCompare(text(b.title), 'ru');
}

/** Дела, которые выполняются в указанный день. Исходный массив не меняется. */
export function tasksForDay<T extends SortableTask>(tasks: T[], iso: string): T[] {
  return tasks.filter((task) => taskOccursOn(task, iso)).sort(compareTasks);
}

/** Ближайшая дата, когда дело снова нужно сделать (для подписи «дальше»). */
export function nextTaskDate(task: ScheduleLike, fromIso: string, horizon = 14): string {
  const start = validDate(fromIso);
  if (!start) return '';
  for (let i = 0; i <= horizon; i += 1) {
    const iso = addDaysIso(start, i);
    if (iso && taskOccursOn(task, iso)) return iso;
  }
  return '';
}

/** Сколько дел выполнено из списка за день. */
export function dayProgress(tasks: TaskDoneLike[], iso: string): { done: number; total: number } {
  const list = tasks.filter((task) => taskOccursOn(task, iso));
  return { done: list.filter((task) => isTaskDone(task, iso)).length, total: list.length };
}
