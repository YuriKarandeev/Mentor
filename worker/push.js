/**
 * Web Push для «Наставника»: подписка устройства, расписание и рассылка.
 *
 * Почему в этом же воркере: push-уведомления на iOS работают только из
 * установленного PWA и только через сервер. Отдельный сервис не нужен —
 * Cloudflare Worker умеет и HTTP-роуты (`fetch`), и cron (`scheduled`).
 *
 * Как устроено:
 *  - клиент присылает подписку браузера (`POST /api/push/subscribe`) и список
 *    ближайших напоминаний (`PUT /api/push/schedule`) — время уже абсолютное;
 *  - расписание лежит в KV (`PUSH_KV`, ключ `dev:<deviceId>`), TTL 30 дней:
 *    забытые устройства удаляются сами;
 *  - cron раз в минуту берёт созревшие напоминания, отправляет их на все
 *    подписки устройства и убирает из очереди; подписки с ответом 404/410
 *    удаляются.
 *
 * Криптография — стандартная, без зависимостей: VAPID JWT (ES256) и
 * aes128gcm из RFC 8291/8188 на WebCrypto. Проверяется офлайн:
 * `npm run test:push` шифрует сообщение и расшифровывает его независимой
 * реализацией, а затем проверяет подпись VAPID-токена.
 *
 * Секреты и переменные воркера:
 *   VAPID_PUBLIC_KEY  — публичный ключ (65 байт, base64url), можно отдавать клиенту
 *   VAPID_PRIVATE_KEY — приватный ключ (32 байта, base64url), только секрет
 *   VAPID_SUBJECT     — mailto: или https:-адрес владельца приложения
 *   PUSH_KV           — binding KV namespace для подписок и расписаний
 */

const encoder = new TextEncoder();

const KEY_PREFIX = 'dev:';
const MAX_SUBSCRIPTIONS = 5;
const MAX_ITEMS = 200;
const MAX_TITLE = 120;
const MAX_BODY = 240;
const MAX_TAG = 120;
const MAX_URL = 200;
/** Насколько вперёд клиент может планировать напоминания. */
const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;
/** Насколько назад — тоже принимаем: часы устройства могли спешить. */
const MAX_BEHIND_MS = 6 * 3600 * 1000;
/** Cron раз в минуту: отправляем и то, что «созрело» в пределах получаса. */
const LATE_WINDOW_MS = 30 * 1000;
/** Запись без обновлений столько дней считается мёртвой. */
const RECORD_TTL_S = 30 * 24 * 3600;
const VAPID_TTL_S = 12 * 3600;
/** Размер записи aes128gcm (больше одного сообщения нам не нужно). */
const RECORD_SIZE = 4096;
/** Ограничение тела запроса: расписание на 200 пунктов заведомо меньше. */
const MAX_BODY_BYTES = 64 * 1024;

export function b64uEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(value) {
  const raw = String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** HKDF-SHA-256: ровно то, что предписывает RFC 8291. */
async function hkdf(salt, ikm, info, length) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, length * 8);
  return new Uint8Array(bits);
}

/** Обрезает строку, схлопывает пробелы и убирает управляющие символы. */
function text(value, max = 0) {
  if (value === null || value === undefined) return '';
  const out = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max > 0 && out.length > max ? out.slice(0, max).trim() : out;
}

function subjectOf(env) {
  const raw = String(env.VAPID_SUBJECT || '').trim();
  if (raw.startsWith('mailto:') || raw.startsWith('https://')) return raw;
  return 'mailto:nastavnik@example.com';
}

/**
 * Заголовок авторизации VAPID: JWT (ES256) + публичный ключ.
 * `aud` — origin push-сервиса, `sub` — контакт владельца приложения.
 */
export async function vapidHeaders(endpoint, env, now = Date.now()) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) throw new Error('VAPID-ключи не заданы');

  const pub = b64uDecode(publicKey);
  const priv = b64uDecode(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error('VAPID_PUBLIC_KEY должен быть несжатой точкой P-256 (65 байт)');
  }
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY должен быть 32 байта');

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64uEncode(pub.slice(1, 33)),
      y: b64uEncode(pub.slice(33, 65)),
      d: b64uEncode(priv),
      ext: true
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const origin = new URL(endpoint).origin;
  const header = b64uEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(
    encoder.encode(
      JSON.stringify({
        aud: origin,
        exp: Math.floor(now / 1000) + VAPID_TTL_S,
        sub: subjectOf(env)
      })
    )
  );
  const data = encoder.encode(`${header}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));
  return { authorization: `vapid t=${header}.${payload}.${b64uEncode(signature)}, k=${publicKey}` };
}

/**
 * Шифрует сообщение для конкретной подписки по RFC 8291 (aes128gcm).
 *
 * Схема:
 *   shared = ECDH(эфемерный ключ воркера, p256dh подписчика)
 *   ikm    = HKDF(auth_secret, shared, "WebPush: info\0" ‖ p256dh ‖ эфемерный)
 *   cek    = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
 *   nonce  = HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
 *   тело   = salt(16) ‖ rs(4) ‖ len(1) ‖ эфемерный ключ(65) ‖ AES-GCM(текст ‖ 0x02)
 */
export async function encryptPush(payload, subscription) {
  const keys = subscription?.keys || {};
  const p256dh = b64uDecode(keys.p256dh);
  const auth = b64uDecode(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('Некорректный p256dh в подписке');
  if (auth.length !== 16) throw new Error('Некорректный auth в подписке');

  const uaPublic = await crypto.subtle.importKey(
    'raw',
    p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits'
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, ephemeral.privateKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info = concat(encoder.encode('WebPush: info\0'), p256dh, asPublic);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 — маркер последней записи (padding delimiter), как в RFC 8188.
  const plaintext = concat(
    payload instanceof Uint8Array ? payload : encoder.encode(String(payload)),
    new Uint8Array([2])
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext)
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Одна доставка. `gone` — подписка мертва (404/410), её нужно удалить. */
export async function sendToSubscription(subscription, message, env, opts = {}) {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = encoder.encode(JSON.stringify(message));
  const encrypted = await encryptPush(body, subscription);
  const headers = new Headers({
    ttl: '86400',
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    'content-length': String(encrypted.length),
    urgency: 'normal'
  });
  headers.set('authorization', (await vapidHeaders(subscription.endpoint, env, now)).authorization);

  const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body: encrypted });
  const status = Number(response.status) || 0;
  return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 };
}

/* --------------------------------------------------------------- хранилище */

/** KV есть только после `wrangler kv namespace create PUSH_KV` и биндинга. */
function kvOf(env) {
  const kv = env?.PUSH_KV;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

async function readRecord(kv, deviceId) {
  try {
    const record = await kv.get(KEY_PREFIX + deviceId, 'json');
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

async function writeRecord(kv, record) {
  // TTL сбрасывается при каждом обновлении: забытое устройство удалится само.
  await kv.put(KEY_PREFIX + record.deviceId, JSON.stringify(record), { expirationTtl: RECORD_TTL_S });
}

function cleanDeviceId(value) {
  const id = text(value, 64);
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : '';
}

/** Подписка браузера: endpoint + ключи. Всё остальное отбрасываем. */
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = text(raw.endpoint, 1024);
  if (!/^https:\/\//i.test(endpoint)) return null;
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const p256dh = text(keys.p256dh, 200);
  const auth = text(keys.auth, 100);
  if (!p256dh || !auth) return null;
  try {
    if (b64uDecode(p256dh).length !== 65 || b64uDecode(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** Только hash-маршруты приложения: чужие ссылки в уведомлении не открываем. */
function safeUrl(value) {
  const url = text(value, MAX_URL);
  return url.startsWith('#/') ? url : '';
}

/** Расписание от клиента: время в пределах разумного, без дублей, по порядку. */
function normalizeItems(raw, now) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, MAX_ITEMS * 2)) {
    if (!item || typeof item !== 'object') continue;
    const at = Number(item.at);
    if (!Number.isFinite(at) || at < now - MAX_BEHIND_MS || at > now + MAX_AHEAD_MS) continue;
    const tag = text(item.tag, MAX_TAG);
    const title = text(item.title, MAX_TITLE);
    if (!tag || !title || seen.has(tag)) continue;
    seen.add(tag);
    out.push({
      at: Math.round(at),
      title,
      body: text(item.body, MAX_BODY),
      tag,
      url: safeUrl(item.url)
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, MAX_ITEMS);
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('Слишком большое тело запроса');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/* ------------------------------------------------------------------- роуты */

/**
 * Обрабатывает `/api/push/*`. Возвращает `null`, если путь не наш.
 * `ctx.json` — общий ответ с CORS из deepseek-proxy.js.
 */
export async function handlePush(request, env, ctx) {
  const { path, json } = ctx;
  const method = request.method;
  const kv = kvOf(env);
  const hasKeys = Boolean(
    String(env.VAPID_PUBLIC_KEY || '').trim() && String(env.VAPID_PRIVATE_KEY || '').trim()
  );

  if (path === '/api/push/config') {
    if (method !== 'GET') return json({ error: 'Метод не поддерживается' }, 405);
    if (!hasKeys) {
      return json({ error: 'Напоминания не настроены: задайте VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY' }, 503);
    }
    if (!kv) {
      return json({ error: 'Напоминания не настроены: нет KV-хранилища PUSH_KV' }, 503);
    }
    return json({
      ok: true,
      publicKey: String(env.VAPID_PUBLIC_KEY).trim(),
      maxItems: MAX_ITEMS,
      subscriptions: MAX_SUBSCRIPTIONS
    });
  }

  if (!hasKeys || !kv) {
    return json({ error: 'Напоминания не настроены на воркере (VAPID-ключи и PUSH_KV)' }, 503);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Некорректный JSON' }, 400);
  }

  const deviceId = cleanDeviceId(body.deviceId);
  if (!deviceId) return json({ error: 'Некорректный deviceId' }, 400);
  const now = Date.now();

  if (path === '/api/push/subscribe') {
    const record = (await readRecord(kv, deviceId)) || {
      deviceId,
      createdAt: now,
      subscriptions: [],
      items: []
    };

    if (method === 'DELETE') {
      const endpoint = text(body.endpoint, 1024);
      record.subscriptions = (Array.isArray(record.subscriptions) ? record.subscriptions : []).filter(
        (item) => item.endpoint !== endpoint
      );
      record.updatedAt = now;
      record.lastSeenAt = now;
      if (!record.subscriptions.length) {
        await kv.delete(KEY_PREFIX + deviceId);
        return json({ ok: true, subscriptions: 0, removed: true });
      }
      await writeRecord(kv, record);
      return json({ ok: true, subscriptions: record.subscriptions.length });
    }

    if (method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
    const subscription = normalizeSubscription(body.subscription);
    if (!subscription) return json({ error: 'Некорректная подписка браузера' }, 400);

    const others = (Array.isArray(record.subscriptions) ? record.subscriptions : []).filter(
      (item) => item.endpoint !== subscription.endpoint
    );
    record.subscriptions = [
      ...others,
      { ...subscription, label: text(body.label, 40), addedAt: now }
    ].slice(-MAX_SUBSCRIPTIONS);
    record.lastSeenAt = now;
    record.updatedAt = now;
    await writeRecord(kv, record);
    return json({
      ok: true,
      subscriptions: record.subscriptions.length,
      items: Array.isArray(record.items) ? record.items.length : 0
    });
  }

  if (path === '/api/push/schedule') {
    if (method !== 'PUT' && method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
    const record = (await readRecord(kv, deviceId)) || {
      deviceId,
      createdAt: now,
      subscriptions: [],
      items: []
    };
    const items = normalizeItems(body.items, now);
    record.items = items;
    record.updatedAt = now;
    record.lastSeenAt = now;
    await writeRecord(kv, record);
    return json({
      ok: true,
      items: items.length,
      subscriptions: Array.isArray(record.subscriptions) ? record.subscriptions.length : 0,
      nextAt: items[0]?.at ?? null
    });
  }

  if (path === '/api/push/test') {
    if (method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
    const record = await readRecord(kv, deviceId);
    const subscriptions = Array.isArray(record?.subscriptions) ? record.subscriptions : [];
    if (!subscriptions.length) {
      return json({ error: 'Нет активных подписок: включите напоминания на устройстве' }, 409);
    }
    const message = {
      title: 'Наставник',
      body: 'Тестовое уведомление: напоминания работают.',
      tag: 'test',
      url: '#/settings'
    };
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        const result = await sendToSubscription(subscription, message, env, { now });
        if (result.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return json({ ok: sent > 0, sent, failed });
  }

  return null;
}

/* --------------------------------------------------------------- cron-цикл */

/**
 * Вызывается Cloudflare по расписанию (раз в минуту): отправляет всё, что
 * уже созрело, и оставляет в очереди только будущее. Устройства без подписок
 * и с мёртвыми endpoint'ами удаляются — иначе KV копил бы мусор.
 */
export async function runScheduled(env, opts = {}) {
  const kv = kvOf(env);
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const empty = { devices: 0, sent: 0, failed: 0, dropped: 0 };

  if (!kv) return { ok: false, skipped: 'no-kv', ...empty };
  if (!String(env.VAPID_PUBLIC_KEY || '').trim() || !String(env.VAPID_PRIVATE_KEY || '').trim()) {
    return { ok: false, skipped: 'no-keys', ...empty };
  }

  let cursor;
  let devices = 0;
  let sent = 0;
  let failed = 0;
  let dropped = 0;

  do {
    const page = await kv.list({ prefix: KEY_PREFIX, limit: 200, cursor });
    cursor = page.list_complete ? null : page.cursor;

    for (const key of page.keys || []) {
      const record = await kv.get(key.name, 'json');
      if (!record) continue;
      devices += 1;

      const subscriptions = Array.isArray(record.subscriptions) ? record.subscriptions : [];
      if (!subscriptions.length) {
        await kv.delete(key.name);
        continue;
      }

      const items = Array.isArray(record.items) ? record.items : [];
      const alive = items.filter((item) => Number(item.at) > now + LATE_WINDOW_MS);
      const due = items.filter((item) => Number(item.at) <= now + LATE_WINDOW_MS);

      if (!due.length) {
        // Только «протухшее»: чистим очередь, ничего не отправляя.
        if (alive.length !== items.length) {
          record.items = alive;
          await writeRecord(kv, record);
        }
        continue;
      }

      const liveSubscriptions = [];
      for (const subscription of subscriptions) {
        let gone = false;
        for (const item of due) {
          try {
            const result = await sendToSubscription(subscription, item, env, { now, fetchImpl });
            if (result.ok) sent += 1;
            else if (result.gone) {
              gone = true;
              break;
            } else failed += 1;
          } catch (err) {
            failed += 1;
            console.log(`[push] ✖ доставка: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
        if (gone) dropped += 1;
        else liveSubscriptions.push(subscription);
      }

      if (!liveSubscriptions.length) {
        await kv.delete(key.name);
        continue;
      }

      record.subscriptions = liveSubscriptions;
      record.items = alive;
      await writeRecord(kv, record);
    }
  } while (cursor);

  if (sent || failed || dropped) {
    console.log(
      `[push] cron: устройств ${devices}, отправлено ${sent}, ошибок ${failed}, удалено подписок ${dropped}`
    );
  }
  return { ok: true, skipped: '', devices, sent, failed, dropped };
}




