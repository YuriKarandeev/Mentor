import Dexie, { type Table } from 'dexie';
import { now, uid } from '../utils/ids';

export type Level = 'новичок' | 'средний' | 'продвинутый';
export type ItemKind = 'theory' | 'practice' | 'check';
export type TopicStatus = 'active' | 'paused' | 'done';
export type Effort = 'low' | 'high' | 'max';
export type ThemeMode = 'auto' | 'light' | 'dark';

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
}

export interface Plan {
  id: string;
  topicId: string;
  title: string;
  summary?: string;
  modules: PlanModule[];
  createdAt: number;
}

export interface StoredMessage {
  id: string;
  topicId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  citations?: Citation[];
  createdAt: number;
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
}

export const DEFAULT_PROFILE: Profile = { goals: [], interests: [], updatedAt: 0 };

class StudyDB extends Dexie {
  topics!: Table<Topic, string>;
  plans!: Table<Plan, string>;
  messages!: Table<StoredMessage, string>;
  notes!: Table<Note, string>;
  kv!: Table<KvRow, string>;

  constructor() {
    super('study-mentor');
    this.version(1).stores({
      topics: 'id, updatedAt, status',
      plans: 'id, topicId',
      messages: 'id, topicId, createdAt',
      notes: 'id, topicId, createdAt',
      kv: 'key'
    });
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

export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
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
  const topic: Topic = {
    id: uid('t'),
    title: input.title.trim(),
    goal: input.goal.trim(),
    level: input.level,
    hoursPerWeek: input.hoursPerWeek,
    status: 'active',
    createdAt: now(),
    updatedAt: now()
  };
  await db.topics.add(topic);
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
    createdAt: now()
  };
  await db.transaction('rw', db.plans, db.topics, async () => {
    await db.plans.where('topicId').equals(topicId).delete();
    await db.plans.add(plan);
    await db.topics.update(topicId, { updatedAt: now() });
  });
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
  item.done = !item.done;
  await db.plans.put(plan);
  await db.topics.update(plan.topicId, { updatedAt: now() });
  return plan;
}

export async function addMessage(
  msg: Omit<StoredMessage, 'id' | 'createdAt'> & { id?: string }
): Promise<StoredMessage> {
  const row: StoredMessage = {
    id: msg.id ?? uid('msg'),
    topicId: msg.topicId,
    role: msg.role,
    content: msg.content,
    reasoning: msg.reasoning,
    citations: msg.citations,
    createdAt: now()
  };
  await db.messages.add(row);
  return row;
}

export async function addNote(
  note: Omit<Note, 'id' | 'createdAt'> & { id?: string }
): Promise<Note> {
  const row: Note = {
    id: note.id ?? uid('n'),
    topicId: note.topicId,
    title: note.title,
    md: note.md,
    source: note.source,
    tags: note.tags ?? [],
    citations: note.citations,
    createdAt: now()
  };
  await db.notes.add(row);
  return row;
}

