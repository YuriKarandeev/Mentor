#!/usr/bin/env node
/**
 * Диагностика стрима «разбор книги» через воркер-прокси.
 *
 * Повторяет запрос приложения (src/lib/api/agent.ts → streamTurn + bookMessages)
 * и печатает тайминги: когда пришли заголовки, когда — первый чанк, сколько
 * байт и символов дошло. По ним видно, кто рвёт соединение: DeepSeek долго
 * молчит, Cloudflare закрывает простой или клиент/сеть.
 *
 * Запуск (PowerShell):
 *   $env:PROXY_URL="https://<worker>.workers.dev"; $env:APP_TOKEN="..."; npm.cmd run probe:book
 *   npm.cmd run probe:book -- --url https://... --token ... --effort low
 *   npm.cmd run probe:book -- --dry-run          # только показать тело запроса
 *
 * Токен не печатается и никуда не сохраняется. Зависимостей нет.
 */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const WEB_TOOLS = [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }];
const { BOOK_SYSTEM } = await import(
  pathToFileURL(path.resolve('src/lib/api/prompts.ts')).href
);

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

function printHelp() {
  console.log(`probe:book — диагностика стрима разбора книги

Обязательно (аргумент или переменная окружения):
  --url <адрес>          адрес воркера, напр. https://name.sub.workers.dev  (PROXY_URL)
  --token <APP_TOKEN>    токен приложения                                    (APP_TOKEN)

Необязательно:
  --query <текст>        что за книга (по умолчанию «Думай медленно… решай быстро, Канеман»)
  --model <id>           модель DeepSeek (по умолчанию deepseek-flash)
  --effort <low|high|max> глубина размышлений (по умолчанию high, как в приложении)
  --max-tokens <n>       лимит ответа (по умолчанию 8192)
  --no-tools             не подключать веб-поиск
  --no-thinking          не включать режим размышлений
  --timeout <сек>        общий лимит запроса (по умолчанию 300)
  --first-byte-timeout <сек>  сколько ждать первый байт (по умолчанию 120)
  --dry-run              показать тело запроса и выйти
  --help                 эта справка

Коды выхода: 0 — стрим дошёл целиком; 2 — ошибка, обрыв или пустой ответ.
`);
}

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.has('help')) {
  printHelp();
  process.exit(0);
}

const url = ((args.values.url || process.env.PROXY_URL || '').trim()).replace(/\/+$/, '');
const token = (args.values.token || process.env.APP_TOKEN || '').trim();
const query = args.values.query || 'Думай медленно… решай быстро, Канеман';
const model = args.values.model || 'deepseek-flash';
const effort = args.values.effort || 'high';
const maxTokens = Number(args.values['max-tokens'] || 8192);
const totalTimeoutSec = Number(args.values.timeout || 300);
const firstByteTimeoutSec = Number(args.values['first-byte-timeout'] || 120);
const useTools = !args.flags.has('no-tools');
const useThinking = !args.flags.has('no-thinking');

const body = {
  model,
  stream: true,
  messages: [
    { role: 'system', content: BOOK_SYSTEM },
    { role: 'user', content: `Книга: ${query}` }
  ],
  max_tokens: maxTokens
};
if (useThinking) {
  body.thinking = { type: 'enabled' };
  body.reasoning_effort = effort;
}
if (useTools) body.tools = WEB_TOOLS;

if (args.flags.has('dry-run')) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

if (!url || !token) {
  fail('нужны адрес воркера и токен: --url и --token (или PROXY_URL и APP_TOKEN). Справка: --help');
}
if (!/^https?:\/\//.test(url)) fail('адрес воркера должен начинаться с http:// или https://');
if (!Number.isFinite(maxTokens) || maxTokens < 1) fail('--max-tokens должен быть положительным числом');

const pretty = (ms) => `${(ms / 1000).toFixed(1)} с`;
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const log = (text) => console.log(`[${pretty(elapsed()).padStart(7)}] ${text}`);

console.log(`Прокси:  ${url}`);
console.log(
  `Модель:  ${model} · effort=${useThinking ? effort : 'выкл'} · веб-поиск=${useTools ? 'да' : 'нет'} · max_tokens=${maxTokens}`
);
console.log(`Запрос:  «${query}»`);
console.log(`Таймауты: первый байт ${firstByteTimeoutSec} с, всего ${totalTimeoutSec} с\n`);

const controller = new AbortController();
let why = '';
const firstTimer = setTimeout(() => {
  why = 'first-byte';
  controller.abort();
}, firstByteTimeoutSec * 1000);
const totalTimer = setTimeout(() => {
  why = 'total';
  controller.abort();
}, totalTimeoutSec * 1000);

let res;
try {
  res = await fetch(`${url}/api/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-app-token': token
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });
} catch (e) {
  clearTimeout(firstTimer);
  clearTimeout(totalTimer);
  const name = e?.name || 'Error';
  const message = e?.message || String(e);
  log(`✖ запрос не выполнен: ${name}: ${message}`);
  if (why === 'first-byte') log(`Причина: не дождались заголовков за ${firstByteTimeoutSec} с (наш таймаут).`);
  if (why === 'total') log(`Причина: превышен общий лимит ${totalTimeoutSec} с (наш таймаут).`);
  console.log('\nВердикт: воркер не ответил даже заголовками — смотрите `wrangler tail` и DNS/адрес прокси.');
  process.exit(2);
}

const headersMs = elapsed();
log(`Заголовки: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);

if (!res.ok) {
  const text = await res.text().catch(() => '');
  clearTimeout(firstTimer);
  clearTimeout(totalTimer);
  log(`Тело ответа: ${text.slice(0, 600) || '(пусто)'}`);
  console.log('\nВердикт: воркер ответил ошибкой — это не обрыв. Проверьте APP_TOKEN, адрес и баланс DeepSeek.');
  process.exit(2);
}

let bytes = 0;
let content = '';
let reasoning = '';
let citations = 0;
let markerDone = false;
let firstChunkMs = null;
let streamError = null;

const handlePayload = (payload) => {
  if (payload === '[DONE]') {
    markerDone = true;
    return;
  }
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return;
  }
  if (json && json.error) {
    const text =
      typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error);
    streamError = new Error(`воркер прислал ошибку: ${text}`);
    return;
  }
  const choice = json?.choices?.[0];
  if (!choice) return;
  const delta = choice.delta ?? {};
  if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
  if (typeof delta.content === 'string') content += delta.content;
  const annotations = delta.annotations ?? choice.message?.annotations;
  if (Array.isArray(annotations) && annotations.length > citations) citations = annotations.length;
};

const progress = setInterval(() => {
  log(`… ждём: ${bytes} Б, контент ${content.length} симв., reasoning ${reasoning.length} симв.`);
}, 5000);

const reader = res.body?.getReader();
const decoder = new TextDecoder();
let buffer = '';

try {
  if (!reader) {
    const text = await res.text();
    content = text;
    bytes = text.length;
  } else {
    while (!markerDone) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunkMs === null) {
        firstChunkMs = elapsed();
        clearTimeout(firstTimer);
        log(`Первый чанк: ${value.byteLength} Б — это и есть время до первого байта`);
      }
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) handlePayload(payload);
        }
        if (markerDone) break;
        nl = buffer.indexOf('\n');
      }
    }
    if (!markerDone && buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload) handlePayload(payload);
    }
  }
} catch (e) {
  streamError = e;
}

clearInterval(progress);
clearTimeout(firstTimer);
clearTimeout(totalTimer);
if (reader) {
  try {
    await reader.cancel();
  } catch {
    /* поток уже закрыт */
  }
}

const totalMs = elapsed();
const dash = (value) => (value === null ? '—' : pretty(value));

console.log('\n=== Итог ===');
console.log(`Заголовки:       ${dash(headersMs)}`);
console.log(`Первый чанк:     ${dash(firstChunkMs)}`);
console.log(`Всего:           ${pretty(totalMs)}`);
console.log(`Байт:            ${bytes}`);
console.log(`Контент:         ${content.length} симв.`);
console.log(`Reasoning:       ${reasoning.length} симв.`);
console.log(`Источники:       ${citations}`);
console.log(`Маркер [DONE]:   ${markerDone ? 'да' : 'нет'}`);

let verdict;
if (streamError) {
  const name = streamError.name || 'Error';
  const message = streamError.message || String(streamError);
  console.log(`Ошибка потока:   ${name}: ${message}`);
  if (why === 'first-byte') {
    verdict = `DeepSeek не прислал ни байта за ${firstByteTimeoutSec} с — запрос слишком долгий для клиента.`;
  } else if (why === 'total') {
    verdict = `Запрос не завершился за ${totalTimeoutSec} с — стрим слишком долгий.`;
  } else if (name === 'TypeError' || /load failed|failed to fetch|network|terminated/i.test(message)) {
    verdict = `Соединение оборвано на ${pretty(totalMs)} — ровно как «Load failed» в приложении.`;
  } else {
    verdict = `Обрыв или ошибка потока: ${message}`;
  }
} else if (!markerDone) {
  verdict = `Поток закрылся без [DONE] на ${pretty(totalMs)} — похоже на обрыв на стороне прокси или сети.`;
} else if (firstChunkMs !== null && firstChunkMs > 30000) {
  verdict = `Стрим дошёл, но первый байт только через ${pretty(firstChunkMs)} — мобильный клиент может не дождаться.`;
} else {
  verdict =
    'Стрим дошёл целиком — DeepSeek и воркер в порядке, причина на стороне клиента (сеть, сон устройства, service worker).';
}
console.log(`\nВердикт: ${verdict}`);

process.exit(markerDone && content.trim().length > 0 ? 0 : 2);
