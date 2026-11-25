/**
 * Чистые функции обмена с облаком: никакого Firebase и Dexie внутри,
 * поэтому модуль легко проверять отдельным скриптом (npm run test:sync).
 */
import type { MemoryRow, Note, Plan, Profile, StoredMessage, Topic, Tombstone } from '../db/db';

/** Коллекции Firestore внутри users/{uid}. */
export type SyncedCollection = 'topics' | 'plans' | 'messages' | 'notes' | 'memory';

export const SYNCED_COLLECTIONS: SyncedCollection[] = ['topics', 'plans', 'messages', 'notes', 'memory'];

export const COLLECTION_PROFILE = 'profile';
export const PROFILE_DOC_ID = 'main';
export const COLLECTION_TOMBSTONES = 'tombstones';

/** Версия формата документа в облаке — на случай будущих миграций. */
export const CLOUD_SCHEMA_VERSION = 2;

/** Firestore принимает до 500 операций в батче, берём с запасом. */
export const MAX_BATCH_WRITES = 400;
export const PULL_PAGE_SIZE = 200;
/** Перекрытие окна выгрузки: страховка от расхождения часов между устройствами. */
export const PULL_OVERLAP_MS = 10 * 60 * 1000;

export function collectionForTombstone(type: Tombstone['type']): string {
  switch (type) {
    case 'topic':
      return 'topics';
    case 'plan':
      return 'plans';
    case 'message':
      return 'messages';
    case 'note':
      return 'notes';
    case 'memory':
      return 'memory';
    case 'profile':
      return COLLECTION_PROFILE;
  }
}

export function docIdForTombstone(tombstone: Tombstone): string {
  return tombstone.type === 'profile' ? PROFILE_DOC_ID : tombstone.refId;
}

export interface Versioned {
  updatedAt: number;
}

/**
 * Разрешение конфликтов: побеждает более новая запись по клиентскому updatedAt.
 * При равных метках оставляем локальную копию — она уже применена на устройстве.
 */
export function shouldApply(local: Versioned | undefined | null, remote: Versioned): boolean {
  if (!local) return true;
  const localAt = Number(local.updatedAt ?? 0);
  const remoteAt = Number(remote.updatedAt ?? 0);
  return remoteAt > localAt;
}

export function pickUpdatedAt(data: Record<string, unknown>): number {
  const value = Number(data.updatedAt ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Убирает служебное поле srvUpdatedAt перед записью в локальную базу. */
export function withoutServerFields(data: Record<string, unknown>): Record<string, unknown> {
  const { srvUpdatedAt: _srv, ...rest } = data;
  return rest;
}

/* --- Локальная запись → документ облака (явные белые списки полей) --- */

export function toRemoteTopic(topic: Topic): Record<string, unknown> {
  return {
    title: topic.title,
    goal: topic.goal,
    level: topic.level,
    hoursPerWeek: topic.hoursPerWeek,
    status: topic.status,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemotePlan(plan: Plan): Record<string, unknown> {
  return {
    topicId: plan.topicId,
    title: plan.title,
    summary: plan.summary ?? null,
    modules: plan.modules,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteMessage(message: StoredMessage): Record<string, unknown> {
  return {
    topicId: message.topicId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning ?? null,
    citations: message.citations ?? [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteNote(note: Note): Record<string, unknown> {
  return {
    topicId: note.topicId ?? null,
    title: note.title,
    md: note.md,
    source: note.source,
    tags: note.tags ?? [],
    citations: note.citations ?? [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteMemory(row: MemoryRow): Record<string, unknown> {
  return {
    text: row.text,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

/**
 * Профиль в облако. Именно белый список полей гарантирует,
 * что токен прокси и прочие настройки устройства никогда не утекут.
 */
export function toRemoteProfile(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name ?? null,
    occupation: profile.occupation ?? null,
    level: profile.level ?? null,
    goals: profile.goals ?? [],
    interests: profile.interests ?? [],
    preferredStyle: profile.preferredStyle ?? null,
    updatedAt: profile.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function chunk<T>(items: T[], size: number = MAX_BATCH_WRITES): T[][] {
  const step = size > 0 ? size : MAX_BATCH_WRITES;
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += step) pages.push(items.slice(i, i + step));
  return pages;
}

/**
 * Firestore отклоняет `undefined` во вложенных полях, а `null` принимает.
 * Рекурсивно вычищаем undefined из объектов и превращаем в null в массивах.
 */
export function toPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toPlain(item))) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = toPlain(item);
    }
    return out as T;
  }
  return value;
}
