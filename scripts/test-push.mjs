#!/usr/bin/env node
/**
 * Офлайн-тест Web Push: без сети, без wrangler и без настоящих подписок.
 *
 *   npm run test:push
 *
 * Что проверяется:
 *  - шифрование RFC 8291: сообщение расшифровывается независимой реализацией
 *    (salt, rs, keyid, AES-GCM, разделитель 0x02) и совпадает с исходным;
 *  - VAPID: заголовок `vapid t=…, k=…`, поля JWT и подпись ES256;
 *  - роуты `/api/push/*` через настоящий `worker.fetch` (401, config,
 *    subscribe, schedule, test);
 *  - cron: созревшие напоминания отправляются и убираются из очереди,
 *    подписка с ответом 410 удаляется вместе с записью устройства.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (file) => import(pathToFileURL(path.resolve(file)).href);
const worker = (await load('worker/deepseek-proxy.js')).default;
const push = await load('worker/push.js');

const { b64uDecode, b64uEncode, encryptPush, runScheduled, vapidHeaders } = push;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TOKEN = 'test-token';
const ENDPOINT = 'https://push.example.com/send/abc';
const NOW = Date.now() + 60_000;

let total = 0;
const failures = [];
const check = (ok, message, details = '') => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}${ok || !details ? '' : ` — ${details}`}`);
};

const concat = (...parts) => {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, length * 8);
  return new Uint8Array(bits);
}

/** Простая KV-заглушка с теми же методами, что у Cloudflare KV. */
class FakeKV {
  constructor() {
    this.map = new Map();
  }

  async get(key, type) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) || 0 : 0;
    const page = keys.slice(start, start + limit);
    const next = start + limit;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: next >= keys.length,
      cursor: String(next)
    };
  }
}

const kv = new FakeKV();
const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));
const vapidPrivateJwk = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);

const ENV = {
  APP_TOKEN: TOKEN,
  DEEPSEEK_API_KEY: 'sk-test',
  ALLOWED_ORIGINS: '',
  VAPID_PUBLIC_KEY: b64uEncode(vapidPublicRaw),
  VAPID_PRIVATE_KEY: String(vapidPrivateJwk.d),
  VAPID_SUBJECT: 'mailto:test@example.com',
  PUSH_KV: kv
};

/** Пара подписчика: p256dh (публичный ключ) и auth-секрет. */
async function makeSubscriber() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    raw,
    auth,
    subscription: { endpoint: ENDPOINT, keys: { p256dh: b64uEncode(raw), auth: b64uEncode(auth) } }
  };
}

/** Независимая расшифровка тела aes128gcm — проверка формата, а не самой функции. */
async function decryptPush(body, subscriber) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const keyLength = body[20];
  const keyId = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);

  const asPublic = await crypto.subtle.importKey(
    'raw',
    keyId,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublic }, subscriber.pair.privateKey, 256)
  );
  const info = concat(encoder.encode('WebPush: info\0'), subscriber.raw, keyId);
  const ikm = await hkdf(subscriber.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext)
  );
  return {
    recordSize,
    keyLength,
    delimiter: plaintext[plaintext.length - 1],
    text: decoder.decode(plaintext.slice(0, -1))
  };
}

// --- 1. шифрование RFC 8291 ---
console.log('\nшифрование aes128gcm');
{
  const subscriber = await makeSubscriber();
  const message = {
    title: 'Наставник',
    body: 'Через 15 мин · 14:00',
    tag: 'event:e1:2026-11-27',
    url: '#/calendar'
  };
  const encrypted = await encryptPush(encoder.encode(JSON.stringify(message)), subscriber.subscription);
  check(encrypted.length > 21 + 65, 'тело содержит заголовок и шифротекст', String(encrypted.length));

  const opened = await decryptPush(encrypted, subscriber);
  check(opened.recordSize === 4096, 'rs = 4096', String(opened.recordSize));
  check(opened.keyLength === 65, 'keyid — несжатая точка P-256', String(opened.keyLength));
  check(opened.delimiter === 2, 'последняя запись помечена 0x02', String(opened.delimiter));
  check(opened.text === JSON.stringify(message), 'текст совпал после расшифровки', opened.text.slice(0, 120));

  const second = await encryptPush(encoder.encode('повтор'), subscriber.subscription);
  check(!second.every((byte, i) => byte === encrypted[i]), 'каждое сообщение шифруется заново (соль и ключ новые)');

  let failed = '';
  try {
    await encryptPush(encoder.encode('x'), { endpoint: ENDPOINT, keys: { p256dh: 'AAAA', auth: 'AAAA' } });
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  }
  check(Boolean(failed), 'битые ключи подписки отклоняются', failed);
}

// --- 2. VAPID ---
console.log('\nVAPID (ES256)');
{
  const { authorization } = await vapidHeaders(ENDPOINT, ENV, NOW);
  check(authorization.startsWith('vapid t='), 'формат заголовка vapid t=…, k=…', authorization.slice(0, 30));

  const token = authorization.match(/t=([^,]+)/)?.[1] ?? '';
  const key = authorization.match(/k=([^,]+)/)?.[1] ?? '';
  check(key === ENV.VAPID_PUBLIC_KEY, 'публичный ключ отдан в k=');

  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(decoder.decode(b64uDecode(payload || '')));
  check(claims.aud === 'https://push.example.com', 'aud — origin push-сервиса', claims.aud);
  check(claims.exp === Math.floor(NOW / 1000) + 12 * 3600, 'exp — 12 часов', String(claims.exp));
  check(claims.sub === 'mailto:test@example.com', 'sub — контакт владельца', claims.sub);

  const signatureOk = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    vapidPair.publicKey,
    b64uDecode(signature || ''),
    encoder.encode(`${header}.${payload}`)
  );
  check(signatureOk, 'подпись JWT сходится с публичным ключом');

  const headerJson = JSON.parse(decoder.decode(b64uDecode(header || '')));
  check(headerJson.alg === 'ES256' && headerJson.typ === 'JWT', 'заголовок JWT: ES256 / JWT');

  let error = '';
  try {
    await vapidHeaders(ENDPOINT, { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }, NOW);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  check(Boolean(error), 'без ключей VAPID выдаёт понятную ошибку', error);
}

// --- 3. роуты воркера ---
console.log('\nроуты /api/push/*');
const DEVICE = 'test-device-01';

const call = (route, { method = 'GET', token = TOKEN, body } = {}) => {
  const headers = new Headers();
  if (token) headers.set('x-app-token', token);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return worker.fetch(
    new Request(`https://proxy.test${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    ENV
  );
};

const subscriber = await makeSubscriber();

/** Ловит исходящие push-запросы и отвечает заданным статусом. */
function mockPushFetch(status = 201) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status });
  };
  fn.calls = calls;
  return fn;
}

{
  const denied = await call('/api/push/config', { token: null });
  check(denied.status === 401, 'без x-app-token — 401', String(denied.status));

  const config = await call('/api/push/config');
  const configData = await config.json();
  check(config.status === 200, 'config отвечает 200', String(config.status));
  check(configData.publicKey === ENV.VAPID_PUBLIC_KEY, 'config отдаёт публичный VAPID-ключ');

  const badDevice = await call('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: 'no', subscription: subscriber.subscription }
  });
  check(badDevice.status === 400, 'короткий deviceId отклоняется', String(badDevice.status));

  const badSubscription = await call('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: DEVICE, subscription: { endpoint: 'http://insecure', keys: {} } }
  });
  check(badSubscription.status === 400, 'http-endpoint отклоняется', String(badSubscription.status));

  const subscribed = await call('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: DEVICE, subscription: subscriber.subscription, label: 'iPhone' }
  });
  const subscribedData = await subscribed.json();
  check(
    subscribed.status === 200 && subscribedData.subscriptions === 1,
    'подписка сохранена',
    JSON.stringify(subscribedData)
  );

  const record = await kv.get(`dev:${DEVICE}`, 'json');
  check(
    record?.subscriptions?.[0]?.label === 'iPhone',
    'подпись устройства сохранена',
    JSON.stringify(record?.subscriptions)
  );

  const scheduled = await call('/api/push/schedule', {
    method: 'PUT',
    body: {
      deviceId: DEVICE,
      items: [
        { at: NOW + 60_000, title: 'Созвон', body: 'через 15 мин · 14:00', tag: 'event:1', url: '#/calendar' },
        { at: NOW + 70_000, title: 'Дубль', tag: 'event:1' },
        { at: NOW - 7 * 3600_000, title: 'Слишком старое', tag: 'old' },
        { at: NOW + 80_000, title: 'Чужая ссылка', tag: 'bad', url: 'https://evil.example.com' }
      ]
    }
  });
  const scheduledData = await scheduled.json();
  check(scheduled.status === 200, 'schedule принят', String(scheduled.status));
  check(scheduledData.items === 2, 'дубль и старое отброшены', JSON.stringify(scheduledData));
  check(scheduledData.nextAt === NOW + 60_000, 'nextAt — ближайшее напоминание', String(scheduledData.nextAt));

  const stored = await kv.get(`dev:${DEVICE}`, 'json');
  check(stored?.items?.[0]?.url === '#/calendar', 'hash-маршрут сохранён', JSON.stringify(stored?.items));
  check(stored?.items?.[1]?.url === '', 'внешняя ссылка вычищена', JSON.stringify(stored?.items?.[1]));

  const originalFetch = globalThis.fetch;
  const testFetch = mockPushFetch(201);
  globalThis.fetch = testFetch;
  try {
    const test = await call('/api/push/test', { method: 'POST', body: { deviceId: DEVICE } });
    const testData = await test.json();
    check(test.status === 200 && testData.sent === 1, 'тестовое уведомление отправлено', JSON.stringify(testData));
  } finally {
    globalThis.fetch = originalFetch;
  }
  check(testFetch.calls.length === 1, 'на push-сервис ушёл один запрос', String(testFetch.calls.length));
  const sentHeaders = testFetch.calls[0]?.init?.headers;
  check(
    sentHeaders?.get('content-encoding') === 'aes128gcm',
    'заголовок content-encoding',
    String(sentHeaders?.get('content-encoding'))
  );
  check(String(sentHeaders?.get('authorization') || '').startsWith('vapid t='), 'заголовок authorization — VAPID');
  check(Number(sentHeaders?.get('content-length')) > 100, 'тело зашифровано', String(sentHeaders?.get('content-length')));
}

// --- 4. cron ---
console.log('\ncron');
{
  await call('/api/push/schedule', {
    method: 'PUT',
    body: { deviceId: DEVICE, items: [{ at: NOW, title: 'Созвон', tag: 'event:1', url: '#/calendar' }] }
  });
  const cronFetch = mockPushFetch(201);
  const cron = await runScheduled(ENV, { now: NOW, fetchImpl: cronFetch });
  check(cron.ok && cron.sent === 1, 'cron отправил созревшее напоминание', JSON.stringify(cron));
  const afterCron = await kv.get(`dev:${DEVICE}`, 'json');
  check(
    Array.isArray(afterCron?.items) && afterCron.items.length === 0,
    'очередь очищена',
    JSON.stringify(afterCron?.items)
  );

  const second = 'test-device-02';
  await call('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: second, subscription: subscriber.subscription }
  });
  await call('/api/push/schedule', {
    method: 'PUT',
    body: { deviceId: second, items: [{ at: NOW, title: 'Мёртвая подписка', tag: 'task:9' }] }
  });
  const goneCron = await runScheduled(ENV, { now: NOW, fetchImpl: mockPushFetch(410) });
  check(goneCron.dropped === 1, 'ответ 410 удаляет подписку', JSON.stringify(goneCron));
  check((await kv.get(`dev:${second}`, 'json')) === null, 'запись устройства без подписок удалена');

  const unsubscribe = await call('/api/push/subscribe', {
    method: 'DELETE',
    body: { deviceId: DEVICE, endpoint: ENDPOINT }
  });
  const unsubscribeData = await unsubscribe.json();
  check(
    unsubscribe.status === 200 && unsubscribeData.removed === true,
    'DELETE снимает подписку и запись',
    JSON.stringify(unsubscribeData)
  );

  const notConfigured = await worker.fetch(
    new Request('https://proxy.test/api/push/config', { headers: { 'x-app-token': TOKEN } }),
    { APP_TOKEN: TOKEN, DEEPSEEK_API_KEY: 'sk-test', ALLOWED_ORIGINS: '' }
  );
  check(notConfigured.status === 503, 'без VAPID-ключей и KV — 503 с подсказкой', String(notConfigured.status));
}

// --- 5. точка входа cron в воркере ---
console.log('\nscheduled воркера');
{
  const device = 'test-device-03';
  await call('/api/push/subscribe', {
    method: 'POST',
    body: { deviceId: device, subscription: subscriber.subscription }
  });
  const dueAt = Date.now() - 5_000;
  await call('/api/push/schedule', {
    method: 'PUT',
    body: { deviceId: device, items: [{ at: dueAt, title: 'Проверка cron', tag: 'digest:1' }] }
  });

  const pending = [];
  const cronFetch = mockPushFetch(201);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = cronFetch;
  try {
    worker.scheduled({ cron: '* * * * *' }, ENV, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }
  check(pending.length === 1, 'scheduled использует waitUntil', String(pending.length));
  check(cronFetch.calls.length === 1, 'cron отправил уведомление через worker.scheduled', String(cronFetch.calls.length));

  const result = await runScheduled({ ...ENV, PUSH_KV: null }, { now: NOW });
  check(result.skipped === 'no-kv', 'без KV cron молча пропускается', JSON.stringify(result));
}

console.log(`\n${total - failures.length}/${total} проверок пройдено`);
if (failures.length) {
  console.log('\nОшибки:');
  for (const failure of failures) console.log(`  ✖ ${failure}`);
  process.exit(1);
}



