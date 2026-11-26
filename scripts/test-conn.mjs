/**
 * Проверки выбора соединения с DeepSeek (src/lib/api/conn.ts + deepseek.ts):
 * прямой режим против прокси-воркера.
 *
 * Поднимает локальный HTTP-сервер вместо api.deepseek.com и смотрит, какие
 * пути и заголовки реально уходят в сеть. Без браузера, Dexie и сети наружу.
 * Запуск: npm run test:conn
 */
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Node исполняет .ts напрямую (type stripping), но требует расширение в
 * относительных импортах, а в проекте их пишут без него (как принято в Vite).
 * Добавляем `.ts`, если обычное разрешение не удалось.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
});

let total = 0;
const failures = [];
const check = (ok, message) => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

const { connectionOf, normalizeMode, isConfigured, DEEPSEEK_BASE_URL } = await import(
  pathToFileURL(path.resolve('src/lib/api/conn.ts')).href
);
const { ApiError, chatOnce, chatStream, getBalance, listModels } = await import(
  pathToFileURL(path.resolve('src/lib/api/deepseek.ts')).href
);
const { StreamStallError } = await import(
  pathToFileURL(path.resolve('src/lib/api/stream-error.ts')).href
);

const seen = [];
const hanging = new Set();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });

    // «Молчащий» DeepSeek: один кадр и тишина — проверяет сторож стрима.
    if (req.url.startsWith('/stall/')) {
      hanging.add(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"нач"}}]}\n\n');
      res.on('close', () => hanging.delete(res));
      return;
    }

    if (req.headers.authorization === 'Bearer bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Authentication Fails"}}');
      return;
    }

    const sse = String(req.headers.accept ?? '').includes('text/event-stream');
    if (req.url.endsWith('/chat/completions') && sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"при"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"вет"}}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }));
      return;
    }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
      return;
    }
    if (req.url.endsWith('/user/balance')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.00' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"unknown path"}');
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

const proxy = { baseUrl: origin, token: 'proxy-token', mode: 'proxy' };
const direct = { baseUrl: origin, token: 'sk-test-123', mode: 'direct' };
const last = () => seen[seen.length - 1];

async function expectThrow(run) {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}


// --- выбор режима из настроек ---
check(normalizeMode(undefined) === 'direct', 'без сохранённого режима выбран прямой доступ');
check(normalizeMode('proxy') === 'proxy', 'режим proxy читается из настроек');

const fromDirect = connectionOf({ mode: 'direct', proxyUrl: '', appToken: '', deepseekKey: ' sk-abc ' });
check(fromDirect.baseUrl === DEEPSEEK_BASE_URL, 'прямой режим идёт в api.deepseek.com');
check(fromDirect.token === ' sk-abc ' && fromDirect.mode === 'direct', 'прямой режим берёт ключ DeepSeek');

const fromProxy = connectionOf({ mode: 'proxy', proxyUrl: origin, appToken: 'tok', deepseekKey: 'sk-abc' });
check(fromProxy.baseUrl === origin && fromProxy.token === 'tok', 'режим proxy берёт адрес воркера и APP_TOKEN');

check(
  isConfigured({ mode: 'direct', proxyUrl: '', appToken: '', deepseekKey: 'sk-1' }),
  'direct настроен при наличии ключа'
);
check(
  !isConfigured({ mode: 'direct', proxyUrl: origin, appToken: 'tok', deepseekKey: '  ' }),
  'direct без ключа не настроен'
);
check(isConfigured({ mode: 'proxy', proxyUrl: origin, appToken: '', deepseekKey: '' }), 'proxy настроен по адресу');
check(
  !isConfigured({ mode: 'proxy', proxyUrl: ' ', appToken: 'tok', deepseekKey: 'sk-1' }),
  'proxy без адреса не настроен'
);

// --- chatOnce: путь и заголовки ---
const onceDirect = await chatOnce(direct, { model: 'deepseek-flash' });
check(onceDirect.content === 'ok', 'прямой режим получает ответ модели');
check(last().url === '/chat/completions', `прямой режим: путь без /api (${last().url})`);
check(last().headers.authorization === 'Bearer sk-test-123', 'прямой режим: Authorization: Bearer <ключ>');
check(!('x-app-token' in last().headers), 'прямой режим: x-app-token не отправляется');
check(JSON.parse(last().body).stream === false, 'chatOnce просит нестримовый ответ');

await chatOnce(proxy, { model: 'deepseek-flash' });
check(last().url === '/api/chat/completions', `прокси: путь с /api (${last().url})`);
check(last().headers['x-app-token'] === 'proxy-token', 'прокси: токен в x-app-token');
check(!('authorization' in last().headers), 'прокси: заголовок Authorization не уходит');

await chatOnce({ baseUrl: origin, token: 'proxy-token' }, { model: 'deepseek-flash' });
check(last().url === '/api/chat/completions', 'соединение без режима работает как прокси (совместимость)');

// --- список моделей и баланс идут по своим путям ---
const directModels = await listModels(direct);
check(last().url === '/models', `прямой режим: список моделей из /models (${last().url})`);
check(directModels.join(',') === 'deepseek-flash,deepseek-v4-pro', 'список моделей разобран');

await listModels(proxy);
check(last().url === '/api/models', `прокси: список моделей из /api/models (${last().url})`);

const balance = await getBalance(direct);
check(last().url === '/user/balance', `прямой режим: баланс из /user/balance (${last().url})`);
check(balance.balance_infos?.[0]?.total_balance === '42.00', 'баланс разобран');

// --- стрим напрямую ---
const streamed = await chatStream(direct, { model: 'deepseek-flash' }, {}, undefined, { firstByteTimeoutMs: 5000 });
check(streamed.content === 'привет', 'прямой стрим собирает текст из кадров');
check(streamed.interrupted === false, 'прямой стрим дождался [DONE]');
check(last().headers.accept === 'text/event-stream', 'прямой стрим просит SSE');
check(last().headers.authorization === 'Bearer sk-test-123', 'прямой стрим отправляет ключ');

// --- понятные ошибки вместо «HTTP 0» ---
const noKey = await expectThrow(() => chatOnce({ baseUrl: origin, token: '', mode: 'direct' }, { model: 'm' }));
check(noKey instanceof ApiError && /ключ DeepSeek/i.test(noKey.message), 'без ключа DeepSeek — понятная ошибка');
check(noKey instanceof ApiError && !/sk-|Bearer/.test(noKey.message), 'в ошибке нет самого ключа и заголовка');

const noProxy = await expectThrow(() => chatOnce({ baseUrl: '  ', token: 't', mode: 'proxy' }, { model: 'm' }));
check(noProxy instanceof ApiError && /прокси/i.test(noProxy.message), 'без адреса прокси — прежний текст');

const unauthorized = await expectThrow(() =>
  chatOnce({ baseUrl: origin, token: 'bad-key', mode: 'direct' }, { model: 'm' })
);
check(unauthorized instanceof ApiError && unauthorized.status === 401, 'неверный ключ → ApiError 401');

// --- сторож молчания посреди потока ---
const stallStart = Date.now();
const stall = await expectThrow(() =>
  chatStream(
    { baseUrl: `${origin}/stall`, token: 'sk-test-123', mode: 'direct' },
    { model: 'm' },
    {},
    undefined,
    { firstByteTimeoutMs: 5000, stallTimeoutMs: 150 }
  )
);
const stallMs = Date.now() - stallStart;
check(stall instanceof StreamStallError, 'молчащий поток обрывается сторожем');
check(stallMs < 3000, `сторож срабатывает быстро (${stallMs} мс)`);

for (const res of hanging) res.destroy();
server.close();

if (failures.length > 0) {
  console.error(`\nПровалено ${failures.length} из ${total}:`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}
console.log(`\nВсе проверки пройдены: ${total}`);

