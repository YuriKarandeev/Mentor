/**
 * Чистая логика отправителя напоминаний — без Firebase и web-push.
 *
 * Здесь только то, что можно проверить офлайн (`npm run test:push`):
 * какие элементы плана созрели, что уже отправлено, какой payload уходит
 * в браузер и каких секретов не хватает. Сам запуск — в `send.mjs`.
 *
 * Схема данных (её пишет приложение, см. `src/lib/push/client.ts`):
 *   users/{uid}/push/{deviceId}      — endpoint + keys подписки
 *   users/{uid}/pushPlan/{deviceId}  — { items: [{ key, at, title, body, tag, url }], testAt? }
 *   users/{uid}/pushState/{deviceId} — { sent: { key: ISO }, lastRunAt, lastError }
 */

/** Сколько уведомлений отправляем устройству за один запуск. */
export const MAX_PER_RUN = 5;
/**
 * Просроченное напоминание старше этого окна не отправляем: если workflow
 * не запускался полдня (лимит Actions, отключение cron), спамить не нужно.
 */
export const GRACE_MS = 12 * 3600_000;
/** Сколько помним отметки об отправке: столько же, сколько живёт план. */
export const SENT_TTL_MS = 7 * 86400_000;
/** Запрос «проверить доставку» живёт столько же, сколько окно cron-запуска. */
export const TEST_TTL_MS = 15 * 60_000;

export const MAX_TITLE = 120;
export const MAX_BODY = 240;
export const MAX_URL = 200;

/** Обязательные секреты workflow. */
export const REQUIRED_SECRETS = [
  'FIREBASE_SERVICE_ACCOUNT',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT'
];

/** ISO-строка, число, Timestamp или Date → миллисекунды; NaN — значения нет. */
export function parseMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  if (value && typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/** Строка не длиннее `max` символов, без ведущих и хвостовых пробелов. */
export function clip(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

/**
 * Валидные элементы плана. Мусор (нет ключа, битая дата) отбрасывается молча:
 * один испорченный элемент не должен останавливать рассылку остальных.
 */
export function planItems(plan) {
  const raw = Array.isArray(plan?.items) ? plan.items : [];
  const out = [];
  for (const entry of raw) {
    const at = parseMs(entry?.at);
    const key = String(entry?.key ?? entry?.tag ?? '').trim();
    if (!Number.isFinite(at) || !key) continue;
    out.push({ key, at, title: entry?.title, body: entry?.body, tag: entry?.tag, url: entry?.url });
  }
  return out;
}

/**
 * Созревшие напоминания устройства.
 *
 * `sent` — карта `ключ → ISO отправки` из `pushState`: по ней повторы
 * исключены даже если план перезаписали между запусками.
 */
export function dueNow(plan, { now = Date.now(), sent = {}, limit = MAX_PER_RUN } = {}) {
  const done = sent && typeof sent === 'object' ? sent : {};
  const due = [];
  for (const item of planItems(plan)) {
    if (item.at > now) continue;
    if (now - item.at > GRACE_MS) continue;
    if (Object.hasOwn(done, item.key)) continue;
    due.push(item);
  }
  due.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at - b.at));
  return due.slice(0, Math.max(0, Math.trunc(limit)));
}

/** Убирает из `sent` отметки старше `ttl`: документ не должен расти вечно. */
export function pruneSent(sent, now = Date.now(), ttl = SENT_TTL_MS) {
  const out = {};
  if (!sent || typeof sent !== 'object') return out;
  for (const [key, value] of Object.entries(sent)) {
    const at = parseMs(value);
    if (!Number.isFinite(at) || now - at > ttl) continue;
    out[key] = new Date(at).toISOString();
  }
  return out;
}

/**
 * Момент запроса «проверить доставку», если его ещё нужно выполнить.
 *
 * Сравнение с `lastTestAt` в состоянии важно: даже если стереть `testAt`
 * из плана не удалось, второй раз тот же запрос не отправится. А новый
 * запрос (новый `testAt`) пройдёт снова.
 */
export function pendingTestAt(plan, state, now = Date.now(), ttl = TEST_TTL_MS) {
  const at = parseMs(plan?.testAt);
  if (!Number.isFinite(at)) return 0;
  if (now < at || now - at > ttl) return 0;
  if (parseMs(state?.lastTestAt) === at) return 0;
  return at;
}

/**
 * Данные уведомления ровно в том виде, в котором их ждёт `public/push-sw.js`:
 * `{ title, body, tag, url }`.
 */
export function pushPayload(item) {
  const payload = {
    title: clip(item?.title, MAX_TITLE) || 'Наставник',
    body: clip(item?.body, MAX_BODY) || 'Пора заняться делами.'
  };
  const tag = clip(item?.tag ?? item?.key, MAX_TITLE);
  const url = clip(item?.url, MAX_URL);
  if (tag) payload.tag = tag;
  if (url) payload.url = url;
  return payload;
}

/** Тестовое уведомление (режим `test` и запрос `testAt` из приложения). */
export function testPayload() {
  return {
    title: 'Наставник · проверка',
    body: 'Тестовое уведомление от GitHub Actions: доставка напоминаний работает.',
    tag: 'test:server',
    url: '#/settings'
  };
}

/** Каких секретов не хватает; пустой массив — всё задано. */
export function missingSecrets(env = {}) {
  return REQUIRED_SECRETS.filter((name) => !String(env?.[name] ?? '').trim());
}

/** Подписка умерла (браузер её отозвал) — документ надо удалить. */
export function shouldDropSubscription(statusCode) {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Повторять такую ошибку бессмысленно (payload не принят), но и удалять
 * подписку нельзя: помечаем как отправленное, чтобы не зациклиться.
 */
export function shouldStopRetry(statusCode) {
  return statusCode === 400 || statusCode === 413;
}
