/**
 * Движок синхронизации: локальная база Dexie — источник истины,
 * Firestore используется как канал обмена между устройствами.
 *
 * Цикл: pull (по курсору srvUpdatedAt) → push (dirty-записи и надгробия) →
 * повтор, пока есть изменения. Живых подписок onSnapshot нет: опрос по
 * расписанию экономит квоты Firebase Spark.
 */
import type { User } from 'firebase/auth';
import {
  countPending,
  db,
  getKv,
  setKv,
  tombstoneOf,
  type DirtyFlag,
  type MemoryRow,
  type Note,
  type Plan,
  type Profile,
  type StoredMessage,
  type SyncEntity,
  type Tombstone,
  type Topic
} from '../db/db';
import { uid } from '../utils/ids';
import { SYNC_ENABLED } from './config';
import { describeSyncError, type SyncErrorInfo, type SyncStep } from './errors';
import { loadFirebase, type Firebase } from './firebase';
import {
  COLLECTION_PROFILE,
  COLLECTION_TOMBSTONES,
  MAX_BATCH_WRITES,
  PROFILE_DOC_ID,
  PULL_OVERLAP_MS,
  PULL_PAGE_SIZE,
  SYNCED_COLLECTIONS,
  chunk,
  collectionForTombstone,
  docIdForTombstone,
  fromRemoteEvent,
  pickUpdatedAt,
  shouldApply,
  toRemoteEvent,
  toRemoteMemory,
  toRemoteMessage,
  toRemoteNote,
  toRemotePlan,
  toRemoteProfile,
  toRemoteTopic,
  toPlain,
  withoutServerFields,
  type SyncedCollection
} from './model';
import { onLocalChange } from './signal';
import { sync } from './state.svelte';

const CURSORS_KEY = 'sync:cursors';
const AUTO_KEY = 'sync:auto';
const DEVICE_KEY = 'sync:device';
const LAST_KEY = 'sync:last';
const PROFILE_KEY = 'profile';
const FULL_CYCLE_LIMIT = 4;
const MAX_PULL_PAGES = 20;

interface Ctx {
  uid: string;
  fb: Firebase;
}

let ctx: Ctx | null = null;
let running = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let started = false;
let listenersBound = false;
let device: string | null = null;
/** Фатальная ошибка: автоповторы бессмысленны, ждём действий пользователя. */
let paused: SyncErrorInfo | null = null;

function reportError(e: unknown, step: SyncStep): SyncErrorInfo {
  const info = describeSyncError(e, step);
  sync.status = 'error';
  sync.error = info.message;
  sync.errorHint = info.hint;
  sync.errorCode = info.code;
  // Служебный текст остаётся в консоли: по нему удобно искать причину.
  console.warn(`[sync:${step}] ${info.code || 'error'}: ${info.raw || info.message}`);
  if (info.fatal) paused = info;
  return info;
}

function clearError(): void {
  sync.error = '';
  sync.errorHint = '';
  sync.errorCode = '';
  paused = null;
}

function timestampMs(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null;
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
}

async function deviceId(): Promise<string> {
  if (device) return device;
  const stored = await getKv<string>(DEVICE_KEY, '');
  if (stored) {
    device = stored;
    return device;
  }
  device = uid('dev');
  await setKv(DEVICE_KEY, device);
  return device;
}


/* ---------------------------------------------------------------- запуск */

export async function initSync(): Promise<void> {
  if (!SYNC_ENABLED || started) return;
  started = true;
  sync.status = 'signed-out';
  sync.auto = await getKv<boolean>(AUTO_KEY, true);
  sync.lastSyncAt = await getKv<number>(LAST_KEY, 0);

  let fb: Firebase;
  try {
    fb = await loadFirebase();
  } catch (e) {
    reportError(e, 'init');
    return;
  }

  fb.authMod.onAuthStateChanged(
    fb.auth,
    (user) => {
      void handleUser(fb, user);
    },
    (e) => {
      reportError(e, 'auth');
    }
  );

  onLocalChange(() => scheduleSync());
  bindGlobalListeners();

  try {
    await fb.authMod.getRedirectResult(fb.auth);
  } catch (e) {
    reportError(e, 'auth');
  }
}

async function handleUser(fb: Firebase, user: User | null): Promise<void> {
  // Новый вход или выход — прошлые фатальные ошибки больше не актуальны.
  paused = null;
  if (!user) {
    ctx = null;
    stopLoop();
    sync.user = null;
    sync.pending = 0;
    sync.status = SYNC_ENABLED ? 'signed-out' : 'off';
    return;
  }
  ctx = { uid: user.uid, fb };
  sync.user = {
    uid: user.uid,
    email: user.email ?? '',
    name: user.displayName ?? '',
    photo: user.photoURL ?? ''
  };
  startLoop();
  await syncOnce('sign-in');
}

export async function signInWithGoogle(): Promise<void> {
  const fb = await loadFirebase();
  const { authMod } = fb;
  const provider = new authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await authMod.signInWithPopup(fb.auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      // Браузер не даёт открыть попап (мобильный Safari, блокировщики) — идём редиректом.
      await authMod.signInWithRedirect(fb.auth, provider);
      return;
    }
    throw e;
  }
}

export async function signOutSync(): Promise<void> {
  const fb = await loadFirebase();
  await fb.authMod.signOut(fb.auth);
}

export async function setAutoSync(value: boolean): Promise<void> {
  sync.auto = value;
  await setKv(AUTO_KEY, value);
  if (value) {
    scheduleSync(0);
  } else if (debounce !== null) {
    clearTimeout(debounce);
    debounce = null;
  }
}

export async function syncNow(): Promise<void> {
  // Ручной запуск повторяем даже после фатальной ошибки: пользователь мог
  // только что опубликовать правила или включить базу.
  paused = null;
  await syncOnce('manual');
}

function bindGlobalListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;
  window.addEventListener('online', () => scheduleSync(0));
  window.addEventListener('offline', () => {
    if (ctx) sync.status = 'offline';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(500);
  });
}

function startLoop(): void {
  stopLoop();
  loop = setInterval(() => scheduleSync(0), 60_000);
}

function stopLoop(): void {
  if (loop !== null) {
    clearInterval(loop);
    loop = null;
  }
  if (debounce !== null) {
    clearTimeout(debounce);
    debounce = null;
  }
}

function scheduleSync(delay = 1500): void {
  if (!ctx || !sync.auto || paused || debounce !== null) return;
  debounce = setTimeout(() => {
    debounce = null;
    void syncOnce('auto');
  }, delay);
}

/* ------------------------------------------------------------ главный цикл */

async function syncOnce(_reason: string): Promise<void> {
  const current = ctx;
  if (!current || running) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    sync.status = 'offline';
    return;
  }

  running = true;
  sync.status = 'syncing';
  clearError();
  let step: SyncStep = 'pull';
  try {
    let appliedRemote = 0;
    for (let i = 0; i < FULL_CYCLE_LIMIT; i += 1) {
      step = 'pull';
      const pulled = await pull(current);
      step = 'push';
      const pushed = await push(current);
      appliedRemote += pulled;
      if (pulled === 0 && pushed === 0) break;
    }
    sync.pending = await countPending();
    sync.lastSyncAt = Date.now();
    sync.status = 'idle';
    await setKv(LAST_KEY, sync.lastSyncAt);
    if (appliedRemote > 0) sync.revision += 1;
    if (sync.pending > 0) scheduleSync(3000);
  } catch (e) {
    const info = reportError(e, step);
    // Нет прав, нет базы, истекла сессия — повторять каждые 60 секунд бессмысленно.
    if (!info.fatal) scheduleSync(5000);
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------- pull */

async function pull(current: Ctx): Promise<number> {
  let applied = 0;
  // Список коллекций — единый источник правды: новая сущность добавляется
  // в SYNCED_COLLECTIONS и сразу участвует в pull и push.
  for (const name of SYNCED_COLLECTIONS) {
    applied += await pullCollection(current, name);
  }
  applied += await pullProfile(current);
  applied += await pullTombstones(current);
  return applied;
}

async function pullCollection(current: Ctx, name: SyncedCollection): Promise<number> {
  const { fsMod, db: fsDb } = current.fb;
  const cursors = await getKv<Record<string, number>>(CURSORS_KEY, {});
  const base = Number(cursors[name] ?? 0);
  let pageCursor = Math.max(0, base - PULL_OVERLAP_MS);
  let applied = 0;

  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const snapshot = await fsMod.getDocs(
      fsMod.query(
        fsMod.collection(fsDb, 'users', current.uid, name),
        fsMod.where('srvUpdatedAt', '>', fsMod.Timestamp.fromMillis(pageCursor)),
        fsMod.orderBy('srvUpdatedAt'),
        fsMod.limit(PULL_PAGE_SIZE)
      )
    );

    let maxSrv = pageCursor;
    for (const docSnap of snapshot.docs) {
      const raw = docSnap.data() as Record<string, unknown>;
      const srv = timestampMs(raw.srvUpdatedAt);
      if (await applyRemote(name, docSnap.id, withoutServerFields(raw))) applied += 1;
      if (srv > maxSrv) maxSrv = srv;
    }

    if (snapshot.size < PULL_PAGE_SIZE) {
      if (maxSrv > pageCursor) pageCursor = maxSrv;
      break;
    }
    if (maxSrv <= pageCursor) break;
    pageCursor = maxSrv;
  }

  if (pageCursor > base) await setKv(CURSORS_KEY, { ...cursors, [name]: pageCursor });
  return applied;
}

async function applyRemote(
  name: SyncedCollection,
  id: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const updatedAt = pickUpdatedAt(data);
  if (updatedAt <= 0) return false;

  switch (name) {
    case 'topics': {
      const local = await db.topics.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      const row: Topic = {
        id,
        title: String(data.title ?? ''),
        goal: String(data.goal ?? ''),
        level: (data.level as Topic['level']) ?? 'новичок',
        hoursPerWeek: Number(data.hoursPerWeek ?? 5) || 5,
        status: (data.status as Topic['status']) ?? 'active',
        createdAt: Number(data.createdAt ?? updatedAt),
        updatedAt,
        dirty: 0
      };
      await db.topics.put(row);
      return true;
    }
    case 'plans': {
      const local = await db.plans.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      const row: Plan = {
        id,
        topicId: String(data.topicId ?? ''),
        title: String(data.title ?? 'План обучения'),
        summary: data.summary === null || data.summary === undefined ? undefined : String(data.summary),
        modules: Array.isArray(data.modules) ? (data.modules as Plan['modules']) : [],
        createdAt: Number(data.createdAt ?? updatedAt),
        updatedAt,
        dirty: 0
      };
      await db.plans.put(row);
      return true;
    }
    case 'messages': {
      const local = await db.messages.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      const row: StoredMessage = {
        id,
        topicId: String(data.topicId ?? ''),
        role: data.role === 'assistant' ? 'assistant' : 'user',
        content: String(data.content ?? ''),
        reasoning: data.reasoning === null || data.reasoning === undefined ? undefined : String(data.reasoning),
        citations: Array.isArray(data.citations) ? (data.citations as StoredMessage['citations']) : [],
        createdAt: Number(data.createdAt ?? updatedAt),
        updatedAt,
        dirty: 0
      };
      await db.messages.put(row);
      return true;
    }
    case 'notes': {
      const local = await db.notes.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      const row: Note = {
        id,
        topicId: data.topicId === null || data.topicId === undefined ? undefined : String(data.topicId),
        title: String(data.title ?? ''),
        md: String(data.md ?? ''),
        source: (data.source as Note['source']) ?? 'manual',
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        citations: Array.isArray(data.citations) ? (data.citations as Note['citations']) : [],
        createdAt: Number(data.createdAt ?? updatedAt),
        updatedAt,
        dirty: 0
      };
      await db.notes.put(row);
      return true;
    }
    case 'memory': {
      const local = await db.memory.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      const row: MemoryRow = { topicId: id, text: String(data.text ?? ''), updatedAt, dirty: 0 };
      await db.memory.put(row);
      return true;
    }
    case 'events': {
      const row = fromRemoteEvent(id, data);
      // Без валидной даты событие не показывается и не сохраняется.
      if (!row.date) return false;
      const local = await db.events.get(id);
      if (!shouldApply(local, { updatedAt })) return false;
      await db.events.put(row);
      return true;
    }
  }
}

async function pullProfile(current: Ctx): Promise<number> {
  const { fsMod, db: fsDb } = current.fb;
  const snapshot = await fsMod.getDoc(
    fsMod.doc(fsDb, 'users', current.uid, COLLECTION_PROFILE, PROFILE_DOC_ID)
  );
  if (!snapshot.exists()) return 0;

  const raw = snapshot.data() as Record<string, unknown>;
  const updatedAt = pickUpdatedAt(raw);
  if (updatedAt <= 0) return 0;

  const localRow = await db.kv.get(PROFILE_KEY);
  const local = (localRow?.value ?? null) as Profile | null;
  if (!shouldApply(local, { updatedAt })) return 0;

  const profile: Profile = {
    name: textField(raw.name),
    occupation: textField(raw.occupation),
    level: raw.level === null || raw.level === undefined ? undefined : (raw.level as Profile['level']),
    goals: Array.isArray(raw.goals) ? (raw.goals as string[]) : [],
    interests: Array.isArray(raw.interests) ? (raw.interests as string[]) : [],
    preferredStyle: textField(raw.preferredStyle),
    updatedAt
  };
  await db.kv.put({ key: PROFILE_KEY, value: profile, dirty: 0 });
  return 1;
}

function textField(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

async function pullTombstones(current: Ctx): Promise<number> {
  const { fsMod, db: fsDb } = current.fb;
  const cursors = await getKv<Record<string, number>>(CURSORS_KEY, {});
  const base = Number(cursors[COLLECTION_TOMBSTONES] ?? 0);
  let pageCursor = Math.max(0, base - PULL_OVERLAP_MS);
  let applied = 0;
  const self = await deviceId();

  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const snapshot = await fsMod.getDocs(
      fsMod.query(
        fsMod.collection(fsDb, 'users', current.uid, COLLECTION_TOMBSTONES),
        fsMod.where('srvUpdatedAt', '>', fsMod.Timestamp.fromMillis(pageCursor)),
        fsMod.orderBy('srvUpdatedAt'),
        fsMod.limit(PULL_PAGE_SIZE)
      )
    );

    let maxSrv = pageCursor;
    for (const docSnap of snapshot.docs) {
      const raw = docSnap.data() as Record<string, unknown>;
      const srv = timestampMs(raw.srvUpdatedAt);
      // Свои же удаления применять не нужно: локальные строки уже удалены.
      if (String(raw.origin ?? '') !== self) {
        const type = raw.type as SyncEntity | undefined;
        const refId = typeof raw.refId === 'string' ? raw.refId : '';
        const deletedAt = Number(raw.deletedAt ?? 0) || srv;
        if (type && refId && (await applyTombstone(type, refId, deletedAt))) applied += 1;
      }
      if (srv > maxSrv) maxSrv = srv;
    }

    if (snapshot.size < PULL_PAGE_SIZE) {
      if (maxSrv > pageCursor) pageCursor = maxSrv;
      break;
    }
    if (maxSrv <= pageCursor) break;
    pageCursor = maxSrv;
  }

  if (pageCursor > base) await setKv(CURSORS_KEY, { ...cursors, [COLLECTION_TOMBSTONES]: pageCursor });
  return applied;
}

async function applyTombstone(type: SyncEntity, refId: string, deletedAt: number): Promise<boolean> {
  switch (type) {
    case 'topic': {
      const local = await db.topics.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await deleteLocalTopic(refId);
      return true;
    }
    case 'plan': {
      const local = await db.plans.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await db.plans.delete(refId);
      return true;
    }
    case 'message': {
      const local = await db.messages.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await db.messages.delete(refId);
      return true;
    }
    case 'note': {
      const local = await db.notes.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await db.notes.delete(refId);
      return true;
    }
    case 'memory': {
      const local = await db.memory.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await db.memory.delete(refId);
      return true;
    }
    case 'event': {
      const local = await db.events.get(refId);
      if (!local || deletedAt < local.updatedAt) return false;
      await db.events.delete(refId);
      return true;
    }
    case 'profile': {
      const row = await db.kv.get(PROFILE_KEY);
      const local = row?.value as Profile | undefined;
      if (!local || deletedAt < (local.updatedAt ?? 0)) return false;
      await db.kv.delete(PROFILE_KEY);
      return true;
    }
  }
}

async function deleteLocalTopic(topicId: string): Promise<void> {
  await db.transaction('rw', [db.topics, db.plans, db.messages, db.notes, db.memory], async () => {
    await db.topics.delete(topicId);
    await db.plans.where('topicId').equals(topicId).delete();
    await db.messages.where('topicId').equals(topicId).delete();
    await db.notes.where('topicId').equals(topicId).delete();
    await db.memory.delete(topicId);
  });
}

/* ------------------------------------------------------------------- push */

interface PushRow {
  id: string;
  updatedAt: number;
  payload: Record<string, unknown>;
}

async function push(current: Ctx): Promise<number> {
  let pushed = 0;
  for (const name of SYNCED_COLLECTIONS) {
    pushed += await pushCollection(current, name);
  }
  pushed += await pushProfile(current);
  pushed += await pushTombstones(current);
  return pushed;
}

async function pushCollection(current: Ctx, name: SyncedCollection): Promise<number> {
  const rows = await collectDirty(name);
  if (rows.length === 0) return 0;
  await commitPush(current, name, rows);
  await markSynced(name, rows);
  return rows.length;
}

async function collectDirty(name: SyncedCollection): Promise<PushRow[]> {
  switch (name) {
    case 'topics': {
      const rows = await db.topics.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt, payload: toRemoteTopic(row) }));
    }
    case 'plans': {
      const rows = await db.plans.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt, payload: toRemotePlan(row) }));
    }
    case 'messages': {
      const rows = await db.messages.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt, payload: toRemoteMessage(row) }));
    }
    case 'notes': {
      const rows = await db.notes.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt, payload: toRemoteNote(row) }));
    }
    case 'memory': {
      const rows = await db.memory.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.topicId, updatedAt: row.updatedAt, payload: toRemoteMemory(row) }));
    }
    case 'events': {
      const rows = await db.events.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
      return rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt, payload: toRemoteEvent(row) }));
    }
  }
}

async function commitPush(current: Ctx, name: SyncedCollection, rows: PushRow[]): Promise<void> {
  const { fsMod, db: fsDb } = current.fb;
  for (const batchRows of chunk(rows, MAX_BATCH_WRITES)) {
    const batch = fsMod.writeBatch(fsDb);
    for (const row of batchRows) {
      batch.set(fsMod.doc(fsDb, 'users', current.uid, name, row.id), {
        ...toPlain(row.payload),
        srvUpdatedAt: fsMod.serverTimestamp()
      });
    }
    await batch.commit();
  }
}

/** Снимает dirty только с тех версий, которые реально ушли в облако. */
async function markSynced(name: SyncedCollection, rows: PushRow[]): Promise<void> {
  const versions = new Map(rows.map((row) => [row.id, row.updatedAt] as [string, number]));
  if (name === 'memory') {
    await db.memory
      .where('dirty')
      .equals(1)
      .modify((row) => {
        if (versions.get(row.topicId) === row.updatedAt) row.dirty = 0;
      });
    return;
  }
  const table = db.table<{ id: string; updatedAt: number; dirty: DirtyFlag }, string>(name);
  await table
    .where('dirty')
    .equals(1)
    .modify((row) => {
      if (versions.get(row.id) === row.updatedAt) row.dirty = 0;
    });
}

async function pushProfile(current: Ctx): Promise<number> {
  const row = await db.kv.get(PROFILE_KEY);
  const profile = row?.value as Profile | undefined;
  if (!row || row.dirty !== 1 || !profile) return 0;

  const { fsMod, db: fsDb } = current.fb;
  await fsMod.setDoc(fsMod.doc(fsDb, 'users', current.uid, COLLECTION_PROFILE, PROFILE_DOC_ID), {
    ...toPlain(toRemoteProfile(profile)),
    srvUpdatedAt: fsMod.serverTimestamp()
  });

  const latest = await db.kv.get(PROFILE_KEY);
  if (latest && (latest.value as Profile)?.updatedAt === profile.updatedAt) {
    await db.kv.put({ key: PROFILE_KEY, value: latest.value, dirty: 0 });
  }
  return 1;
}

async function pushTombstones(current: Ctx): Promise<number> {
  const rows = await db.tombstones.where('dirty').equals(1).limit(MAX_BATCH_WRITES).toArray();
  if (rows.length === 0) return 0;

  const { fsMod, db: fsDb } = current.fb;
  const origin = await deviceId();

  for (const tomb of rows) {
    if (tomb.type === 'topic') await deleteRemoteTopicChildren(current, tomb.refId);
  }

  const batch = fsMod.writeBatch(fsDb);
  for (const tomb of rows) {
    // Надгробие остаётся в облаке: другие устройства должны узнать об удалении.
    batch.set(fsMod.doc(fsDb, 'users', current.uid, COLLECTION_TOMBSTONES, tomb.id), {
      type: tomb.type,
      refId: tomb.refId,
      deletedAt: tomb.deletedAt,
      origin,
      srvUpdatedAt: fsMod.serverTimestamp()
    });
    // Сами данные удаляем сразу — надгробие нужно только как сигнал.
    batch.delete(
      fsMod.doc(fsDb, 'users', current.uid, collectionForTombstone(tomb.type), docIdForTombstone(tomb))
    );
  }
  await batch.commit();
  await db.tombstones.bulkDelete(rows.map((tomb) => tomb.id));
  return rows.length;
}

/** Дочерние документы удалённой темы: страховка от «сирот» в облаке. */
async function deleteRemoteTopicChildren(current: Ctx, topicId: string): Promise<void> {
  const { fsMod, db: fsDb } = current.fb;
  for (const name of ['plans', 'messages', 'notes'] as const) {
    const snapshot = await fsMod.getDocs(
      fsMod.query(
        fsMod.collection(fsDb, 'users', current.uid, name),
        fsMod.where('topicId', '==', topicId),
        fsMod.limit(MAX_BATCH_WRITES)
      )
    );
    if (snapshot.empty) continue;
    const batch = fsMod.writeBatch(fsDb);
    for (const docSnap of snapshot.docs) batch.delete(docSnap.ref);
    await batch.commit();
  }
  await fsMod.deleteDoc(fsMod.doc(fsDb, 'users', current.uid, 'memory', topicId));
}

/**
 * Очистка облачной копии: локальные данные остаются, но помечаются
 * надгробиями, поэтому удаление уходит в Firestore.
 */
export async function wipeCloud(): Promise<void> {
  if (!ctx) throw new Error('Сначала войдите в аккаунт');
  const ts = Date.now();
  const rows: Tombstone[] = [];

  const topicIds = (await db.topics.toCollection().primaryKeys()) as string[];
  const planIds = (await db.plans.toCollection().primaryKeys()) as string[];
  const messageIds = (await db.messages.toCollection().primaryKeys()) as string[];
  const noteIds = (await db.notes.toCollection().primaryKeys()) as string[];
  const memoryIds = (await db.memory.toCollection().primaryKeys()) as string[];
  const eventIds = (await db.events.toCollection().primaryKeys()) as string[];

  rows.push(...topicIds.map((id) => tombstoneOf('topic', id, ts)));
  rows.push(...planIds.map((id) => tombstoneOf('plan', id, ts)));
  rows.push(...messageIds.map((id) => tombstoneOf('message', id, ts)));
  rows.push(...noteIds.map((id) => tombstoneOf('note', id, ts)));
  rows.push(...memoryIds.map((id) => tombstoneOf('memory', id, ts)));
  rows.push(...eventIds.map((id) => tombstoneOf('event', id, ts)));
  if (await db.kv.get(PROFILE_KEY)) rows.push(tombstoneOf('profile', PROFILE_DOC_ID, ts));

  if (rows.length > 0) await db.tombstones.bulkPut(rows);
  await syncOnce('wipe-cloud');
}


