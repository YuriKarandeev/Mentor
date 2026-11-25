import Dexie, { type Table, type Transaction } from 'dexie';
import { notifyLocalChange } from '../sync/signal';
import { now, uid } from '../utils/ids';

export type Level = 'новичок' | 'средний' | 'продвинутый';
export type ItemKind = 'theory' | 'practice' | 'check';
export type TopicStatus = 'active' | 'paused' | 'done';
export type Effort = 'low' | 'high' | 'max';
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 0 — запись совпадает с облаком, 1 — ждёт отправки. */
export type DirtyFlag = 0 | 1;

/** Сущности, которые зеркалятся в Firestore. */
export type SyncEntity = 'topic' | 'plan' | 'message' | 'note' | 'memory' | 'profile';

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

/** Сжатая память наставника по теме (раньше лежала в kv как memory:<id>). */
export interface MemoryRow {
  topicId: string;
  text: string;
  updatedAt: number;
  dirty: DirtyFlag;
}

export interface AppSettings {
  proxyUrl: string;
  appToken: string;
  model: string;
  effort: Effort;
  webSearch: boolean;
  theme: ThemeMode;
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
export const SCHEMA_VERSION = 2;

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
  }
}

export const db = new StudyDB();

export const DEFAULT_SETTINGS: AppSettings = {
  proxyUrl: (import.meta.env.VITE_DEFAULT_PROXY_URL as string | undefined) ?? '',
  appToken: '',
  model: 'deepseek-flash',
  effort: 'high',
  webSearch: true,
  theme: 'auto'
};

export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return (row?.value as T) ?? fallback;
}

/**
 * Запись в kv. `sync: true` помечает ключ к отправке в облако —
 * используйте только для profile, настройки устройства остаются локальными.
 */
export async function setKv(key: string, value: unknown, opts?: { sync?: boolean }): Promise<void> {
  const row: KvRow = { key, value };
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
    citations: note.citations,
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
  await db.notes.add(row);
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

/**
 * Полная очистка устройства. Сначала создаются надгробия, поэтому при
 * включённой синхронизации данные удалятся и из облака.
 */
export async function wipeAll(): Promise<void> {
  const ts = now();
  await db.transaction(
    'rw',
    [db.topics, db.plans, db.messages, db.notes, db.memory, db.kv, db.tombstones],
    async () => {
      const topicIds = (await db.topics.toCollection().primaryKeys()) as string[];
      const planIds = (await db.plans.toCollection().primaryKeys()) as string[];
      const messageIds = (await db.messages.toCollection().primaryKeys()) as string[];
      const noteIds = (await db.notes.toCollection().primaryKeys()) as string[];
      const memoryIds = (await db.memory.toCollection().primaryKeys()) as string[];
      const hasProfile = Boolean(await db.kv.get('profile'));

      const rows: Tombstone[] = [
        ...topicIds.map((id) => tombstoneOf('topic', id, ts)),
        ...planIds.map((id) => tombstoneOf('plan', id, ts)),
        ...messageIds.map((id) => tombstoneOf('message', id, ts)),
        ...noteIds.map((id) => tombstoneOf('note', id, ts)),
        ...memoryIds.map((id) => tombstoneOf('memory', id, ts))
      ];
      if (hasProfile) rows.push(tombstoneOf('profile', 'main', ts));
      if (rows.length > 0) await db.tombstones.bulkPut(rows);

      await db.topics.clear();
      await db.plans.clear();
      await db.messages.clear();
      await db.notes.clear();
      await db.memory.clear();

      // Служебные ключи синхронизации (курсоры, авто-режим) сохраняем:
      // иначе следующий pull с нуля вернёт удалённое из облака.
      const keys = (await db.kv.toCollection().primaryKeys()) as string[];
      const stale = keys.filter((key) => !key.startsWith('sync:'));
      if (stale.length > 0) await db.kv.bulkDelete(stale);
    }
  );
  notifyLocalChange();
}

