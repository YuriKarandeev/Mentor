/**
 * Напоминания: какие уведомления и на какой момент нужно отправить.
 *
 * Модуль чистый — без Dexie, Svelte, сети и `Date.now()` внутри логики:
 * текущее время приходит параметром, поэтому `npm run test:reminders`
 * проверяет расписание в любом часовом поясе. Абсолютные метки времени
 * считаются по локальным датам устройства: отправителю часовой пояс не нужен,
 * он получает уже готовые UTC-метки.
 *
 * Дни недели — как в делах: 0 — понедельник … 6 — воскресенье.
 */
import { addDaysIso, localDate, pad2, text, validDate, validTime } from './planner.ts';
import { isTaskDone, taskOccursOn } from './tasks.ts';

/** Настройки напоминаний. Хранятся в kv устройства, в облако не уходят. */
export interface ReminderSettings {
  /** Пользователь включил напоминания и выдал разрешение браузеру. */
  enabled: boolean;
  /** Напоминать о событиях календаря. */
  events: boolean;
  /** Напоминать о делах. */
  tasks: boolean;
  /** За сколько минут до события. 0 — в момент начала. */
  leadMinutes: number;
  /** «ЧЧ:ММ» сводки на день; пустая строка — сводку не отправлять. */
  digestTime: string;
  /** Начало тихих часов «ЧЧ:ММ»; пусто — тихих часов нет. */
  quietFrom: string;
  /** Конец тихих часов «ЧЧ:ММ». */
  quietTo: string;
  /**
   * На сколько часов вперёд планировать (6…336).
   *
   * В облако уходит готовый план, а отправляет его GitHub Actions, поэтому
   * горизонт должен переживать несколько дней без открытия приложения.
   */
  horizonHours: number;
}

export const REMINDER_LEADS: number[] = [0, 5, 15, 30, 60];

export const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: false,
  events: true,
  tasks: true,
  leadMinutes: 15,
  digestTime: '09:00',
  quietFrom: '22:00',
  quietTo: '08:00',
  // Две недели, как у «Ассистента»: план лежит в Firestore и рассылается
  // по cron, поэтому напоминания не должны иссякнуть, пока приложение закрыто.
  horizonHours: 336
};

/**
 * Предел длины плана в облаке. 400 элементов — это ~100 КБ документа:
 * далеко до лимита Firestore, но уже с запасом на две недели дел и событий.
 */
export const REMINDER_MAX_ITEMS = 400;

/** Версия формата плана в Firestore; отправитель понимает только её. */
export const PLAN_VERSION = 1;
/** Не отправляем то, что должно было уйти раньше, чем через 20 секунд после «сейчас». */
const MIN_LEAD_MS = 20_000;
const MAX_BODY = 240;

export type ReminderKind = 'event' | 'task' | 'digest';

export interface ReminderDraft {
  /** Момент отправки, UTC-миллисекунды. */
  at: number;
  title: string;
  body: string;
  /** Стабильный идентификатор: по нему устройство заменяет прошлую версию. */
  tag: string;
  kind: ReminderKind;
  /** Что открыть по нажатию: hash-маршрут приложения. */
  url: string;
}

/**
 * Элемент плана, который уходит в Firestore (`users/{uid}/pushPlan/{deviceId}`).
 * Момент отправки — ISO-строка: так его одинаково понимают браузер,
 * Firestore и отправитель на Node.
 */
export interface ReminderPlanItem {
  /** Ключ дедупликации — совпадает с `tag`. */
  key: string;
  /** ISO-метка момента отправки. */
  at: string;
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** Событие календаря в объёме, который нужен напоминаниям. */
export interface ReminderEventLike {
  id: string;
  title: string;
  date: string;
  time: string;
  allDay?: boolean;
  notes?: string;
}

/** Дело в объёме, который нужен напоминаниям. */
export interface ReminderTaskLike {
  id: string;
  title: string;
  notes?: string;
  days: number[];
  onceDate: string;
  time: string;
  done: string[];
}

export interface ReminderInput {
  events: ReminderEventLike[];
  tasks: ReminderTaskLike[];
  settings: ReminderSettings | Partial<ReminderSettings> | null | undefined;
  /** Текущий момент; по умолчанию — системное время. */
  now?: Date | number;
}

/**
 * Строит список напоминаний на горизонт настроек.
 *
 * Правила:
 *  - событие со временем — за `leadMinutes` до начала;
 *  - событие «весь день» и дело без времени — в утреннюю сводку (`digestTime`);
 *  - дело со временем — в свой день, если оно ещё не отмечено выполненным;
 *  - тихие часы сдвигают уведомление на их конец;
 *  - уже прошедшее и ушедшее за горизонт отбрасывается.
 */
export function buildReminders(input: ReminderInput): ReminderDraft[] {
  const settings = normalizeReminderSettings(input.settings);
  if (!settings.enabled) return [];

  const nowDate = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const from = nowMs + MIN_LEAD_MS;
  const until = nowMs + settings.horizonHours * 3_600_000;
  const today = localDate(nowDate);
  if (!today) return [];

  const days = daysInHorizon(today, until);
  const daySet = new Set(days);
  const quiet = quietRange(settings);
  const seen = new Set<string>();
  const out: ReminderDraft[] = [];
  const digest = new Map<string, string[]>();

  const push = (at: number, draft: Omit<ReminderDraft, 'at'>): void => {
    if (!Number.isFinite(at)) return;
    const shifted = shiftOutOfQuiet(at, quiet);
    if (shifted < from || shifted > until) return;
    if (seen.has(draft.tag)) return;
    seen.add(draft.tag);
    out.push({ ...draft, at: shifted, body: text(draft.body, MAX_BODY) });
  };

  const addToDigest = (iso: string, line: string): void => {
    if (!iso || !line) return;
    const list = digest.get(iso) ?? [];
    if (list.length < 8) list.push(line);
    digest.set(iso, list);
  };

  if (settings.events) {
    for (const event of input.events) {
      const date = validDate(event.date);
      if (!date || !daySet.has(date)) continue;
      const title = text(event.title, 120) || 'Событие';
      const minutes = timeToMinutes(event.time);
      if (event.allDay === true || minutes < 0) {
        addToDigest(date, `Событие: ${title}`);
        continue;
      }
      const start = atLocalDay(date, minutes);
      push(start - settings.leadMinutes * 60_000, {
        title,
        body: `${leadLabel(settings.leadMinutes)} · ${minutesLabel(minutes)}`,
        tag: `event:${event.id}:${date}`,
        kind: 'event',
        url: '#/calendar'
      });
    }
  }

  if (settings.tasks) {
    for (const task of input.tasks) {
      const title = text(task.title, 120);
      if (!title) continue;
      for (const date of days) {
        if (!taskOccursOn(task, date) || isTaskDone(task, date)) continue;
        const minutes = timeToMinutes(task.time);
        if (minutes < 0) {
          addToDigest(date, `Дело: ${title}`);
          continue;
        }
        push(atLocalDay(date, minutes), {
          title,
          body: text(task.notes, 180) || 'Пора сделать дело',
          tag: `task:${task.id}:${date}`,
          kind: 'task',
          url: '#/tasks'
        });
      }
    }
  }

  const digestMinutes = timeToMinutes(settings.digestTime);
  if (digestMinutes >= 0) {
    for (const date of days) {
      const lines = digest.get(date);
      if (!lines?.length) continue;
      const extra = lines.length > 6 ? ` · ещё ${lines.length - 6}` : '';
      push(atLocalDay(date, digestMinutes), {
        title: `${dayLabel(date, today)} · ${lines.length}`,
        body: `${lines.slice(0, 6).join(' · ')}${extra}`,
        tag: `digest:${date}`,
        kind: 'digest',
        url: '#/tasks'
      });
    }
  }

  out.sort((a, b) => (a.at === b.at ? a.tag.localeCompare(b.tag) : a.at - b.at));
  return out.slice(0, REMINDER_MAX_ITEMS);
}

/**
 * Превращает черновики в элементы плана для Firestore.
 *
 * Поля фиксированные и только строки: Firestore не принимает `undefined`,
 * а отправитель не должен ничего додумывать.
 */
export function toPlanItems(items: ReminderDraft[]): ReminderPlanItem[] {
  const out: ReminderPlanItem[] = [];
  for (const item of items) {
    const at = new Date(item.at);
    if (Number.isNaN(at.getTime())) continue;
    const tag = text(item.tag, 120);
    if (!tag) continue;
    out.push({
      key: tag,
      at: at.toISOString(),
      title: text(item.title, 120) || 'Наставник',
      body: text(item.body, MAX_BODY),
      tag,
      url: text(item.url, 200)
    });
  }
  return out;
}

/**
 * Отпечаток плана: по нему приложение понимает, что расписание не изменилось
 * и записывать документ в облако второй раз не нужно.
 */
export function planSignature(items: ReminderPlanItem[], leadMinutes = 0): string {
  return `${Math.max(0, Math.round(leadMinutes))}|${items.map((item) => `${item.key}@${item.at}`).join('|')}`;
}

/** Локальные «ЧЧ:ММ» произвольного момента. */
export function localTimeOf(value: Date | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** «Сегодня 14:00 · Созвон» — короткая подпись напоминания. */
export function reminderLabel(
  item: Pick<ReminderDraft, 'at' | 'title'>,
  now: Date | number = Date.now()
): string {
  const nowDate = now instanceof Date ? now : new Date(now);
  const at = new Date(item.at);
  if (Number.isNaN(at.getTime()) || Number.isNaN(nowDate.getTime())) return '';
  const label = dayLabel(localDate(at), localDate(nowDate));
  return `${label} ${localTimeOf(at)} · ${text(item.title, 60)}`;
}

/** Подпись настроек — для карточки в «Настройках». */
export function remindersSummary(settings: ReminderSettings | null | undefined): string {
  const s = normalizeReminderSettings(settings);
  if (!s.events && !s.tasks) return 'выключены';
  const parts: string[] = [];
  if (s.events) parts.push('события');
  if (s.tasks) parts.push('дела');
  const lead = s.leadMinutes > 0 ? `за ${s.leadMinutes} мин` : 'в момент начала';
  return `${parts.join(' и ')} · ${lead}`;
}

/** Минуты от полуночи для «ЧЧ:ММ»; -1 — пусто или неверно. */
function timeToMinutes(value: unknown): number {
  const time = validTime(value);
  if (!time) return -1;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Локальные минуты от полуночи для момента времени. */
function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Абсолютная метка локального дня `iso` + минуты от его полуночи. */
function atLocalDay(iso: string, minutes: number): number {
  const date = validDate(iso);
  if (!date || minutes < 0) return NaN;
  const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return d.getTime() + minutes * 60_000;
}

/** «09:05» из минут от полуночи. */
function minutesLabel(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** «через 15 минут», «через час», «сейчас» — подпись для тела уведомления. */
export function leadLabel(minutes: number): string {
  const value = Math.max(0, Math.round(minutes || 0));
  if (value === 0) return 'сейчас';
  if (value < 60) return `через ${value} мин`;
  if (value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? 'через час' : `через ${hours} ч`;
  }
  return `через ${Math.floor(value / 60)} ч ${value % 60} мин`;
}

/**
 * Приводит сохранённые настройки к безопасному виду. Отсутствующее поле
 * берёт значение по умолчанию, явно пустое — остаётся пустым (так отключают
 * сводку или тихие часы).
 */
export function normalizeReminderSettings(
  raw: ReminderSettings | Partial<ReminderSettings> | null | undefined
): ReminderSettings {
  const src = (raw ?? {}) as Partial<ReminderSettings>;
  const lead = Number(src.leadMinutes);
  const horizon = Number(src.horizonHours);
  const digestSource = src.digestTime === undefined ? DEFAULT_REMINDERS.digestTime : src.digestTime;
  const quietFromSource = src.quietFrom === undefined ? DEFAULT_REMINDERS.quietFrom : src.quietFrom;
  const quietToSource = src.quietTo === undefined ? DEFAULT_REMINDERS.quietTo : src.quietTo;
  const quietFrom = validTime(quietFromSource);
  const quietTo = validTime(quietToSource);
  const quietOk = Boolean(quietFrom && quietTo && quietFrom !== quietTo);
  return {
    enabled: src.enabled === true,
    events: src.events !== false,
    tasks: src.tasks !== false,
    leadMinutes: Number.isFinite(lead)
      ? Math.min(Math.max(Math.round(lead), 0), 720)
      : DEFAULT_REMINDERS.leadMinutes,
    digestTime: validTime(digestSource),
    quietFrom: quietOk ? quietFrom : '',
    quietTo: quietOk ? quietTo : '',
    horizonHours: Number.isFinite(horizon)
      ? Math.min(Math.max(Math.round(horizon), 6), 336)
      : DEFAULT_REMINDERS.horizonHours
  };
}

interface QuietRange {
  from: number;
  to: number;
}

function quietRange(settings: ReminderSettings): QuietRange | null {
  const from = timeToMinutes(settings.quietFrom);
  const to = timeToMinutes(settings.quietTo);
  if (from < 0 || to < 0 || from === to) return null;
  return { from, to };
}

function insideQuiet(minutes: number, quiet: QuietRange): boolean {
  return quiet.from < quiet.to
    ? minutes >= quiet.from && minutes < quiet.to
    : minutes >= quiet.from || minutes < quiet.to;
}

/**
 * Сдвигает напоминание из тихих часов на их конец. Если сдвиг не нужен —
 * возвращает исходный момент. Так ночные дела не будят, а ждут утра.
 */
function shiftOutOfQuiet(ms: number, quiet: QuietRange | null): number {
  if (!quiet) return ms;
  const minutes = minutesOfDay(ms);
  if (!insideQuiet(minutes, quiet)) return ms;
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  // «22:00–08:00» и любой переход через полночь: конец окна — на следующем дне.
  if (quiet.from > quiet.to && minutes >= quiet.from) day.setDate(day.getDate() + 1);
  return day.getTime() + quiet.to * 60_000;
}

/** «Сегодня», «Завтра» или «28.11» для заголовка сводки. */
function dayLabel(iso: string, today: string): string {
  if (iso === today) return 'Сегодня';
  if (iso === addDaysIso(today, 1)) return 'Завтра';
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/** Все локальные даты, которые попадают в горизонт планирования. */
function daysInHorizon(today: string, untilMs: number): string[] {
  const days: string[] = [];
  let iso = today;
  // 336 часов — максимум 15 дней; +2 дня запаса на переходы и часовые пояса.
  for (let i = 0; i < 18 && iso; i += 1) {
    days.push(iso);
    const dayEnd = atLocalDay(iso, 24 * 60 - 1);
    if (!Number.isFinite(dayEnd) || dayEnd > untilMs) break;
    iso = addDaysIso(iso, 1);
  }
  return days;
}
