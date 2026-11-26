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
    if (request.signal) {
      request.signal.addEventListener('abort', () => {
        console.log(`[proxy] ✖ клиент закрыл соединение через ${Date.now() - startedAt} мс`);
      });
    }

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[proxy] ✖ upstream недоступен через ${Date.now() - startedAt} мс: ${message}`);
      return json({ error: `Не удалось связаться с DeepSeek: ${message}` }, 502, allowOrigin);
    }

    console.log(
      `[proxy] ← ${upstream.status} за ${Date.now() - startedAt} мс (заголовки upstream${isStream ? ', стрим' : ''})`
    );

    const resHeaders = corsHeaders(allowOrigin, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // отключает буферизацию у промежуточных прокси — стрим идёт сразу
      'x-accel-buffering': 'no'
    });

    // Для стрима считаем байты: в логах видно объём и момент завершения.
    let body = upstream.body;
    if (isStream && body) {
      let bytes = 0;
      body = body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            bytes += chunk.byteLength || 0;
            controller.enqueue(chunk);
          },
          flush() {
            console.log(`[proxy] ✔ стрим завершён: ${bytes} Б за ${Date.now() - startedAt} мс`);
          }
        })
      );
    }

    return new Response(body, { status: upstream.status, headers: resHeaders });
  }
};
