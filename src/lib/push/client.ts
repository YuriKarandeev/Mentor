/**
 * Клиент Web Push: подписка браузера, отправка расписания в воркер и статус
 * для страницы «Настройки».
 *
 * Схема:
 *  1. пользователь нажимает «Включить напоминания» — это жест, без него iOS
 *     не показывает запрос разрешения;
 *  2. service worker подписывается на push (`pushManager.subscribe`) с
 *     публичным VAPID-ключом воркера (`GET /api/push/config`);
 *  3. подписка уходит в воркер (`POST /api/push/subscribe`) вместе с id
 *     устройства из IndexedDB;
 *  4. при любом изменении событий/дел приложение пересчитывает ближайшие
 *     напоминания (`buildReminders`) и отправляет их в воркер
 *     (`PUT /api/push/schedule`). Воркер по cron рассылает push.
 *
 * Часовой пояс воркеру не нужен: моменты времени уже абсолютные.
 * Сеть и браузерные API здесь изолированы — сама логика расписания лежит
 * в `utils/reminders.ts` и проверяется отдельным тестом.
 */
import { allEvents, allTasks, getKv, setKv } from '../db/db';
import { settings } from '../stores/settings.svelte';
import { onLocalChange } from '../sync/signal';
import { uid } from '../utils/ids';
import {
  buildReminders,
  normalizeReminderSettings,
  type ReminderDraft,
  type ReminderSettings
} from '../utils/reminders.ts';

const DEVICE_KEY = 'push-device';
const HASH_KEY = 'push-schedule-hash';
/** Пересчёт после локальной правки — с задержкой, чтобы не отправлять каждый символ. */
const LOCAL_CHANGE_DELAY_MS = 4000;
/** Полная перепроверка, пока приложение открыто (на случай правок на другом устройстве). */
const HEARTBEAT_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ReminderStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  /** В настройках выбран прокси-воркер и есть токен — иначе push отправить некому. */
  serverReady: boolean;
  subscribed: boolean;
  enabled: boolean;
  standalone: boolean;
  ios: boolean;
}

export interface ReminderRefresh {
  planned: number;
  sent: boolean;
}

/** Адрес воркера и токен: напоминания отправляет только прокси-режим. */
function serverConfig(): { base: string; token: string } | null {
  const data = settings.data;
  const base = String(data.proxyUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(data.appToken ?? '').trim();
  if (normalizeModeSafe(data.mode) !== 'proxy' || !base || !token) return null;
  return { base, token };
}

function normalizeModeSafe(mode: unknown): string {
  return mode === 'proxy' ? 'proxy' : 'direct';
}

/** Сообщение, если напоминания некуда отправлять. */
export function serverHint(): string {
  return serverConfig()
    ? ''
    : 'Напоминания отправляет ваш прокси-воркер: в «Подключении» выберите «Свой прокси» и укажите адрес и токен приложения.';
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const server = serverConfig();
  if (!server) throw new Error(serverHint());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${server.base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-app-token': server.token },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = typeof data.error === 'string' ? data.error : `Воркер ответил ${res.status}`;
      throw new Error(message);
    }
    return data as T;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') {
      throw new Error('Воркер не ответил за 15 секунд — проверьте адрес и сеть.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Идентификатор устройства для воркера: переживает перезапуск, не уходит в облако. */
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

/** Подпись устройства — чтобы в воркере было видно, кто подписан. */
function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return ua.includes('iPhone') ? 'iPhone' : ua.includes('iPad') ? 'iPad' : 'Браузер';
}
/** Включает напоминания: разрешение браузера → подписка → регистрация в воркере. */
export async function enableReminders(): Promise<ReminderRefresh> {
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (!serverConfig()) throw new Error(serverHint());

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Браузер не разрешил уведомления. Разрешение можно вернуть в настройках сайта.');
  }

  const config = await request<{ publicKey?: string }>('/api/push/config');
  const publicKey = String(config.publicKey ?? '').trim();
  if (!publicKey) throw new Error('Воркер не вернул VAPID-ключ — проверьте секреты VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY.');

  const subscription = await ensureSubscription(b64uToBytes(publicKey));
  await request('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: await deviceKey(), subscription: subscription.toJSON(), label: deviceLabel() }
  });

  await settings.patch({
    reminders: { ...normalizeReminderSettings(settings.data.reminders), enabled: true }
  });
  await setKv(HASH_KEY, '');
  return refreshReminders({ force: true });
}

/** Отключает напоминания и снимает подписку на этом устройстве. */
export async function disableReminders(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (subscription) {
      await request('/api/push/subscribe', {
        method: 'DELETE',
        body: { deviceId: await deviceKey(), endpoint: subscription.endpoint }
      }).catch(() => undefined);
      await subscription.unsubscribe().catch(() => undefined);
    }
  } finally {
    await setKv(HASH_KEY, '');
    await settings.patch({
      reminders: { ...normalizeReminderSettings(settings.data.reminders), enabled: false }
    });
  }
}

/** Пересчитывает расписание и отправляет его в воркер. */
export async function refreshReminders(opts: { force?: boolean } = {}): Promise<ReminderRefresh> {
  const reminders = normalizeReminderSettings(settings.data.reminders);
  if (!reminders.enabled) return { planned: 0, sent: false };
  if (!serverConfig()) throw new Error(serverHint());

  const items = await plannedReminders();
  const payload = items.map((item) => ({
    at: item.at,
    title: item.title,
    body: item.body,
    tag: item.tag,
    url: item.url
  }));
  const hash = payload.map((item) => `${item.tag}@${item.at}`).join('|');
  const stored = await getKv<string>(HASH_KEY, '');
  if (!opts.force && stored === hash) return { planned: items.length, sent: false };

  await request('/api/push/schedule', {
    method: 'PUT',
    body: { deviceId: await deviceKey(), items: payload }
  });
  await setKv(HASH_KEY, hash);
  return { planned: items.length, sent: true };
}

/** Ближайшие напоминания по локальным данным — без обращения к сети. */
export async function plannedReminders(now: Date = new Date()): Promise<ReminderDraft[]> {
  const reminders: ReminderSettings = normalizeReminderSettings(settings.data.reminders);
  const [events, tasks] = await Promise.all([allEvents(), allTasks()]);
  return buildReminders({ events, tasks, settings: reminders, now });
}

/** Тестовое уведомление: проверяет всю цепочку до телефона. */
export async function sendTestReminder(): Promise<{ sent: number; failed: number }> {
  const result = await request<{ sent?: number; failed?: number }>('/api/push/test', {
    method: 'POST',
    body: { deviceId: await deviceKey() }
  });
  return { sent: Number(result.sent ?? 0), failed: Number(result.failed ?? 0) };
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

/** Приложение открыто как установленное (на iOS только так работает push). */
/** Состояние напоминаний для карточки в «Настройках». */
export async function readStatus(): Promise<ReminderStatus> {
  const supported = pushSupported();
  const reminders = normalizeReminderSettings(settings.data.reminders);
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
  return {
    supported,
    permission,
    serverReady: Boolean(serverConfig()),
    subscribed,
    enabled: reminders.enabled,
    standalone: isStandalone(),
    ios: isIos()
  };
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** Пересчёт с дебаунсом: правка события не должна порождать запрос на каждую букву. */
function scheduleRefresh(delay = LOCAL_CHANGE_DELAY_MS): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void runRefresh();
  }, delay);
}

async function runRefresh(): Promise<void> {
  if (running) return;
  const reminders = normalizeReminderSettings(settings.data.reminders);
  if (!reminders.enabled || !serverConfig()) return;
  running = true;
  try {
    await refreshReminders();
  } catch {
    // Ошибку покажет карточка настроек: здесь молча ждём следующей попытки.
  } finally {
    running = false;
  }
}

/**
 * Запускается один раз при старте приложения. Расписание пересчитывается
 * после любой локальной правки, при возврате на вкладку, после появления
 * сети и раз в полчаса — воркер к этому времени уже мог отправить уведомления
 * и удалить их из очереди.
 */
export function initReminders(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  onLocalChange(() => scheduleRefresh());
  window.addEventListener('online', () => scheduleRefresh(1000));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefresh(1000);
  });
  setInterval(() => scheduleRefresh(0), HEARTBEAT_MS);
  scheduleRefresh(1500);
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
