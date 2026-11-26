/**
 * Cloudflare Worker — прокси к DeepSeek API.
 *
 * Зачем: ключ DeepSeek не попадает в браузер. Клиент (PWA «Наставник»)
 * обращается к воркеру и присылает только короткий x-app-token.
 *
 * Маршруты воркера (всё остальное — 404). Клиент ходит с префиксом /api,
 * а у DeepSeek маршруты без него — префикс срезается при проксировании:
 *   GET  /health               — живость, id версии и текущие лимиты стрима (до DeepSeek не идёт)
 *   GET  /api/diag/stream      — диагностический SSE-стрим с пингами (нужен x-app-token)
 *   GET  /api/diag/burst       — тот же proxyStream поверх фейкового быстрого upstream (?raw=1 — без обёртки)
 *   GET  /api/diag/silent      — то же, но upstream молчит: проверка пингов без DeepSeek
 *   GET  /api/models           → GET  /models
 *   GET  /api/user/balance     → GET  /user/balance
 *   POST /api/chat/completions → POST /chat/completions (в т.ч. stream: true, ответ идёт потоком)
 *
 * Диагностика: каждый запрос к /api/* пишет в лог время до заголовков DeepSeek,
 * статус upstream, объём и длительность стрима, причину обрыва чтения upstream
 * и отдельную строку, если соединение закрыл клиент. Логи смотрите в дашборде
 * Cloudflare (Workers & Pages → воркер → Logs) — `wrangler tail` за нестабильной
 * сетью циклически переподключается. Секреты в логи не попадают.
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

/** Таймер, который можно дождаться и отменить (нужен для `Promise.race` с чтением upstream). */
function timerPromise(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

/** Целое из query-параметра с границами — для диагностических маршрутов. */
function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Поток ответа клиенту поверх тела ответа DeepSeek.
 *
 * История правок — все три ошибки воспроизводились на проде:
 * 1. `pipeThrough(new TransformStream(...))` — пинги enqueue'ились, но до клиента
 *    не доходили (probe:book показывал 4584 Б и 65 с тишины).
 * 2. `async start(controller)` с `await reader.read()` внутри — пока промис
 *    `start()` не разрешён, workerd держит поток в состоянии «starting».
 * 3. Синхронный `start` + `controller.enqueue()` из фонового `pump` — кадры
 *    попадали в очередь, но workerd их не отдавал: `probe:book` получал 4845 Б
 *    из 30108 Б (воркер писал в лог «стрим завершён»), а клиент висел до RST на
 *    ~71 с с `TypeError: terminated`. То же самое на curl и на undici — и со
 *    сжатием, и с `accept-encoding: identity`, — значит дело не в клиенте.
 * 4. Ручная pull-схема (`pull()` возвращает промис, который резолвит фоновый
 *    читатель) — в Node работает, в workerd так же теряет данные.
 * Поэтому теперь используется нативный `IdentityTransformStream` и
 * `writer.write()`: промис записи разрешается движком, когда кадр принят,
 * и только после этого читаем upstream дальше. Это единственная схема, которая
 * на проде отдаёт поток целиком (проверено `probe:book` и `/api/diag/burst`).
 * Для сравнения на боевом маршруте есть `?raw=1` — тот же ответ DeepSeek без
 * обёртки.
 *
 * - в простое пишет SSE-комментарий `: ping` — клиент его игнорирует,
 *   но Cloudflare и мобильный Safari не закрывают соединение по простою;
 * - при превышении STREAM_LIMIT_MS присылает понятную ошибку и закрывает поток;
 * - при отмене клиентом отменяет и чтение upstream (экономия токенов DeepSeek).
 */
function proxyStream(upstreamBody, { startedAt }) {
  // В workerd `IdentityTransformStream` — нативный поток без JS-прослойки:
  // записи в него флашатся клиенту сразу. В Node (офлайн-тесты) его нет,
  // поэтому там обычный TransformStream.
  const canUseNative = typeof IdentityTransformStream === 'function';
  const { readable, writable } = canUseNative ? new IdentityTransformStream() : new TransformStream();
  const writer = writable.getWriter();

  let cancelled = false;
  let bytes = 0;
  let pings = 0;
  /** @type {ReadableStreamDefaultReader | null} */
  let reader = null;

  /**
   * Запись кадра клиенту. `writer.write()` возвращает промис, который
   * разрешается, когда данные приняты потоком (с учётом backpressure) —
   * именно это заставляет workerd отдать их клиенту.
   */
  const write = (chunk) => writer.write(chunk);

  /**
   * Фоновая задача: читает upstream и параллельно шлёт пинги в простое.
   *
   * Запускается сразу после создания потока (не из `async start`): pending
   * промис в `start` держит поток в состоянии «starting», и кадры не доходят.
   * Пинг ждётся в том же awaited-контексте, что и `reader.read()`.
   */
  const pump = async () => {
    let lastPingAt = Date.now();

    try {
      reader = upstreamBody.getReader();
      let pending = reader.read();
      for (;;) {
        if (cancelled) return;
        const elapsed = Date.now() - startedAt;

        if (elapsed >= STREAM_LIMIT_MS) {
          const seconds = Math.round(STREAM_LIMIT_MS / 1000);
          console.log(`[proxy] ✖ стрим дольше ${seconds} с — закрываю (${bytes} Б, пингов ${pings})`);
          await write(
            sseErrorFrame(`Ответ идёт дольше ${seconds} с. Попробуйте ещё раз или уменьшите глубину размышлений.`)
          );
          return;
        }

        // Ждём либо чанк от DeepSeek, либо момент очередного пинга (что раньше).
        const waitMs = Math.max(
          0,
          Math.min(STREAM_IDLE_PING_MS - (Date.now() - lastPingAt), STREAM_LIMIT_MS - elapsed)
        );
        const tick = timerPromise(waitMs);
        const next = await Promise.race([
          // reject чтения превращаем в значение: иначе при гонке с таймером
          // получился бы необработанный rejected promise (и ошибка бы терялась).
          pending.then(
            (result) => ({ kind: 'chunk', result }),
            (error) => ({ kind: 'error', error })
          ),
          tick.promise.then(() => ({ kind: 'timeout' }))
        ]);
        tick.cancel();

        if (next.kind === 'error') throw next.error;

        if (next.kind === 'chunk') {
          const { done, value } = next.result;
          if (done) {
            console.log(
              `[proxy] ✔ стрим завершён: ${bytes} Б за ${Date.now() - startedAt} мс (пингов ${pings})`
            );
            return;
          }
          bytes += value?.byteLength || 0;
          await write(value);
          pending = reader.read();
          continue;
        }

        // DeepSeek молчит — держим соединение пингом.
        lastPingAt = Date.now();
        pings += 1;
        if (pings === 1 || pings % 6 === 0) {
          console.log(`[proxy] · ping ${pings} @ ${lastPingAt - startedAt} мс (от DeepSeek ${bytes} Б)`);
        }
        await write(SSE_PING);
      }
    } catch (err) {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[proxy] ✖ чтение upstream прервано через ${Date.now() - startedAt} мс (${bytes} Б, пингов ${pings}): ${message}`
      );
      try {
        await write(
          sseErrorFrame(
            `Соединение с DeepSeek прервалось (${message}). Повторите запрос — уже полученный текст сохранится как черновик.`
          )
        );
      } catch {
        /* клиент уже ушёл — кадр с ошибкой ему не нужен */
      }
    } finally {
      try {
        await writer.close();
      } catch {
        /* поток уже закрыт или клиент ушёл */
      }
      reader?.cancel()?.catch(() => {});
    }
  };

  // Стрим стартует сразу: Response уходит клиенту, как только воркер вернёт его,
  // а тело наполняется из фоновой задачи.
  void pump().catch((err) => {
    console.log(`[proxy] ✖ фоновая задача стрима упала: ${err instanceof Error ? err.message : String(err)}`);
    cancelled = true;
    writer.abort?.(err)?.catch?.(() => {});
  });

  return readable;
}

/**
 * Фейковый upstream для диагностических маршрутов: быстро отдаёт `chunks`
 * чанков по `size` байт, затем (если задано) молчит `silentMs` и закрывается.
 *
 * Чтение идёт через `pull`, как у настоящего сетевого тела: `async start`
 * в workerd сам держит поток в состоянии «starting» и дал бы ложную картину.
 */
function fakeUpstream({ chunks, size, gapMs, silentMs }) {
  let sent = 0;
  let waitedSilence = false;
  return new ReadableStream({
    async pull(controller) {
      if (sent < chunks) {
        sent += 1;
        // Новый буфер на каждый чанк: workerd может «отсоединять» переданный
        // ArrayBuffer, и повторная отправка того же объекта теряет данные.
        controller.enqueue(new Uint8Array(size).fill(0x78)); // 'x'
        if (gapMs > 0) await timerPromise(gapMs).promise;
        return;
      }
      if (silentMs > 0 && !waitedSilence) {
        waitedSilence = true;
        await timerPromise(silentMs).promise;
        return;
      }
      controller.close();
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
    // Время от приёма запроса — по нему в логах воркера видно, где копится задержка.
    const startedAt = Date.now();
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const allowOrigin = pickOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    if (path === '/' || path === '/health') {
      // Версия и лимиты в ответе: так видно, что на проде именно свежий деплой,
      // без `wrangler tail` (id совпадает с `Current Version ID` из вывода deploy).
      const version = env.CF_VERSION_METADATA;
      return json(
        {
          ok: true,
          service: 'nastavnik-deepseek-proxy',
          version: version?.id ?? null,
          tag: version?.tag ?? null,
          deployedAt: version?.timestamp ?? null,
          stream: {
            headersTimeoutMs: HEADERS_TIMEOUT_MS,
            idlePingMs: STREAM_IDLE_PING_MS,
            limitMs: STREAM_LIMIT_MS
          }
        },
        200,
        allowOrigin
      );
    }

    if (!path.startsWith('/api/')) {
      return json({ error: 'Не найдено. Доступны /health, /api/diag/stream и /api/*' }, 404, allowOrigin);
    }

    const expected = (env.APP_TOKEN || '').trim();
    if (!expected) {
      return json({ error: 'На воркере не задан APP_TOKEN (wrangler secret put APP_TOKEN)' }, 500, allowOrigin);
    }
    const provided = (request.headers.get(TOKEN_HEADER) || '').trim();
    if (!safeEqual(provided, expected)) {
      return json({ error: 'Неверный или отсутствующий x-app-token' }, 401, allowOrigin);
    }

    // Диагностика канала: SSE-стрим с пингами, не зависящий от DeepSeek.
    // Нужен, потому что главный подозреваемый в обрывах «Load failed» — простой
    // соединения, пока модель ищет в вебе: `curl -N /api/diag/stream?seconds=60`
    // должен приносить 8 Б каждые `ping` секунд (по умолчанию 10).
    if (path === '/api/diag/stream') {
      const seconds = Math.min(Math.max(Number(url.searchParams.get('seconds')) || 30, 2), 300);
      const pingSeconds = Math.min(Math.max(Number(url.searchParams.get('ping')) || STREAM_IDLE_PING_MS / 1000, 1), 60);
      const encoder = new TextEncoder();
      const diagStartedAt = Date.now();
      const endAt = diagStartedAt + seconds * 1000;
      const pingMs = pingSeconds * 1000;
      let sentBytes = 0;
      let pings = 0;
      let finished = false;

      const stream = new ReadableStream({
        start(controller) {
          const push = (text) => {
            const chunk = encoder.encode(text);
            sentBytes += chunk.byteLength;
            controller.enqueue(chunk);
          };
          push(`data: ${JSON.stringify({ ok: true, event: 'start', seconds, pingSeconds })}\n\n`);

          // Пинги ждём в awaited-цикле, а не в setInterval: ровно так устроен pump()
          // боевого стрима, поэтому тест канала проверяет тот же механизм.
          void (async () => {
            let nextPingAt = diagStartedAt + pingMs;
            try {
              for (;;) {
                const waitMs = Math.min(nextPingAt, endAt) - Date.now();
                if (waitMs > 0) await timerPromise(waitMs).promise;
                if (Date.now() >= endAt) break;
                controller.enqueue(SSE_PING);
                sentBytes += SSE_PING.byteLength;
                pings += 1;
                nextPingAt += pingMs;
                // если воркер «проспал» несколько тиков — не спамим пачкой пингов
                if (nextPingAt <= Date.now()) nextPingAt = Date.now() + pingMs;
              }
            } catch {
              /* клиент ушёл — end всё равно попробуем отправить */
            } finally {
              if (!finished) {
                finished = true;
                try {
                  push(
                    `data: ${JSON.stringify({
                      ok: true,
                      event: 'end',
                      elapsedMs: Date.now() - diagStartedAt,
                      bytes: sentBytes,
                      pings
                    })}\n\ndata: [DONE]\n\n`
                  );
                  controller.close();
                } catch {
                  /* клиент уже ушёл */
                }
              }
              console.log(
                `[proxy] diag/stream: ${seconds} с, пинг ${pingSeconds} с, пингов ${pings}, ${sentBytes} Б за ${Date.now() - diagStartedAt} мс`
              );
            }
          })();
        }
      });

      console.log(`[proxy] → diag/stream на ${seconds} с (пинг ${pingSeconds} с)`);
      return new Response(stream, {
        status: 200,
        headers: corsHeaders(allowOrigin, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          // отключает буферизацию у промежуточных прокси — стрим идёт сразу
          'x-accel-buffering': 'no'
        })
      });
    }

    // Диагностика механизма стрима без DeepSeek: тот же proxyStream, но поверх
    // фейкового upstream. Нужна, когда «на проде рвётся», а разбираться с живым
    // DeepSeek долго и дорого:
    //   /api/diag/burst?chunks=200&size=160  — быстрый поток, проверка доставки
    //   /api/diag/silent?seconds=45          — молчание, проверка пингов
    // `raw=1` отдаёт тот же upstream без обёртки: сравнение показывает, виноват
    // ли proxyStream или сам канал. Заголовок x-diag-expected-bytes — сколько
    // байт должно дойти до клиента.
    if (path === '/api/diag/burst' || path === '/api/diag/silent') {
      const silent = path.endsWith('silent');
      const seconds = clampInt(url.searchParams.get('seconds'), silent ? 45 : 0, 0, 300);
      const chunks = clampInt(url.searchParams.get('chunks'), silent ? 1 : 200, 1, 5000);
      const size = clampInt(url.searchParams.get('size'), 160, 1, 8192);
      const gapMs = clampInt(url.searchParams.get('gap'), silent ? 0 : 2, 0, 1000);
      const raw = url.searchParams.get('raw') === '1';
      const diagStartedAt = Date.now();
      const upstreamBody = fakeUpstream({
        chunks,
        size,
        gapMs,
        silentMs: silent ? seconds * 1000 : 0
      });
      console.log(
        `[proxy] → diag/${silent ? 'silent' : 'burst'}: ${chunks}×${size} Б, пауза ${gapMs} мс, ` +
          `молчание ${silent ? seconds : 0} с, raw=${raw}`
      );
      return new Response(raw ? upstreamBody : proxyStream(upstreamBody, { startedAt: diagStartedAt }), {
        status: 200,
        headers: corsHeaders(allowOrigin, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          // отключает буферизацию у промежуточных прокси — стрим идёт сразу
          'x-accel-buffering': 'no',
          'x-diag-expected-bytes': String(chunks * size),
          'x-diag-raw': raw ? '1' : '0'
        })
      });
    }

    // Диагностика DeepSeek без стриминга клиенту: воркер сам вычитывает
    // upstream до конца и отдаёт статистику JSON'ом. Нужна, чтобы отделить
    // «DeepSeek молчит/рвёт» от «кадры не доходят до клиента».
    //   POST /api/diag/collect?seconds=90&z=1   (тело — как у /chat/completions)
    // z=1 — попросить у DeepSeek accept-encoding: identity.
    if (path === '/api/diag/collect') {
      const apiKey = (env.DEEPSEEK_API_KEY || '').trim();
      if (!apiKey) {
        return json({ error: 'На воркере не задан DEEPSEEK_API_KEY' }, 500, allowOrigin);
      }
      const limitMs = clampInt(url.searchParams.get('seconds'), 120, 5, 240) * 1000;
      const identity = url.searchParams.get('z') === '1';
      const payload = await request.text();
      const collectHeaders = new Headers();
      collectHeaders.set('authorization', `Bearer ${apiKey}`);
      collectHeaders.set('content-type', 'application/json');
      collectHeaders.set('accept', 'text/event-stream');
      if (identity) collectHeaders.set('accept-encoding', 'identity');

      const collectStartedAt = Date.now();
      let upstreamRes;
      try {
        upstreamRes = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
          method: 'POST',
          headers: collectHeaders,
          body: payload
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ ok: false, stage: 'fetch', error: message, elapsedMs: Date.now() - collectStartedAt }, 502, allowOrigin);
      }

      const collectReader = upstreamRes.body?.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let chunks = 0;
      let maxGapMs = 0;
      let lastChunkAt = Date.now();
      let firstChunkMs = null;
      let sawDone = false;
      let mode = 'unknown';
      let error = null;
      let tail = '';

      try {
        if (collectReader) {
          for (;;) {
            if (Date.now() - collectStartedAt >= limitMs) {
              mode = 'limit';
              break;
            }
            const { done, value } = await collectReader.read();
            if (done) {
              mode = 'eof';
              break;
            }
            const now = Date.now();
            if (firstChunkMs === null) firstChunkMs = now - collectStartedAt;
            maxGapMs = Math.max(maxGapMs, now - lastChunkAt);
            lastChunkAt = now;
            chunks += 1;
            bytes += value?.byteLength || 0;
            tail = (tail + decoder.decode(value, { stream: true })).slice(-300);
            if (tail.includes('[DONE]')) {
              sawDone = true;
              mode = 'done';
              break;
            }
          }
          await collectReader.cancel().catch(() => {});
        } else {
          mode = 'no-body';
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        mode = 'error';
      }

      console.log(
        `[proxy] diag/collect: ${bytes} Б, чанков ${chunks}, макс. пауза ${maxGapMs} мс, ` +
          `режим ${mode}, encoding ${upstreamRes.headers.get('content-encoding') || 'нет'}` +
          `${error ? `, ошибка ${error}` : ''}`
      );
      return json(
        {
          ok: !error,
          status: upstreamRes.status,
          contentEncoding: upstreamRes.headers.get('content-encoding'),
          requestedIdentity: identity,
          bytes,
          chunks,
          firstChunkMs,
          maxGapMs,
          sawDone,
          mode,
          error,
          elapsedMs: Date.now() - collectStartedAt,
          tail
        },
        200,
        allowOrigin
      );
    }

    // Генератор без upstream: проверяет, отдаёт ли воркер клиенту большой
    // поток вообще. Если `/api/diag/gen` доходит целиком, а проксирование
    // DeepSeek — нет, значит мешает именно одновременное чтение upstream.
    //   /api/diag/gen?chunks=100&size=1000&gap=0
    if (path === '/api/diag/gen') {
      const chunks = clampInt(url.searchParams.get('chunks'), 100, 1, 5000);
      const size = clampInt(url.searchParams.get('size'), 1000, 1, 8192);
      const gapMs = clampInt(url.searchParams.get('gap'), 0, 0, 1000);
      const genStartedAt = Date.now();
      const unit = new TextEncoder().encode('x'.repeat(size));
      const bare = url.searchParams.get('bare') === '1';
      const whole = url.searchParams.get('whole') === '1';
      const genHeaders = () => {
        if (bare) return { 'content-type': 'text/plain; charset=utf-8' };
        return corsHeaders(allowOrigin, {
          // ct=octet — проверить, не мешает ли сжатие текстового типа;
          // nt=1 — запрет преобразований (no-transform) для промежуточных прокси.
          'content-type':
            url.searchParams.get('ct') === 'octet' ? 'application/octet-stream' : 'text/event-stream; charset=utf-8',
          'cache-control': url.searchParams.get('nt') === '1' ? 'no-store, no-transform' : 'no-store',
          'x-accel-buffering': 'no',
          'x-diag-expected-bytes': String(chunks * size)
        });
      };

      // whole=1 — тот же объём, но одним телом (без chunked-стрима):
      // показывает, ломается ли именно потоковая отдача.
      if (whole) {
        const all = new Uint8Array(chunks * size).fill(0x78);
        console.log(`[proxy] diag/gen whole: ${all.length} Б за ${Date.now() - genStartedAt} мс, bare=${bare}`);
        return new Response(all, { status: 200, headers: genHeaders() });
      }

      const stream = new ReadableStream({
        start(controller) {
          void (async () => {
            for (let i = 0; i < chunks; i += 1) {
              // Копия: workerd может «отсоединять» буфер после enqueue.
              controller.enqueue(unit.slice());
              if (gapMs > 0) await timerPromise(gapMs).promise;
            }
            controller.close();
            console.log(
              `[proxy] diag/gen: ${chunks}×${size} Б отданы за ${Date.now() - genStartedAt} мс (пауза ${gapMs} мс)`
            );
          })().catch((err) => {
            console.log(`[proxy] ✖ diag/gen упал: ${err instanceof Error ? err.message : String(err)}`);
            try {
              controller.close();
            } catch {
              /* уже закрыт */
            }
          });
        }
      });
      return new Response(stream, {
        status: 200,
        headers: genHeaders()
      });
    }

    // Проверка изнутри Cloudflare: воркер сам запрашивает свой же /api/diag/gen
    // и считает, сколько байт дошло. Показывает, виноват ли внешний канал
    // (DPI/сеть клиента) или платформа.
    //   /api/diag/selfcheck?chunks=30&size=1000
    if (path === '/api/diag/selfcheck') {
      const chunks = clampInt(url.searchParams.get('chunks'), 30, 1, 1000);
      const size = clampInt(url.searchParams.get('size'), 1000, 1, 8192);
      const selfStartedAt = Date.now();
      const selfUrl = `${url.origin}/api/diag/gen?chunks=${chunks}&size=${size}&whole=1`;
      let bytes = 0;
      let parts = 0;
      let status = 0;
      let error = null;
      try {
        const selfRes = await fetch(selfUrl, { headers: { [TOKEN_HEADER]: provided } });
        status = selfRes.status;
        const selfReader = selfRes.body?.getReader();
        if (selfReader) {
          for (;;) {
            const { done, value } = await selfReader.read();
            if (done) break;
            parts += 1;
            bytes += value?.byteLength || 0;
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      console.log(
        `[proxy] diag/selfcheck: ${bytes} Б из ${chunks * size} за ${Date.now() - selfStartedAt} мс` +
          `${error ? `, ошибка ${error}` : ''}`
      );
      return json(
        { status, expected: chunks * size, bytes, parts, error, elapsedMs: Date.now() - selfStartedAt },
        200,
        allowOrigin
      );
    }

    const key = (env.DEEPSEEK_API_KEY || '').trim();
    if (!key) {
      return json({ error: 'На воркере не задан DEEPSEEK_API_KEY (wrangler secret put DEEPSEEK_API_KEY)' }, 500, allowOrigin);
    }
    // Клиент ходит в /api/*, а у DeepSeek маршруты без префикса:
    // /models, /user/balance, /chat/completions (см. шапку файла).
    // Без срезания /api клеился бы несуществующий https://api.deepseek.com/api/models → 404.
    const upstreamPath = path.slice('/api'.length) || '/';
    // `raw=1` — диагностика: отдать поток DeepSeek клиенту без обёртки
    // (без пингов), чтобы отличить проблему обёртки от проблемы канала.
    // Сам параметр в DeepSeek не уходит.
    const passthroughQuery = new URLSearchParams(url.search);
    const rawStream = passthroughQuery.get('raw') === '1';
    passthroughQuery.delete('raw');
    const query = passthroughQuery.toString();
    const target = `${DEEPSEEK_BASE}${upstreamPath}${query ? `?${query}` : ''}`;
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
    if (isStream && body && !rawStream) {
      body = proxyStream(body, { startedAt });
    }

    return new Response(body, { status: upstream.status, headers: resHeaders });
  }
};

