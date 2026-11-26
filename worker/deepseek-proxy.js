/**
 * Cloudflare Worker — прокси к DeepSeek API.
 *
 * Зачем: ключ DeepSeek не попадает в браузер. Клиент (PWA «Наставник»)
 * обращается к воркеру и присылает только короткий x-app-token.
 *
 * Маршруты воркера (всё остальное — 404). Клиент ходит с префиксом /api,
 * а у DeepSeek маршруты без него — префикс срезается при проксировании:
 *   GET  /health               — проверка живости воркера (до DeepSeek не идёт)
 *   GET  /api/models           → GET  /models
 *   GET  /api/user/balance     → GET  /user/balance
 *   POST /api/chat/completions → POST /chat/completions (в т.ч. stream: true, ответ идёт потоком)
 *
 * Диагностика: каждый запрос к /api/* пишет в лог (wrangler tail) время до
 * заголовков DeepSeek, статус upstream, объём и длительность стрима, а также
 * отдельную строку, если соединение закрыл клиент. Секреты в логи не попадают.
 *
 * Секреты (wrangler secret put ...):
 *   DEEPSEEK_API_KEY — ключ DeepSeek (обязательно)
 *   APP_TOKEN        — токен приложения, который вводится в настройках PWA (обязательно)
 * Переменные окружения (wrangler.toml [vars]):
 *   ALLOWED_ORIGINS  — список origin через запятую; пусто = разрешены все
 */

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const TOKEN_HEADER = 'x-app-token';

/** Сколько ждём заголовки DeepSeek, прежде чем ответить клиенту понятной ошибкой. */
const HEADERS_TIMEOUT_MS = 60_000;
/** Пинг в простое: держит SSE-соединение живым, пока модель думает или ищет в вебе. */
const STREAM_IDLE_PING_MS = 10_000;
/** Жёсткий предел длительности стрима — клиент не должен ждать бесконечно. */
const STREAM_LIMIT_MS = 240_000;

const SSE_PING = new TextEncoder().encode(': ping\n\n');

/** Кадр SSE с ошибкой: клиент покажет текст, а не «Load failed». */
function sseErrorFrame(message) {
  return new TextEncoder().encode(
    `event: error\ndata: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`
  );
}

/**
 * Обёртка над телом ответа DeepSeek:
 * - считает байты для лога (видно объём и момент завершения);
 * - в простое отправляет SSE-комментарий `: ping` — клиент его игнорирует,
 *   но Cloudflare и мобильный Safari не закрывают соединение по простою;
 * - при превышении STREAM_LIMIT_MS присылает понятную ошибку и закрывает поток;
 * - при отмене клиентом останавливает таймеры (чтение upstream отменяется само).
 */
function keepAliveStream({ startedAt }) {
  let bytes = 0;
  let finished = false;
  let pingTimer = null;
  let limitTimer = null;

  const stopTimers = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    if (limitTimer !== null) clearTimeout(limitTimer);
    pingTimer = null;
    limitTimer = null;
  };

  return new TransformStream({
    start(controller) {
      pingTimer = setInterval(() => {
        if (finished) return;
        try {
          controller.enqueue(SSE_PING);
        } catch {
          stopTimers();
        }
      }, STREAM_IDLE_PING_MS);

      limitTimer = setTimeout(() => {
        if (finished) return;
        const seconds = Math.round(STREAM_LIMIT_MS / 1000);
        console.log(`[proxy] ✖ стрим дольше ${seconds} с — закрываю (${bytes} Б)`);
        try {
          controller.enqueue(
            sseErrorFrame(`Ответ идёт дольше ${seconds} с. Попробуйте ещё раз или уменьшите глубину размышлений.`)
          );
        } catch {
          /* поток уже закрыт */
        }
        finished = true;
        stopTimers();
        try {
          controller.terminate();
        } catch {
          /* terminate не поддерживается — поток закроется сам */
        }
      }, STREAM_LIMIT_MS);
    },
    transform(chunk, controller) {
      bytes += chunk.byteLength || 0;
      controller.enqueue(chunk);
    },
    flush() {
      finished = true;
      stopTimers();
      console.log(`[proxy] ✔ стрим завершён: ${bytes} Б за ${Date.now() - startedAt} мс`);
    },
    cancel() {
      finished = true;
      stopTimers();
      console.log(`[proxy] ✖ стрим отменён клиентом: ${bytes} Б за ${Date.now() - startedAt} мс`);
    }
  });
}

function corsHeaders(allowOrigin, extra = {}) {
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}, accept`,
    'access-control-max-age': '86400',
    vary: 'Origin',
    ...extra
  };
}

function json(data, status, allowOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(allowOrigin, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  });
}

/** '*' если список origin не задан, иначе — только совпавший origin. */
function pickOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const raw = (env.ALLOWED_ORIGINS || '').trim();
  if (!raw) return '*';
  const allowed = raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!origin) return allowed[0] || 'null';
  return allowed.includes(origin.replace(/\/+$/, '')) ? origin : 'null';
}

/** Сравнение без раннего выхода, чтобы не утекала длина по таймингам. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Время от приёма запроса — по нему в `wrangler tail` видно, где копится задержка.
    const startedAt = Date.now();
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const allowOrigin = pickOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'nastavnik-deepseek-proxy' }, 200, allowOrigin);
    }

    if (!path.startsWith('/api/')) {
      return json({ error: 'Не найдено. Доступны /health и /api/*' }, 404, allowOrigin);
    }

    const expected = (env.APP_TOKEN || '').trim();
    if (!expected) {
      return json({ error: 'На воркере не задан APP_TOKEN (wrangler secret put APP_TOKEN)' }, 500, allowOrigin);
    }
    const provided = (request.headers.get(TOKEN_HEADER) || '').trim();
    if (!safeEqual(provided, expected)) {
      return json({ error: 'Неверный или отсутствующий x-app-token' }, 401, allowOrigin);
    }

    const key = (env.DEEPSEEK_API_KEY || '').trim();
    if (!key) {
      return json({ error: 'На воркере не задан DEEPSEEK_API_KEY (wrangler secret put DEEPSEEK_API_KEY)' }, 500, allowOrigin);
    }

    // Клиент ходит в /api/*, а у DeepSeek маршруты без префикса:
    // /models, /user/balance, /chat/completions (см. шапку файла).
    // Без срезания /api клеился бы несуществующий https://api.deepseek.com/api/models → 404.
    const upstreamPath = path.slice('/api'.length) || '/';
    const target = `${DEEPSEEK_BASE}${upstreamPath}${url.search}`;
    const headers = new Headers();
    headers.set('authorization', `Bearer ${key}`);
    headers.set('accept', request.headers.get('accept') || 'application/json');
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);

    /** @type {RequestInit} */
    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.text();
    }

    const isStream = (request.headers.get('accept') || '').includes('text/event-stream');

    console.log(`[proxy] → ${request.method} ${upstreamPath}${isStream ? ' · stream' : ''}`);

    // Отмена клиентом должна прекращать и запрос к DeepSeek (экономия токенов),
    // а молчание DeepSeek дольше HEADERS_TIMEOUT_MS — не превращаться в вечное ожидание.
    const gateway = new AbortController();
    let headersTimedOut = false;
    const abortGateway = () => gateway.abort();
    request.signal?.addEventListener('abort', abortGateway);
    const headersTimer = setTimeout(() => {
      headersTimedOut = true;
      gateway.abort();
    }, HEADERS_TIMEOUT_MS);
    init.signal = gateway.signal;

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      clearTimeout(headersTimer);
      const message = err instanceof Error ? err.message : String(err);
      if (headersTimedOut) {
        console.log(`[proxy] ✖ DeepSeek не ответил заголовками за ${HEADERS_TIMEOUT_MS} мс`);
        return json(
          { error: `DeepSeek не ответил за ${Math.round(HEADERS_TIMEOUT_MS / 1000)} с. Проверьте связь и повторите запрос.` },
          504,
          allowOrigin
        );
      }
      console.log(`[proxy] ✖ upstream недоступен через ${Date.now() - startedAt} мс: ${message}`);
      return json({ error: `Не удалось связаться с DeepSeek: ${message}` }, 502, allowOrigin);
    }
    clearTimeout(headersTimer);

    console.log(
      `[proxy] ← ${upstream.status} за ${Date.now() - startedAt} мс (заголовки upstream${isStream ? ', стрим' : ''})`
    );

    const resHeaders = corsHeaders(allowOrigin, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // отключает буферизацию у промежуточных прокси — стрим идёт сразу
      'x-accel-buffering': 'no'
    });

    let body = upstream.body;
    if (isStream && body) {
      body = body.pipeThrough(keepAliveStream({ startedAt }));
    }

    return new Response(body, { status: upstream.status, headers: resHeaders });
  }
};

