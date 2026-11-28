import Dexie, { type Table, type Transaction } from 'dexie';
import type { ConnMode } from '../api/conn';
import { notifyLocalChange } from '../sync/signal';
import { now, uid } from '../utils/ids';
import { toPlainValue } from '../utils/plain';
import {
  AI_MAX_NOTES,
  AI_MAX_TITLE,
  text,
  todayIso,
  validDate,
  validTime
} from '../utils/planner';
import { DEFAULT_REMINDERS, type ReminderSettings } from '../utils/reminders';
import {
  SEED_CATEGORIES,
  normalizeAccount,
  normalizeAsset,
  normalizeBudget,
  normalizeCategory,
  normalizeObligation,
  normalizeSnapshot,
  normalizeTransaction,
  netWorth,
  validMonth,
  type AccountData,
  type AccountKind,
  type AssetData,
  type AssetKind,
  type BudgetData,
  type CategoryData,
  type CategoryGroup,
  type CategoryKind,
  type Frequency,
  type ObligationData,
  type ObligationKind,
  type SnapshotData,
  type TransactionData,
  type TransactionType
} from '../utils/budget';
import {
  TASK_MAX_NOTES,
  TASK_MAX_TITLE,
  compareTasks,
  normalizeDoneDates,
  normalizeDays,
  withTaskDone
} from '../utils/tasks';

export type Level = 'новичок' | 'средний' | 'продвинутый';
export type ItemKind = 'theory' | 'practice' | 'check';
export type TopicStatus = 'active' | 'paused' | 'done';
export type Effort = 'low' | 'high' | 'max';
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 0 — запись совпадает с облаком, 1 — ждёт отправки. */
export type DirtyFlag = 0 | 1;

/** Сущности, которые зеркалятся в Firestore. */
export type SyncEntity =
  | 'topic'
  | 'plan'
  | 'message'
  | 'note'
  | 'memory'
  | 'profile'
  | 'event'
  | 'task'
  | 'account'
  | 'category'
  | 'transaction'
  | 'budget'
  | 'obligation'
  | 'asset'
  | 'snapshot';

/** Надгробие: удаление, которое ещё нужно протолкнуть в облако. */
export interface Tombstone {
  /** `${type}:${refId}` — уникальный ключ в локальной таблице. */
  id: string;
  type: SyncEntity;
  refId: string;
  deletedAt: number;
  dirty: DirtyFlag;
}

export interface Citation {
  url: string;
  title?: string;
  site?: string;
}

export interface PlanItem {
  id: string;
  title: string;
  kind: ItemKind;
  estMin: number;
  done: boolean;
}

export interface PlanModule {
  id: string;
  title: string;
  goal?: string;
  items: PlanItem[];
}

export interface Topic {
  id: string;
  title: string;
  goal: string;
  level: Level;
  hoursPerWeek: number;
  status: TopicStatus;
  createdAt: number;
  updatedAt: number;
  /** 1 — запись изменена локально и ещё не ушла в облако. */
  dirty: DirtyFlag;
}

export interface Plan {
  id: string;
  topicId: string;
  title: string;
  summary?: string;
  modules: PlanModule[];
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

export interface StoredMessage {
  id: string;
  topicId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  citations?: Citation[];
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

export interface Note {
  id: string;
  topicId?: string;
  title: string;
  md: string;
  source: 'chat' | 'book' | 'web' | 'manual';
  tags: string[];
  citations?: Citation[];
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/**
 * Событие календаря. Дата и время хранятся строками, а не timestamp:
 * «весь день» не имеет времени, а локальная дата «ГГГГ-ММ-ДД» не съезжает
 * на день назад в часовых поясах западнее UTC.
 */
export interface PlannerEvent {
  id: string;
  title: string;
  /** Локальная дата «ГГГГ-ММ-ДД». */
  date: string;
  /** «ЧЧ:ММ»; пустая строка — событие на весь день. */
  time: string;
  endTime: string;
  allDay: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/**
 * Дело — повторяющаяся задача. Расписание задаётся либо днями недели
 * (`days`, 0 — понедельник), либо одной датой (`onceDate`). Отметки
 * хранятся массивом дат: дело не «выполнено навсегда», а выполнено
 * в конкретный день, поэтому `done` — не флаг, а история.
 */
export interface PlannerTask {
  id: string;
  title: string;
  notes: string;
  /** Дни недели: 0 — понедельник … 6 — воскресенье. Пусто у разового дела. */
  days: number[];
  /** «ГГГГ-ММ-ДД» для разового дела; пусто при повторе. */
  onceDate: string;
  /** «ЧЧ:ММ» или пустая строка. */
  time: string;
  /** Даты «ГГГГ-ММ-ДД», когда дело отмечено выполненным. */
  done: string[];
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Счёт, на котором лежат деньги. Остаток не хранится: он считается по операциям. */
export interface MoneyAccount extends AccountData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Категория дохода или расхода. `essential` — обязательные траты для резерва. */
export interface BudgetCategory extends CategoryData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/**
 * Операция журнала. Перевод (`transfer`) живёт между двумя счетами, не входит
 * в доход и расход и не имеет категории — это проверяет `normalizeTransaction`.
 */
export interface BudgetTransaction extends TransactionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Бюджет месяца: `id` — сам месяц «ГГГГ-ММ», один документ на месяц. */
export interface MonthBudget extends BudgetData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Регулярный платёж: аренда, подписка, кредит или долг знакомому. */
export interface BudgetObligation extends ObligationData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Актив или пассив. У пассива `value` — остаток долга, а не стоимость. */
export interface BudgetAsset extends AssetData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Снимок нетто-капитала: один на дату, `id` — дата «ГГГГ-ММ-ДД». */
export interface BudgetSnapshot extends SnapshotData {
  id: string;
  createdAt: number;
  updatedAt: number;
  dirty: DirtyFlag;
}

/** Сжатая память наставника по теме (раньше лежала в kv как memory:<id>). */
export interface MemoryRow {
  topicId: string;
  text: string;
  updatedAt: number;
  dirty: DirtyFlag;
}

export interface AppSettings {
  /** `direct` — ключ DeepSeek в этом браузере; `proxy` — запросы через воркер. */
  mode: ConnMode;
  proxyUrl: string;
  appToken: string;
  /** Ключ DeepSeek для прямого режима. В облако не уходит. */
  deepseekKey: string;
  model: string;
  effort: Effort;
  webSearch: boolean;
  theme: ThemeMode;
  /** Напоминания о событиях и делах: push отправляет прокси-воркер. */
  reminders: ReminderSettings;
}

export interface Profile {
  name?: string;
  occupation?: string;
  level?: Level;
  goals: string[];
  interests: string[];
  preferredStyle?: string;
  updatedAt: number;
}

export interface KvRow {
  key: string;
  value: unknown;
  /** Служебные ключи (profile) синхронизируются — они помечаются к отправке. */
  dirty?: DirtyFlag;
}

export const DEFAULT_PROFILE: Profile = { goals: [], interests: [], updatedAt: 0 };

/** Версия схемы; растёт вместе с миграциями в StudyDB. */
export const SCHEMA_VERSION = 5;

function backfillV2(row: { createdAt?: number; updatedAt?: number; dirty?: DirtyFlag }, stamp: number): void {
  row.updatedAt = row.updatedAt ?? row.createdAt ?? stamp;
  row.dirty = 1;
}

/** v1 → v2: память переезжает в отдельную таблицу, всё локальное уходит в очередь на отправку. */
async function migrateToV2(tx: Transaction): Promise<void> {
  const stamp = now();
  const kv = tx.table('kv');
  const memory = tx.table('memory');
  const legacy = (await kv.toArray()) as Array<{ key: string; value: unknown }>;

  for (const row of legacy) {
    if (typeof row.key === 'string' && row.key.startsWith('memory:')) {
      await memory.put({
        topicId: row.key.slice('memory:'.length),
        text: String(row.value ?? ''),
        updatedAt: stamp,
        dirty: 1
      });
      await kv.delete(row.key);
    }
  }

  await kv.toCollection().modify((row: KvRow) => {
    if (row.key === 'profile') row.dirty = 1;
  });

  for (const name of ['topics', 'plans', 'messages', 'notes'] as const) {
    await tx
      .table(name)
      .toCollection()
      .modify((row: { createdAt?: number; updatedAt?: number; dirty?: DirtyFlag }) => backfillV2(row, stamp));
  }
}

class StudyDB extends Dexie {
  topics!: Table<Topic, string>;
  plans!: Table<Plan, string>;
  messages!: Table<StoredMessage, string>;
  notes!: Table<Note, string>;
  memory!: Table<MemoryRow, string>;
  events!: Table<PlannerEvent, string>;
  tasks!: Table<PlannerTask, string>;
  accounts!: Table<MoneyAccount, string>;
  categories!: Table<BudgetCategory, string>;
  transactions!: Table<BudgetTransaction, string>;
  budgets!: Table<MonthBudget, string>;
  obligations!: Table<BudgetObligation, string>;
  assets!: Table<BudgetAsset, string>;
  snapshots!: Table<BudgetSnapshot, string>;
  kv!: Table<KvRow, string>;
  tombstones!: Table<Tombstone, string>;

  constructor() {
    super('study-mentor');
    this.version(1).stores({
      topics: 'id, updatedAt, status',
      plans: 'id, topicId',
      messages: 'id, topicId, createdAt',
      notes: 'id, topicId, createdAt',
      kv: 'key'
    });
    this.version(2)
      .stores({
        topics: 'id, updatedAt, status, dirty',
        plans: 'id, topicId, updatedAt, dirty',
        messages: 'id, topicId, createdAt, updatedAt, dirty',
        notes: 'id, topicId, createdAt, updatedAt, dirty',
        memory: 'topicId, updatedAt, dirty',
        kv: 'key, dirty',
        tombstones: 'id, type, dirty'
      })
      .upgrade((tx) => migrateToV2(tx));

    // v3: календарь. Новая таблица создаётся сама, данные v2 не трогаем.
    this.version(3).stores({
      events: 'id, date, updatedAt, dirty'
    });

    // v4: дела с повтором по дням недели. Тоже только новая таблица.
    this.version(4).stores({
      tasks: 'id, updatedAt, dirty'
    });

    // v5: бюджет. Семь новых таблиц; справочник категорий сеется при открытии
    // раздела (`ensureBudgetDefaults`), поэтому старые данные не нужны.
    // Булевы поля в индексы не ставим: IndexedDB не принимает true/false как ключ.
    this.version(5).stores({
      accounts: 'id, order, updatedAt, dirty',
      categories: 'id, kind, order, updatedAt, dirty',
      transactions: 'id, date, accountId, categoryId, obligationId, updatedAt, dirty',
      budgets: 'id, updatedAt, dirty',
      obligations: 'id, dueDay, updatedAt, dirty',
      assets: 'id, kind, updatedAt, dirty',
      snapshots: 'id, date, updatedAt, dirty'
    });
  }
}

export const db = new StudyDB();

export const DEFAULT_SETTINGS: AppSettings = {
  // Прямой доступ по умолчанию: ключ вводится в «Настройках», воркер не нужен.
  mode: 'direct',
  proxyUrl: (import.meta.env.VITE_DEFAULT_PROXY_URL as string | undefined) ?? '',
  appToken: '',
  deepseekKey: '',
  model: 'deepseek-flash',
  effort: 'high',
  webSearch: true,
  theme: 'auto',
  reminders: { ...DEFAULT_REMINDERS }
};

export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return (row?.value as T) ?? fallback;
}

/**
 * Запись в kv. `sync: true` помечает ключ к отправке в облако —
 * используйте только для profile, настройки устройства остаются локальными.
 *
 * Значение обязательно прогоняется через `toPlainValue`: IndexedDB клонирует
 * данные структурным клонированием, а оно не принимает Proxy из `$state`
 * (иначе `DataCloneError` и молчаливая потеря настроек).
 */
export async function setKv(key: string, value: unknown, opts?: { sync?: boolean }): Promise<void> {
  const row: KvRow = { key, value: toPlainValue(value) };
  if (opts?.sync) row.dirty = 1;
  await db.kv.put(row);
  if (opts?.sync) notifyLocalChange();
}

/** Память наставника по теме. */
export async function getMemory(topicId: string): Promise<string> {
  const row = await db.memory.get(topicId);
  return row?.text ?? '';
}

export async function setMemory(topicId: string, text: string): Promise<void> {
  await db.memory.put({ topicId, text, updatedAt: now(), dirty: 1 });
  notifyLocalChange();
}

export function tombstoneOf(type: SyncEntity, refId: string, deletedAt = now()): Tombstone {
  return { id: `${type}:${refId}`, type, refId, deletedAt, dirty: 1 };
}

/** Сколько записей и надгробий ещё не отправлено в облако. */
export async function countPending(): Promise<number> {
  const counts = await Promise.all([
    db.topics.where('dirty').equals(1).count(),
    db.plans.where('dirty').equals(1).count(),
    db.messages.where('dirty').equals(1).count(),
    db.notes.where('dirty').equals(1).count(),
    db.memory.where('dirty').equals(1).count(),
    db.events.where('dirty').equals(1).count(),
    db.tasks.where('dirty').equals(1).count(),
    db.accounts.where('dirty').equals(1).count(),
    db.categories.where('dirty').equals(1).count(),
    db.transactions.where('dirty').equals(1).count(),
    db.budgets.where('dirty').equals(1).count(),
    db.obligations.where('dirty').equals(1).count(),
    db.assets.where('dirty').equals(1).count(),
    db.snapshots.where('dirty').equals(1).count(),
    db.kv.where('dirty').equals(1).count(),
    db.tombstones.where('dirty').equals(1).count()
  ]);
  return counts.reduce((acc, n) => acc + n, 0);
}

/** Прогресс плана: сколько пунктов выполнено. */
export function planProgress(plan?: Plan): { done: number; total: number; pct: number } {
  if (!plan) return { done: 0, total: 0, pct: 0 };
  let done = 0;
  let total = 0;
  for (const m of plan.modules) {
    for (const i of m.items) {
      total += 1;
      if (i.done) done += 1;
    }
  }
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface NewTopicInput {
  title: string;
  goal: string;
  level: Level;
  hoursPerWeek: number;
}

export async function createTopic(input: NewTopicInput): Promise<Topic> {
  const ts = now();
  const topic: Topic = {
    id: uid('t'),
    title: input.title.trim(),
    goal: input.goal.trim(),
    level: input.level,
    hoursPerWeek: input.hoursPerWeek,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.topics.add(topic);
  notifyLocalChange();
  return topic;
}

export interface PlanDraft {
  title?: string;
  summary?: string;
  modules: Array<{
    title: string;
    goal?: string;
    items: Array<{ title: string; kind: ItemKind; estMin?: number }>;
  }>;
}

export async function savePlan(topicId: string, draft: PlanDraft): Promise<Plan> {
  const ts = now();
  const plan: Plan = {
    id: uid('p'),
    topicId,
    title: draft.title?.trim() || 'План обучения',
    summary: draft.summary?.trim(),
    modules: draft.modules.map((m) => ({
      id: uid('m'),
      title: m.title.trim(),
      goal: m.goal?.trim(),
      items: m.items.map((i) => ({
        id: uid('i'),
        title: i.title.trim(),
        kind: i.kind,
        estMin: i.estMin ?? (i.kind === 'theory' ? 25 : 40),
        done: false
      }))
    })),
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.transaction('rw', [db.plans, db.topics, db.tombstones], async () => {
    // План заменяется целиком: старый документ нужно удалить и в облаке.
    const oldIds = (await db.plans.where('topicId').equals(topicId).primaryKeys()) as string[];
    if (oldIds.length > 0) {
      await db.tombstones.bulkPut(oldIds.map((id) => tombstoneOf('plan', id, ts)));
      await db.plans.bulkDelete(oldIds);
    }
    await db.plans.add(plan);
    await db.topics.update(topicId, { updatedAt: ts, dirty: 1 });
  });
  notifyLocalChange();
  return plan;
}

export async function getPlan(topicId: string): Promise<Plan | undefined> {
  return db.plans.where('topicId').equals(topicId).first();
}

export async function togglePlanItem(
  planId: string,
  moduleId: string,
  itemId: string
): Promise<Plan | undefined> {
  const plan = await db.plans.get(planId);
  if (!plan) return undefined;
  const mod = plan.modules.find((m) => m.id === moduleId);
  const item = mod?.items.find((i) => i.id === itemId);
  if (!mod || !item) return plan;
  const ts = now();
  item.done = !item.done;
  plan.updatedAt = ts;
  plan.dirty = 1;
  await db.transaction('rw', [db.plans, db.topics], async () => {
    await db.plans.put(plan);
    await db.topics.update(plan.topicId, { updatedAt: ts, dirty: 1 });
  });
  notifyLocalChange();
  return plan;
}

export async function addMessage(
  msg: Omit<StoredMessage, 'id' | 'createdAt' | 'updatedAt' | 'dirty'> & { id?: string }
): Promise<StoredMessage> {
  const ts = now();
  const row: StoredMessage = {
    id: msg.id ?? uid('msg'),
    topicId: msg.topicId,
    role: msg.role,
    content: msg.content,
    reasoning: msg.reasoning,
    citations: msg.citations,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.messages.add(row);
  notifyLocalChange();
  return row;
}

export async function addNote(
  note: Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'dirty'> & { id?: string }
): Promise<Note> {
  const ts = now();
  const row: Note = {
    id: note.id ?? uid('n'),
    topicId: note.topicId,
    title: note.title,
    md: note.md,
    source: note.source,
    tags: note.tags ?? [],
    // Структурное клонирование IndexedDB не принимает Proxy из `$state`.
    citations: note.citations ? toPlainValue(note.citations) : note.citations,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.notes.add(row);
  notifyLocalChange();
  return row;
}

/**
 * Обновление заметки на месте: используется, когда конспект пункта плана
 * пересобирают — вместо дубля перезаписываем существующую запись.
 */
export async function updateNote(
  noteId: string,
  patch: Partial<Pick<Note, 'title' | 'md' | 'tags' | 'citations'>>
): Promise<Note | undefined> {
  const existing = await db.notes.get(noteId);
  if (!existing) return undefined;
  const row: Note = {
    ...existing,
    ...patch,
    // Структурное клонирование IndexedDB не принимает Proxy из `$state`.
    citations: patch.citations ? toPlainValue(patch.citations) : existing.citations,
    updatedAt: now(),
    dirty: 1
  };
  await db.notes.put(row);
  notifyLocalChange();
  return row;
}

/** Удаление заметки: локально + надгробие, чтобы не «воскресла» из облака. */
export async function removeNote(noteId: string): Promise<void> {
  const ts = now();
  await db.transaction('rw', [db.notes, db.tombstones], async () => {
    const note = await db.notes.get(noteId);
    await db.notes.delete(noteId);
    if (note) await db.tombstones.put(tombstoneOf('note', noteId, ts));
  });
  notifyLocalChange();
}

/** Удаление темы вместе с планом, чатом, конспектами и памятью. */
export async function removeTopic(topicId: string): Promise<void> {
  const ts = now();
  await db.transaction(
    'rw',
    [db.topics, db.plans, db.messages, db.notes, db.memory, db.tombstones],
    async () => {
      const planIds = (await db.plans.where('topicId').equals(topicId).primaryKeys()) as string[];
      const messageIds = (await db.messages.where('topicId').equals(topicId).primaryKeys()) as string[];
      const noteIds = (await db.notes.where('topicId').equals(topicId).primaryKeys()) as string[];
      const hasMemory = Boolean(await db.memory.get(topicId));

      await db.topics.delete(topicId);
      await db.plans.where('topicId').equals(topicId).delete();
      await db.messages.where('topicId').equals(topicId).delete();
      await db.notes.where('topicId').equals(topicId).delete();
      await db.memory.delete(topicId);

      const rows: Tombstone[] = [
        tombstoneOf('topic', topicId, ts),
        ...planIds.map((id) => tombstoneOf('plan', id, ts)),
        ...messageIds.map((id) => tombstoneOf('message', id, ts)),
        ...noteIds.map((id) => tombstoneOf('note', id, ts))
      ];
      if (hasMemory) rows.push(tombstoneOf('memory', topicId, ts));
      await db.tombstones.bulkPut(rows);
    }
  );
  notifyLocalChange();
}

/* ---------------------------------------------------------------- календарь */

export interface NewEventInput {
  id?: string;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  allDay?: boolean;
  notes?: string;
}

/** Приводит событие к безопасному виду: без даты событие не существует. */
function normalizeEventFields(input: {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  allDay?: boolean;
  notes?: string;
}): Pick<PlannerEvent, 'title' | 'date' | 'time' | 'endTime' | 'allDay' | 'notes'> {
  const title = text(input.title, AI_MAX_TITLE);
  const date = validDate(input.date);
  if (!title) throw new Error('У события должно быть название');
  if (!date) throw new Error('У события должна быть корректная дата');
  const time = validTime(input.time);
  const allDay = input.allDay === true || !time;
  const endTime = allDay ? '' : validTime(input.endTime);
  return {
    title,
    date,
    time: allDay ? '' : time,
    endTime: endTime && endTime > time ? endTime : '',
    allDay,
    notes: text(input.notes, AI_MAX_NOTES)
  };
}

export async function addEvent(input: NewEventInput): Promise<PlannerEvent> {
  const ts = now();
  const event: PlannerEvent = {
    id: input.id ?? uid('ev'),
    ...normalizeEventFields(input),
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.events.add(event);
  notifyLocalChange();
  return event;
}

export async function updateEvent(
  id: string,
  patch: Partial<Pick<PlannerEvent, 'title' | 'date' | 'time' | 'endTime' | 'allDay' | 'notes'>>
): Promise<PlannerEvent | undefined> {
  const existing = await db.events.get(id);
  if (!existing) return undefined;
  const merged = normalizeEventFields({
    title: patch.title ?? existing.title,
    date: patch.date ?? existing.date,
    time: patch.time ?? existing.time,
    endTime: patch.endTime ?? existing.endTime,
    allDay: patch.allDay ?? existing.allDay,
    notes: patch.notes ?? existing.notes
  });
  const row: PlannerEvent = { ...existing, ...merged, updatedAt: now(), dirty: 1 };
  await db.events.put(row);
  notifyLocalChange();
  return row;
}

/** Удаление события: локально + надгробие, чтобы не «воскресло» из облака. */
export async function removeEvent(id: string): Promise<void> {
  const ts = now();
  await db.transaction('rw', [db.events, db.tombstones], async () => {
    const event = await db.events.get(id);
    await db.events.delete(id);
    if (event) await db.tombstones.put(tombstoneOf('event', id, ts));
  });
  notifyLocalChange();
}

/** События за период включительно; границы — локальные даты «ГГГГ-ММ-ДД». */
export async function eventsBetween(fromIso: string, toIso: string): Promise<PlannerEvent[]> {
  const rows = await db.events.where('date').between(fromIso, toIso, true, true).toArray();
  return rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export async function allEvents(): Promise<PlannerEvent[]> {
  const rows = await db.events.toArray();
  return rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/* --------------------------------------------------------------------- дела */

export interface TaskInput {
  id?: string;
  title: string;
  notes?: string;
  /** Дни недели: 0 — понедельник … 6 — воскресенье. */
  days?: number[];
  /** Разовая дата «ГГГГ-ММ-ДД»; при ней дни недели игнорируются. */
  onceDate?: string;
  time?: string;
}

/** Приводит дело к безопасному виду: без расписания дело не имеет смысла. */
function normalizeTaskFields(
  input: TaskInput
): Pick<PlannerTask, 'title' | 'notes' | 'days' | 'onceDate' | 'time'> {
  const title = text(input.title, TASK_MAX_TITLE);
  if (!title) throw new Error('У дела должно быть название');
  const onceDate = validDate(input.onceDate);
  const days = onceDate ? [] : normalizeDays(input.days);
  if (!onceDate && days.length === 0) {
    throw new Error('Выберите хотя бы один день недели или дату');
  }
  return {
    title,
    notes: text(input.notes, TASK_MAX_NOTES),
    days,
    onceDate,
    time: validTime(input.time)
  };
}

export async function addTask(input: TaskInput): Promise<PlannerTask> {
  const ts = now();
  const task: PlannerTask = {
    id: input.id ?? uid('task'),
    ...normalizeTaskFields(input),
    done: [],
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.tasks.add(task);
  notifyLocalChange();
  return task;
}

export async function updateTask(
  id: string,
  patch: Partial<TaskInput>
): Promise<PlannerTask | undefined> {
  const existing = await db.tasks.get(id);
  if (!existing) return undefined;
  const merged = normalizeTaskFields({
    title: patch.title ?? existing.title,
    notes: patch.notes ?? existing.notes,
    days: patch.days ?? existing.days,
    onceDate: patch.onceDate ?? existing.onceDate,
    time: patch.time ?? existing.time
  });
  const row: PlannerTask = {
    ...existing,
    ...merged,
    // Смена расписания не должна стирать историю отметок.
    done: normalizeDoneDates(existing.done),
    updatedAt: now(),
    dirty: 1
  };
  await db.tasks.put(row);
  notifyLocalChange();
  return row;
}

/** Удаление дела: локально + надгробие, чтобы не «воскресло» из облака. */
export async function removeTask(id: string): Promise<void> {
  const ts = now();
  await db.transaction('rw', [db.tasks, db.tombstones], async () => {
    const task = await db.tasks.get(id);
    await db.tasks.delete(id);
    if (task) await db.tombstones.put(tombstoneOf('task', id, ts));
  });
  notifyLocalChange();
}

/** Отметка «сделано» за конкретный день. */
export async function toggleTaskDone(
  id: string,
  dateIso: string,
  done?: boolean
): Promise<PlannerTask | undefined> {
  const existing = await db.tasks.get(id);
  if (!existing) return undefined;
  const next = withTaskDone(existing, dateIso, done ?? !existing.done.includes(dateIso));
  const row: PlannerTask = {
    ...next,
    done: normalizeDoneDates(next.done),
    updatedAt: now(),
    dirty: 1
  };
  await db.tasks.put(row);
  notifyLocalChange();
  return row;
}

export async function allTasks(): Promise<PlannerTask[]> {
  const rows = await db.tasks.toArray();
  return rows.sort(compareTasks);
}

/**
 * Пачка изменений от ИИ или импорта: записать/удалить события одной транзакцией.
 * `restore` снимает надгробия — это нужно кнопке «Отменить» после удаления.
 */
export interface EventChanges {
  put: PlannerEvent[];
  remove: string[];
  /** id, у которых нужно снять надгробие (отмена удаления). */
  restore?: string[];
}

export interface TaskChanges {
  put: PlannerTask[];
  remove: string[];
  restore?: string[];
}

/**
 * Пачка изменений от ИИ, импорта или кнопки «Отменить»: события и дела
 * пишутся одной транзакцией. `restore` снимает надгробия, а все строки
 * помечаются `dirty` — иначе облако вернёт отменённую правку обратно.
 */
export async function applyPlannerChanges(changes: {
  events?: EventChanges;
  tasks?: TaskChanges;
}): Promise<void> {
  const ts = now();
  const events = changes.events;
  const tasks = changes.tasks;
  await db.transaction('rw', [db.events, db.tasks, db.tombstones], async () => {
    if (events && events.put.length > 0) {
      await db.events.bulkPut(
        events.put.map((row) =>
          toPlainValue({
            ...row,
            updatedAt: Math.max(row.updatedAt, ts),
            dirty: 1
          })
        )
      );
    }
    if (events && events.remove.length > 0) {
      await db.events.bulkDelete(events.remove);
      await db.tombstones.bulkPut(events.remove.map((id) => tombstoneOf('event', id, ts)));
    }
    if (events?.restore && events.restore.length > 0) {
      await db.tombstones.bulkDelete(events.restore.map((id) => `event:${id}`));
    }
    if (tasks && tasks.put.length > 0) {
      await db.tasks.bulkPut(
        tasks.put.map((row) =>
          toPlainValue({
            ...row,
            // Массивы приходят из ответа модели и из отмены — чистим оба.
            days: normalizeDays(row.days),
            done: normalizeDoneDates(row.done),
            updatedAt: Math.max(row.updatedAt, ts),
            dirty: 1
          })
        )
      );
    }
    if (tasks && tasks.remove.length > 0) {
      await db.tasks.bulkDelete(tasks.remove);
      await db.tombstones.bulkPut(tasks.remove.map((id) => tombstoneOf('task', id, ts)));
    }
    if (tasks?.restore && tasks.restore.length > 0) {
      await db.tombstones.bulkDelete(tasks.restore.map((id) => `task:${id}`));
    }
  });
  notifyLocalChange();
}

/* -------------------------------------------------------------------- бюджет */

/**
 * Стартовый справочник категорий. Вызывается при открытии раздела «Бюджет»:
 * на новой базе таблица пустая, на старой — заполняется один раз.
 * Фиксированные id делают сид идемпотентным.
 */
export async function ensureBudgetDefaults(): Promise<void> {
  const count = await db.categories.count();
  if (count > 0) return;
  const ts = now();
  const rows: BudgetCategory[] = SEED_CATEGORIES.map((item) => ({
    id: item.id,
    ...normalizeCategory(item),
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  }));
  await db.categories.bulkPut(rows);
  notifyLocalChange();
}

export interface AccountInput extends Partial<AccountData> {
  id?: string;
}

/** Счета: неудалённые раньше архивированных, внутри — по порядку и названию. */
export async function allAccounts(): Promise<MoneyAccount[]> {
  const rows = await db.accounts.toArray();
  return rows.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, 'ru');
  });
}

export async function addAccount(input: AccountInput = {}): Promise<MoneyAccount> {
  const ts = now();
  const data = normalizeAccount(input);
  const rows = await db.accounts.toArray();
  const maxOrder = rows.reduce((max, row) => Math.max(max, row.order), 0);
  const account: MoneyAccount = {
    id: input.id ?? uid('acc'),
    ...data,
    order: data.order || maxOrder + 10,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.accounts.add(account);
  notifyLocalChange();
  return account;
}

export async function updateAccount(
  id: string,
  patch: Partial<AccountData>
): Promise<MoneyAccount | undefined> {
  const existing = await db.accounts.get(id);
  if (!existing) return undefined;
  const row: MoneyAccount = {
    ...existing,
    ...normalizeAccount({ ...existing, ...patch }),
    updatedAt: now(),
    dirty: 1
  };
  await db.accounts.put(row);
  notifyLocalChange();
  return row;
}

/** Архив вместо удаления: история операций счёта остаётся на месте. */
export async function archiveAccount(id: string, archived = true): Promise<MoneyAccount | undefined> {
  return updateAccount(id, { archived });
}

/**
 * Удалить счёт можно только пустым: иначе операции потеряют остаток, а
 * баланс перестанет сходиться. Для «закрытых» счетов есть архив.
 */
export async function removeAccount(id: string): Promise<void> {
  const out = await db.transactions.where('accountId').equals(id).count();
  const incoming = await db.transactions.filter((tx) => tx.toAccountId === id).count();
  if (out + incoming > 0) {
    throw new Error('По счёту есть операции — перенесите их или отправьте счёт в архив');
  }
  await db.transaction('rw', [db.accounts, db.obligations, db.tombstones], async () => {
    const used = await db.obligations.filter((row) => row.accountId === id).count();
    if (used > 0) throw new Error('Счёт указан в обязательствах — сначала поменяйте его там');
    const row = await db.accounts.get(id);
    await db.accounts.delete(id);
    if (row) await db.tombstones.put(tombstoneOf('account', id, now()));
  });
  notifyLocalChange();
}

export async function allCategories(): Promise<BudgetCategory[]> {
  const rows = await db.categories.toArray();
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'income' ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, 'ru');
  });
}

export interface CategoryInput extends Partial<CategoryData> {
  id?: string;
  title?: string;
  kind?: CategoryKind;
  group?: CategoryGroup;
}

export async function addCategory(input: CategoryInput): Promise<BudgetCategory> {
  const title = text(input.title, 80);
  if (!title) throw new Error('У категории должно быть название');
  const ts = now();
  const data = normalizeCategory({ ...input, title });
  const rows = await db.categories.toArray();
  const maxOrder = rows
    .filter((row) => row.kind === data.kind)
    .reduce((max, row) => Math.max(max, row.order), 0);
  const category: BudgetCategory = {
    id: input.id ?? uid('cat'),
    ...data,
    order: data.order || maxOrder + 10,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.categories.add(category);
  notifyLocalChange();
  return category;
}

export async function updateCategory(
  id: string,
  patch: Partial<CategoryData>
): Promise<BudgetCategory | undefined> {
  const existing = await db.categories.get(id);
  if (!existing) return undefined;
  const row: BudgetCategory = {
    ...existing,
    ...normalizeCategory({ ...existing, ...patch }),
    updatedAt: now(),
    dirty: 1
  };
  await db.categories.put(row);
  notifyLocalChange();
  return row;
}

/** Удаляем только неиспользованную категорию: иначе архив. */
export async function removeCategory(id: string): Promise<void> {
  const used = await db.transactions.where('categoryId').equals(id).count();
  const obligations = await db.obligations.filter((row) => row.categoryId === id).count();
  const budgets = await db.budgets.toArray();
  const planned = budgets.filter((row) => row.lines.some((line) => line.categoryId === id)).length;
  if (used + obligations + planned > 0) {
    throw new Error('Категория уже используется — отправьте её в архив');
  }
  await db.transaction('rw', [db.categories, db.tombstones], async () => {
    const row = await db.categories.get(id);
    await db.categories.delete(id);
    if (row) await db.tombstones.put(tombstoneOf('category', id, now()));
  });
  notifyLocalChange();
}

export interface TransactionInput extends Partial<TransactionData> {
  id?: string;
  type?: TransactionType;
}

/**
 * Общие проверки операции: сумма, счёт, для перевода — счёт получателя.
 * Дата по умолчанию — сегодня: человек вводит трату «сейчас».
 */
async function validateTransaction(input: TransactionData): Promise<TransactionData> {
  const data: TransactionData = { ...input, date: input.date || todayIso() };
  if (!data.amount) throw new Error('Сумма должна быть больше нуля');
  if (!data.accountId) throw new Error('Выберите счёт');
  const account = await db.accounts.get(data.accountId);
  if (!account) throw new Error('Счёт не найден');
  if (data.type === 'transfer') {
    if (!data.toAccountId) throw new Error('Выберите счёт получателя');
    const target = await db.accounts.get(data.toAccountId);
    if (!target) throw new Error('Счёт получателя не найден');
    if (target.archived) throw new Error('Счёт получателя в архиве');
  }
  return data;
}

export async function addTransaction(input: TransactionInput): Promise<BudgetTransaction> {
  const ts = now();
  const data = await validateTransaction(normalizeTransaction(input));
  const transaction: BudgetTransaction = {
    id: input.id ?? uid('tx'),
    ...data,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.transactions.add(transaction);
  notifyLocalChange();
  return transaction;
}

export async function updateTransaction(
  id: string,
  patch: Partial<TransactionData>
): Promise<BudgetTransaction | undefined> {
  const existing = await db.transactions.get(id);
  if (!existing) return undefined;
  const merged = await validateTransaction(normalizeTransaction({ ...existing, ...patch }));
  const row: BudgetTransaction = { ...existing, ...merged, updatedAt: now(), dirty: 1 };
  await db.transactions.put(row);
  notifyLocalChange();
  return row;
}

export async function removeTransaction(id: string): Promise<void> {
  await db.transaction('rw', [db.transactions, db.tombstones], async () => {
    const row = await db.transactions.get(id);
    await db.transactions.delete(id);
    if (row) await db.tombstones.put(tombstoneOf('transaction', id, now()));
  });
  notifyLocalChange();
}

/** Журнал: свежие сверху, внутри дня — крупные первыми. */
export async function allTransactions(): Promise<BudgetTransaction[]> {
  const rows = await db.transactions.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
}

/** Операции за период включительно; границы — локальные даты. */
export async function transactionsBetween(
  fromIso: string,
  toIso: string
): Promise<BudgetTransaction[]> {
  const rows = await db.transactions.where('date').between(fromIso, toIso, true, true).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
}

export async function transactionsForMonth(month: string): Promise<BudgetTransaction[]> {
  const key = validMonth(month);
  if (!key) return [];
  const days = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
  return transactionsBetween(`${key}-01`, `${key}-${String(days).padStart(2, '0')}`);
}

export async function getMonthBudget(month: string): Promise<MonthBudget | undefined> {
  const key = validMonth(month);
  if (!key) return undefined;
  return db.budgets.get(key);
}

/** Сохраняет план месяца. `id` — сам месяц, поэтому повторное сохранение обновляет. */
export async function saveMonthBudget(
  month: string,
  patch: Partial<BudgetData>
): Promise<MonthBudget> {
  const key = validMonth(month);
  if (!key) throw new Error('Некорректный месяц бюджета');
  const existing = await db.budgets.get(key);
  const data = normalizeBudget({ ...(existing ?? {}), ...patch });
  const ts = now();
  const row: MonthBudget = {
    id: key,
    ...data,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.budgets.put(row);
  notifyLocalChange();
  return row;
}

/** Перенос плана с прошлого месяца: лимиты и цель, но не факт операций. */
export async function copyMonthBudget(fromMonth: string, toMonth: string): Promise<MonthBudget> {
  const source = await getMonthBudget(fromMonth);
  return saveMonthBudget(toMonth, {
    expectedIncome: source?.expectedIncome ?? 0,
    savingsTarget: source?.savingsTarget ?? 0,
    lines: source?.lines ?? [],
    notes: ''
  });
}

export interface ObligationInput extends Partial<ObligationData> {
  id?: string;
  title?: string;
  kind?: ObligationKind;
  frequency?: Frequency;
}

/** Обязательства: сначала активные по дню платежа, архивные в конце. */
export async function allObligations(): Promise<BudgetObligation[]> {
  const rows = await db.obligations.toArray();
  return rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
    return a.title.localeCompare(b.title, 'ru');
  });
}

export async function addObligation(input: ObligationInput): Promise<BudgetObligation> {
  const ts = now();
  const obligation: BudgetObligation = {
    id: input.id ?? uid('obl'),
    ...normalizeObligation(input),
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.obligations.add(obligation);
  notifyLocalChange();
  return obligation;
}

export async function updateObligation(
  id: string,
  patch: Partial<ObligationData>
): Promise<BudgetObligation | undefined> {
  const existing = await db.obligations.get(id);
  if (!existing) return undefined;
  const row: BudgetObligation = {
    ...existing,
    ...normalizeObligation({ ...existing, ...patch }),
    updatedAt: now(),
    dirty: 1
  };
  await db.obligations.put(row);
  notifyLocalChange();
  return row;
}

export async function removeObligation(id: string): Promise<void> {
  await db.transaction('rw', [db.obligations, db.tombstones], async () => {
    const row = await db.obligations.get(id);
    await db.obligations.delete(id);
    if (row) await db.tombstones.put(tombstoneOf('obligation', id, now()));
  });
  notifyLocalChange();
}

export interface PayObligationOptions {
  amount?: number;
  date?: string;
  accountId?: string;
}

/**
 * «Оплатить»: одна транзакция создаёт расход и уменьшает остаток долга.
 * Отдельной истории платежей нет — связь держится на `obligationId`.
 */
export async function payObligation(
  id: string,
  opts: PayObligationOptions = {}
): Promise<{ transaction: BudgetTransaction; asset?: BudgetAsset } | undefined> {
  const obligation = await db.obligations.get(id);
  if (!obligation) return undefined;
  const amount = opts.amount ? Math.round(Number(opts.amount)) : obligation.amount;
  if (!amount || amount <= 0) throw new Error('У платежа должна быть сумма');
  const accountId = opts.accountId || obligation.accountId;
  if (!accountId) throw new Error('Сначала выберите счёт для оплаты');
  const account = await db.accounts.get(accountId);
  if (!account) throw new Error('Счёт для оплаты не найден');
  const date = validDate(opts.date) || todayIso();
  const ts = now();

  let transaction: BudgetTransaction | undefined;
  let asset: BudgetAsset | undefined;
  await db.transaction('rw', [db.transactions, db.obligations, db.assets], async () => {
    transaction = {
      id: uid('tx'),
      date,
      type: 'expense',
      amount,
      accountId,
      toAccountId: '',
      categoryId: obligation.categoryId,
      payee: obligation.title,
      notes: '',
      obligationId: obligation.id,
      createdAt: ts,
      updatedAt: ts,
      dirty: 1
    };
    await db.transactions.add(transaction);
    if (obligation.assetId) {
      const linked = await db.assets.get(obligation.assetId);
      if (linked) {
        asset = {
          ...linked,
          value: Math.max(0, linked.value - amount),
          updatedAt: ts,
          dirty: 1
        };
        await db.assets.put(asset);
      }
    }
  });
  notifyLocalChange();
  return transaction ? { transaction, asset } : undefined;
}

export interface AssetInput extends Partial<AssetData> {
  id?: string;
  title?: string;
  kind?: AssetKind;
}

/** Активы и пассивы: сначала активы, внутри — по убыванию стоимости. */
export async function allAssets(): Promise<BudgetAsset[]> {
  const rows = await db.assets.toArray();
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'asset' ? -1 : 1;
    if (a.value !== b.value) return b.value - a.value;
    return a.title.localeCompare(b.title, 'ru');
  });
}

export async function addAsset(input: AssetInput): Promise<BudgetAsset> {
  const ts = now();
  const asset: BudgetAsset = {
    id: input.id ?? uid('ast'),
    ...normalizeAsset(input),
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.assets.add(asset);
  notifyLocalChange();
  return asset;
}

export async function updateAsset(
  id: string,
  patch: Partial<AssetData>
): Promise<BudgetAsset | undefined> {
  const existing = await db.assets.get(id);
  if (!existing) return undefined;
  const row: BudgetAsset = {
    ...existing,
    ...normalizeAsset({ ...existing, ...patch }),
    updatedAt: now(),
    dirty: 1
  };
  await db.assets.put(row);
  notifyLocalChange();
  return row;
}

/** Удаление актива: связанный платёж остаётся, но теряет ссылку на остаток. */
export async function removeAsset(id: string): Promise<void> {
  const ts = now();
  await db.transaction('rw', [db.assets, db.obligations, db.tombstones], async () => {
    await db.obligations
      .filter((row) => row.assetId === id)
      .modify((row) => {
        row.assetId = '';
        row.updatedAt = ts;
        row.dirty = 1;
      });
    const row = await db.assets.get(id);
    await db.assets.delete(id);
    if (row) await db.tombstones.put(tombstoneOf('asset', id, ts));
  });
  notifyLocalChange();
}

export async function allSnapshots(): Promise<BudgetSnapshot[]> {
  const rows = await db.snapshots.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Снимок нетто-капитала на сегодня. Один на дату: повторный вызов уточняет
 * суммы, а не плодит точки для графика.
 */
export async function takeSnapshot(notes = ''): Promise<BudgetSnapshot> {
  const [accounts, transactions, assets] = await Promise.all([
    db.accounts.toArray(),
    db.transactions.toArray(),
    db.assets.toArray()
  ]);
  const worth = netWorth(accounts, transactions, assets);
  const date = todayIso();
  const existing = await db.snapshots.get(date);
  const ts = now();
  const row: BudgetSnapshot = {
    id: date,
    ...normalizeSnapshot({
      date,
      assetsTotal: worth.cash + worth.assets,
      liabilitiesTotal: worth.liabilities,
      notes
    }),
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.snapshots.put(row);
  notifyLocalChange();
  return row;
}

export async function removeSnapshot(id: string): Promise<void> {
  await db.transaction('rw', [db.snapshots, db.tombstones], async () => {
    await db.snapshots.delete(id);
    await db.tombstones.put(tombstoneOf('snapshot', id, now()));
  });
  notifyLocalChange();
}

/**
 * Полная очистка устройства. Сначала создаются надгробия, поэтому при
 * включённой синхронизации данные удалятся и из облака.
 */
export async function wipeAll(): Promise<void> {
  const ts = now();
  await db.transaction(
    'rw',
    [
      db.topics,
      db.plans,
      db.messages,
      db.notes,
      db.memory,
      db.events,
      db.tasks,
      db.accounts,
      db.categories,
      db.transactions,
      db.budgets,
      db.obligations,
      db.assets,
      db.snapshots,
      db.kv,
      db.tombstones
    ],
    async () => {
      const topicIds = (await db.topics.toCollection().primaryKeys()) as string[];
      const planIds = (await db.plans.toCollection().primaryKeys()) as string[];
      const messageIds = (await db.messages.toCollection().primaryKeys()) as string[];
      const noteIds = (await db.notes.toCollection().primaryKeys()) as string[];
      const memoryIds = (await db.memory.toCollection().primaryKeys()) as string[];
      const eventIds = (await db.events.toCollection().primaryKeys()) as string[];
      const taskIds = (await db.tasks.toCollection().primaryKeys()) as string[];
      const accountIds = (await db.accounts.toCollection().primaryKeys()) as string[];
      const categoryIds = (await db.categories.toCollection().primaryKeys()) as string[];
      const transactionIds = (await db.transactions.toCollection().primaryKeys()) as string[];
      const budgetIds = (await db.budgets.toCollection().primaryKeys()) as string[];
      const obligationIds = (await db.obligations.toCollection().primaryKeys()) as string[];
      const assetIds = (await db.assets.toCollection().primaryKeys()) as string[];
      const snapshotIds = (await db.snapshots.toCollection().primaryKeys()) as string[];
      const hasProfile = Boolean(await db.kv.get('profile'));

      const rows: Tombstone[] = [
        ...topicIds.map((id) => tombstoneOf('topic', id, ts)),
        ...planIds.map((id) => tombstoneOf('plan', id, ts)),
        ...messageIds.map((id) => tombstoneOf('message', id, ts)),
        ...noteIds.map((id) => tombstoneOf('note', id, ts)),
        ...memoryIds.map((id) => tombstoneOf('memory', id, ts)),
        ...eventIds.map((id) => tombstoneOf('event', id, ts)),
        ...taskIds.map((id) => tombstoneOf('task', id, ts)),
        ...accountIds.map((id) => tombstoneOf('account', id, ts)),
        ...categoryIds.map((id) => tombstoneOf('category', id, ts)),
        ...transactionIds.map((id) => tombstoneOf('transaction', id, ts)),
        ...budgetIds.map((id) => tombstoneOf('budget', id, ts)),
        ...obligationIds.map((id) => tombstoneOf('obligation', id, ts)),
        ...assetIds.map((id) => tombstoneOf('asset', id, ts)),
        ...snapshotIds.map((id) => tombstoneOf('snapshot', id, ts))
      ];
      if (hasProfile) rows.push(tombstoneOf('profile', 'main', ts));
      if (rows.length > 0) await db.tombstones.bulkPut(rows);

      await db.topics.clear();
      await db.plans.clear();
      await db.messages.clear();
      await db.notes.clear();
      await db.memory.clear();
      await db.events.clear();
      await db.tasks.clear();
      await db.accounts.clear();
      await db.categories.clear();
      await db.transactions.clear();
      await db.budgets.clear();
      await db.obligations.clear();
      await db.assets.clear();
      await db.snapshots.clear();

      // Служебные ключи синхронизации (курсоры, авто-режим) сохраняем:
      // иначе следующий pull с нуля вернёт удалённое из облака.
      const keys = (await db.kv.toCollection().primaryKeys()) as string[];
      const stale = keys.filter((key) => !key.startsWith('sync:'));
      if (stale.length > 0) await db.kv.bulkDelete(stale);
    }
  );
  notifyLocalChange();
}

