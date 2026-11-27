/**
 * Клиент Web Push: подписка браузера, план напоминаний в Firestore и статус
 * для страницы «Настройки».
 *
 * Схема (как у «Ассистента»):
 *  1. пользователь вошёл через Google и нажал «Включить напоминания» — это жест,
 *     без него iOS не показывает запрос разрешения;
 *  2. service worker подписывается на push (`pushManager.subscribe`) с публичным
 *     VAPID-ключом из `./config.ts`;
 *  3. подписка уходит в Firestore: `users/{uid}/push/{deviceId}`;
 *  4. при любом изменении событий/дел приложение пересчитывает расписание
 *     (`buildReminders`) и кладёт его в `users/{uid}/pushPlan/{deviceId}`;
 *  5. GitHub Actions (`_push/send.mjs`) по cron читает планы и рассылает push,
 *     отмечая отправленное в `users/{uid}/pushState/{deviceId}`.
 *
 * Своего сервера у приложения нет: DeepSeek вызывается напрямую из браузера,
 * а push — это Firestore плюс scheduled workflow. Задержка доставки — от минуты
 * до ~10 минут: точность cron GitHub Actions.
 *
 * Сеть и браузерные API здесь изолированы — сама логика расписания лежит
 * в `utils/reminders.ts` и проверяется отдельным тестом.
 */
import { allEvents, allTasks, getKv, setKv } from '../db/db';
import { settings } from '../stores/settings.svelte';
import { loadFirebase, syncConfigured, type FirestoreModule } from '../sync/firebase';
import { onLocalChange } from '../sync/signal';
import { sync } from '../sync/state.svelte';
import { uid } from '../utils/ids';
import {
  buildReminders,
  normalizeReminderSettings,
  planSignature,
  PLAN_VERSION,
  toPlanItems,
  type ReminderDraft,
  type ReminderPlanItem,
  type ReminderSettings
} from '../utils/reminders';
import { VAPID_PUBLIC_KEY, pushConfigured } from './config';

const DEVICE_KEY = 'push-device';
const HASH_KEY = 'push-schedule-hash';
/** Пересчёт после локальной правки — с задержкой, чтобы не писать каждый символ. */
const LOCAL_CHANGE_DELAY_MS = 4000;
/** Полная перепроверка, пока приложение открыто (на случай правок на другом устройстве). */
const HEARTBEAT_MS = 30 * 60_000;

const SIGN_IN_HINT =
  'Напоминания отправляет GitHub Actions по расписанию в облаке, поэтому нужен вход через Google: «Настройки → Синхронизация».';
const NOT_CONFIGURED_HINT =
  'Доставка напоминаний не настроена: в сборку не добавлен публичный VAPID-ключ (см. docs/SETUP.md).';

export interface ReminderStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  /** Есть публичный VAPID-ключ — без него браузер не подпишется. */
  configured: boolean;
  /** Пользователь вошёл: только тогда есть куда записать подписку и план. */
  signedIn: boolean;
  /** Включить напоминания вообще можно (браузер + ключ + вход). */
  ready: boolean;
  subscribed: boolean;
  enabled: boolean;
  standalone: boolean;
  ios: boolean;
  /** Когда отправитель последний раз успешно проходил по этому устройству. */
  lastRunAt: number;
  /** Последняя ошибка доставки, записанная отправителем. */
  lastError: string;
  /** Момент запроса «проверить доставку» или 0, если запроса нет. */
  pendingTest: number;
}

export interface ReminderRefresh {
  planned: number;
  sent: boolean;
}

/** Текущий пользователь Firebase и его Firestore — либо null, если войти некуда. */
interface Cloud {
  userId: string;
  db: import('firebase/firestore').Firestore;
  fs: FirestoreModule;
}

async function cloud(): Promise<Cloud | null> {
  if (!syncConfigured()) return null;
  const userId = sync.user?.uid ?? '';
  if (!userId) return null;
  const firebase = await loadFirebase();
  return { userId, db: firebase.db, fs: firebase.fsMod };
}

/** Ссылка на документ устройства: push (подписка), pushPlan (план), pushState (отметки). */
function deviceRef(target: Cloud, collection: 'push' | 'pushPlan' | 'pushState', deviceId: string) {
  return target.fs.doc(target.db, 'users', target.userId, collection, deviceId);
}

/** Часовой пояс устройства — для диагностики в отправителе. */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** ISO/число/Timestamp → миллисекунды; 0 — значения нет или оно битое. */
function parseMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const stamp = value as { toMillis?: () => number } | null;
  if (stamp && typeof stamp.toMillis === 'function') {
    const ms = stamp.toMillis();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** Сообщение, если напоминания включить нельзя. Пустая строка — всё готово. */
export function remindersHint(): string {
  if (!syncConfigured()) {
    return 'В этой сборке синхронизация выключена, поэтому напоминания отправить некому.';
  }
  if (!pushConfigured()) return NOT_CONFIGURED_HINT;
  if (!sync.signedIn) return SIGN_IN_HINT;
  return '';
}

/** Идентификатор устройства: переживает перезапуск и служит id документа в Firestore. */
async function deviceKey(): Promise<string> {
  const stored = await getKv<string>(DEVICE_KEY, '');
  if (stored) return stored;
  const created = uid('push');
  await setKv(DEVICE_KEY, created);
  return created;
}

function b64uToBytes(value: string): Uint8Array {
  const raw = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

/** Текущая подписка браузера — или новая, если её ещё нет. */
async function ensureSubscription(applicationServerKey: Uint8Array): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const current = existing.options?.applicationServerKey;
    if (current && sameKey(new Uint8Array(current as ArrayBuffer), applicationServerKey)) return existing;
    await existing.unsubscribe().catch(() => undefined);
  }
  // TS 6 типизирует Uint8Array как ArrayBufferLike, а DOM ждёт BufferSource
  // с ArrayBuffer — по факту это те же байты, приведение безопасно.
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey as unknown as BufferSource
  });
}

/** Подпись устройства — чтобы в Firestore было видно, кто подписан. */
function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return ua.includes('iPhone') ? 'iPhone' : ua.includes('iPad') ? 'iPad' : 'Браузер';
}

/** Кладёт подписку устройства в Firestore; повторный вызов обновляет её. */
async function saveSubscription(target: Cloud, subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const endpoint = String(json.endpoint ?? subscription.endpoint ?? '');
  const keys = json.keys ?? {};
  if (!endpoint) {
    throw new Error('Браузер не вернул адрес подписки — выключите и включите напоминания заново.');
  }
  await target.fs.setDoc(
    deviceRef(target, 'push', await deviceKey()),
    {
      endpoint,
      keys: { p256dh: String(keys.p256dh ?? ''), auth: String(keys.auth ?? '') },
      label: deviceLabel(),
      ua: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      timeZone: timeZone(),
      updatedAt: new Date().toISOString()
    },
    { merge: true }
  );
}

/** Включает напоминания: разрешение браузера → подписка → запись в Firestore. */
export async function enableReminders(): Promise<ReminderRefresh> {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (!pushConfigured()) throw new Error(NOT_CONFIGURED_HINT);
  const target = await cloud();
  if (!target) throw new Error(SIGN_IN_HINT);

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Браузер не разрешил уведомления. Разрешение можно вернуть в настройках сайта.');
  }

  const subscription = await ensureSubscription(b64uToBytes(VAPID_PUBLIC_KEY));
  await saveSubscription(target, subscription);

  await settings.patch({
    reminders: { ...normalizeReminderSettings(settings.data.reminders), enabled: true }
  });
  await setKv(HASH_KEY, '');
  return refreshReminders({ force: true });
}

/**
 * Отключает напоминания на этом устройстве: снимает подписку и чистит план,
 * чтобы отправитель больше не тратил на него запуски.
 */
export async function disableReminders(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    const target = await cloud().catch(() => null);
    if (target) {
      const deviceId = await deviceKey();
      await target.fs.deleteDoc(deviceRef(target, 'push', deviceId)).catch(() => undefined);
      await target.fs.deleteDoc(deviceRef(target, 'pushState', deviceId)).catch(() => undefined);
      await target.fs
        .setDoc(
          deviceRef(target, 'pushPlan', deviceId),
          { items: [], updatedAt: new Date().toISOString() },
          { merge: true }
        )
        .catch(() => undefined);
    }
    if (subscription) await subscription.unsubscribe().catch(() => undefined);
  } finally {
    await setKv(HASH_KEY, '');
    await settings.patch({
      reminders: { ...normalizeReminderSettings(settings.data.reminders), enabled: false }
    });
  }
}

/** Пересчитывает расписание и записывает план в Firestore. */
export async function refreshReminders(opts: { force?: boolean } = {}): Promise<ReminderRefresh> {
  const reminders = normalizeReminderSettings(settings.data.reminders);
  if (!reminders.enabled) return { planned: 0, sent: false };
  const target = await cloud();
  if (!target) throw new Error(SIGN_IN_HINT);

  const items = toPlanItems(await plannedReminders());
  const hash = planSignature(items, reminders.leadMinutes);
  const stored = await getKv<string>(HASH_KEY, '');
  if (!opts.force && stored === hash) return { planned: items.length, sent: false };

  await savePlan(target, items, reminders);
  await setKv(HASH_KEY, hash);
  return { planned: items.length, sent: true };
}

/** Пишет план устройства: список созревающих напоминаний и параметры. */
async function savePlan(
  target: Cloud,
  items: ReminderPlanItem[],
  reminders: ReminderSettings
): Promise<void> {
  await target.fs.setDoc(
    deviceRef(target, 'pushPlan', await deviceKey()),
    {
      items,
      leadMinutes: reminders.leadMinutes,
      timeZone: timeZone(),
      version: PLAN_VERSION,
      updatedAt: new Date().toISOString()
    },
    { merge: true }
  );
}

/** Ближайшие напоминания по локальным данным — без обращения к сети. */
export async function plannedReminders(now: Date = new Date()): Promise<ReminderDraft[]> {
  const reminders: ReminderSettings = normalizeReminderSettings(settings.data.reminders);
  const [events, tasks] = await Promise.all([allEvents(), allTasks()]);
  return buildReminders({ events, tasks, settings: reminders, now });
}

/**
 * Тест сразу: показывает уведомление с этого устройства через service worker.
 * Проверяет разрешение браузера и обработчик push, но не доставку по сети.
 */
export async function testReminderLocally(): Promise<void> {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (Notification.permission !== 'granted') {
    throw new Error('Уведомления запрещены в браузере: включите напоминания и разрешите их.');
  }
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification('Наставник', {
    body: 'Тест: уведомления на этом устройстве работают.',
    tag: 'test:local',
    lang: 'ru',
    icon: new URL('icons/icon-192.png', registration.scope).href,
    badge: new URL('icons/icon-192.png', registration.scope).href,
    data: { url: '#/settings' }
  });
}

/**
 * Проверка доставки: отправитель увидит `testAt` в плане и пришлёт тестовое
 * уведомление на это устройство. Приходит с задержкой cron (до ~10 минут).
 */
export async function requestServerTest(): Promise<void> {
  const reminders = normalizeReminderSettings(settings.data.reminders);
  if (!reminders.enabled) throw new Error('Сначала включите напоминания.');
  const target = await cloud();
  if (!target) throw new Error(SIGN_IN_HINT);

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (!subscription) throw new Error('Подписка не найдена — выключите и включите напоминания заново.');
  // Запись обновляем перед тестом: если подписку потеряли в облаке — восстановим.
  await saveSubscription(target, subscription);

  await target.fs.setDoc(
    deviceRef(target, 'pushPlan', await deviceKey()),
    { testAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

/** Что отправитель записал о последнем запуске: время, ошибку и запрос теста. */
async function readServerState(): Promise<{ lastRunAt: number; lastError: string; pendingTest: number }> {
  const target = await cloud().catch(() => null);
  if (!target) return { lastRunAt: 0, lastError: '', pendingTest: 0 };
  try {
    const deviceId = await deviceKey();
    const [stateSnap, planSnap] = await Promise.all([
      target.fs.getDoc(deviceRef(target, 'pushState', deviceId)),
      target.fs.getDoc(deviceRef(target, 'pushPlan', deviceId))
    ]);
    const state = stateSnap.exists() ? (stateSnap.data() as Record<string, unknown>) : {};
    const plan = planSnap.exists() ? (planSnap.data() as Record<string, unknown>) : {};
    return {
      lastRunAt: parseMs(state.lastRunAt),
      lastError: typeof state.lastError === 'string' ? state.lastError : '',
      pendingTest: parseMs(plan.testAt)
    };
  } catch {
    // Нет сети или правила не пускают — карточка покажет «сервер ещё не отвечал».
    return { lastRunAt: 0, lastError: '', pendingTest: 0 };
  }
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Состояние напоминаний для карточки в «Настройках». */
export async function readStatus(): Promise<ReminderStatus> {
  const supported = pushSupported();
  const reminders = normalizeReminderSettings(settings.data.reminders);
  const configured = pushConfigured();
  const signedIn = sync.signedIn;
  let permission: NotificationPermission | 'unsupported' = 'unsupported';
  let subscribed = false;
  if (supported) {
    permission = Notification.permission;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      subscribed = Boolean(registration && (await registration.pushManager.getSubscription()));
    } catch {
      subscribed = false;
    }
  }
  const server = signedIn && configured ? await readServerState() : { lastRunAt: 0, lastError: '', pendingTest: 0 };
  return {
    supported,
    permission,
    configured,
    signedIn,
    ready: supported && configured && signedIn,
    subscribed,
    enabled: reminders.enabled,
    standalone: isStandalone(),
    ios: isIos(),
    lastRunAt: server.lastRunAt,
    lastError: server.lastError,
    pendingTest: server.pendingTest
  };
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let forceNext = false;

/** Пересчёт с дебаунсом: правка события не должна порождать запись на каждую букву. */
function scheduleRefresh(delay = LOCAL_CHANGE_DELAY_MS, force = false): void {
  if (force) forceNext = true;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void runRefresh();
  }, delay);
}

async function runRefresh(): Promise<void> {
  if (running) return;
  const reminders = normalizeReminderSettings(settings.data.reminders);
  // Без входа писать план некуда — молча ждём следующей попытки.
  if (!reminders.enabled || !pushConfigured() || !sync.signedIn) return;
  running = true;
  const force = forceNext;
  forceNext = false;
  try {
    await refreshReminders({ force });
  } catch {
    // Ошибку покажет карточка настроек: здесь молча ждём следующей попытки.
  } finally {
    running = false;
  }
}

/**
 * Запускается один раз при старте приложения. План пересчитывается после любой
 * локальной правки, при возврате на вкладку, после появления сети и раз в
 * полчаса. Проверки по таймеру идут с `force`: отправитель мог удалить план
 * вместе с мёртвой подпиской, и тогда его нужно записать заново даже при
 * неизменившемся расписании.
 */
export function initReminders(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  onLocalChange(() => scheduleRefresh());
  window.addEventListener('online', () => scheduleRefresh(1000, true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefresh(1000, true);
  });
  setInterval(() => scheduleRefresh(0, true), HEARTBEAT_MS);
  scheduleRefresh(1500, true);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const touchMac = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  return /iPad|iPhone|iPod/.test(ua) || touchMac;
}

/** Понятная причина, почему включить напоминания нельзя. */
export function unsupportedReason(): string {
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) {
      return 'На iPhone push-уведомления работают только в приложении, установленном на домашний экран (iOS 16.4+).';
    }
    if (isIos()) return 'Нужна iOS 16.4 или новее и установленное приложение.';
    return 'Браузер не поддерживает push-уведомления. Попробуйте Chrome, Edge или Safari 16.4+.';
  }
  if (isIos() && !isStandalone()) {
    return 'На iPhone push-уведомления приходят только в приложении с домашнего экрана.';
  }
  return '';
}
