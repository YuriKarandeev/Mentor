#!/usr/bin/env node
/**
 * Офлайн-тест Cloudflare Worker'а: без сети, без wrangler и без ключей DeepSeek.
 *
 *   npm.cmd run test:worker
 *
 * Что проверяем:
 * - `/health` отдаёт версию деплоя и лимиты стрима;
 * - `/api/*` без `x-app-token` — 401;
 * - `/api/diag/stream` шлёт пинги в awaited-цикле и завершает поток кадром `end` + `[DONE]`;
 * - `proxyStream` отдаёт первый чанк сразу (синхронный `start`), пингует, пока DeepSeek
 *   молчит, и доносит финальный чанк — то, что на проде раньше «замирало»;
 * - обрыв чтения upstream превращается в SSE-кадр `event: error`, а не в сетевую ошибку.
 */
import worker from '../worker/deepseek-proxy.js';

const BASE = 'https://proxy.test';
const TOKEN = 'test-token';
const ENV = { APP_TOKEN: TOKEN, DEEPSEEK_API_KEY: 'sk-test', ALLOWED_ORIGINS: '' };
const encoder = new TextEncoder();

let total = 0;
let failed = 0;

function check(ok, label, details = '') {
  total += 1;
  if (ok) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${label}${details ? ` — ${details}` : ''}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', token = TOKEN, accept = 'application/json', body } = {}) {
  const headers = new Headers();
  if (token) headers.set('x-app-token', token);
  if (accept) headers.set('accept', accept);
  return worker.fetch(new Request(`${BASE}${path}`, { method, headers, body }), ENV);
}

/** Читает тело ответа целиком, запоминая время прихода пингов и первого чанка. */
async function drain(res) {
  const startedAt = Date.now();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const pingAt = [];
  let text = '';
  let firstChunkAt = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (firstChunkAt === null) firstChunkAt = Date.now() - startedAt;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    if (chunk.includes(': ping')) pingAt.push(Date.now() - startedAt);
  }
  text += decoder.decode();
  return { text, pingAt, firstChunkAt, elapsedMs: Date.now() - startedAt };
}

/**
 * Тело ответа upstream по сценарию: чанк → пауза → чанк/ошибка → close.
 *
 * Чтение через `pull`, как у настоящего сетевого тела: `async start` держит
 * поток в состоянии «starting» и не отдаёт данные до своего завершения.
 */
function scenarioBody(steps) {
  const left = [...steps];
  return new ReadableStream({
    async pull(controller) {
      const step = left.shift();
      if (!step) {
        controller.close();
        return;
      }
      if (step.wait) await delay(step.wait);
      if (step.error) {
        controller.error(new Error(step.error));
        return;
      }
      if (step.chunk) controller.enqueue(encoder.encode(step.chunk));
      if (step.close) controller.close();
    }
  });
}

function stubUpstream(body, status = 200) {
  return async () =>
    new Response(body, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

const sseChunk = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

// --- 1. health ---
console.log('\n/health');
{
  const res = await call('/health', { token: null });
  const data = await res.json();
  check(res.status === 200, '200 OK', `status ${res.status}`);
  check(data.ok === true, 'ok: true');
  check('version' in data && 'deployedAt' in data, 'есть version и deployedAt');
  check(data.stream?.idlePingMs === 10000, 'idlePingMs = 10000', JSON.stringify(data.stream));
  check(data.stream?.limitMs === 240000, 'limitMs = 240000', JSON.stringify(data.stream));
}

// --- 2. токен ---
console.log('\nдоступ по x-app-token');
{
  const res = await call('/api/diag/stream?seconds=2&ping=1', { token: null });
  check(res.status === 401, 'без токена — 401', `status ${res.status}`);
  const ok = await call('/api/diag/stream?seconds=2&ping=1');
  check(ok.status === 200, 'с токеном — 200', `status ${ok.status}`);
  await ok.body.cancel();
}

// --- 3. diag/stream ---
console.log('\n/api/diag/stream?seconds=3&ping=1');
{
  const res = await call('/api/diag/stream?seconds=3&ping=1');
  check(res.headers.get('content-type')?.includes('text/event-stream'), 'content-type: text/event-stream');
  const { text, pingAt, elapsedMs } = await drain(res);
  const end = text.match(/data: (\{.*"event":"end".*\})/);
  const parsed = end ? JSON.parse(end[1]) : null;
  check(pingAt.length >= 2, `пинги в awaited-цикле (${pingAt.join(', ')} мс)`);
  check(text.includes('"event":"start"'), 'кадр start');
  check(Boolean(parsed), 'кадр end');
  check(parsed?.pings === pingAt.length, `end.pings = ${pingAt.length}`, String(parsed?.pings));
  check(text.trimEnd().endsWith('data: [DONE]'), 'последний кадр — [DONE]');
  check(elapsedMs >= 2900, `стрим прожил ${elapsedMs} мс`);
}

// --- 4. proxyStream: молчащий upstream ---
console.log('\nproxyStream: DeepSeek молчит 10.5 с, потом финальный чанк');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubUpstream(
    scenarioBody([
      { chunk: sseChunk({ reasoning_content: 'думаю' }) },
      { wait: 10500, chunk: sseChunk({ content: 'ответ' }) },
      { close: true }
    ])
  );
  try {
    const res = await call('/api/chat/completions', {
      method: 'POST',
      accept: 'text/event-stream',
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] })
    });
    check(res.status === 200, '200 OK', `status ${res.status}`);
    const { text, pingAt, firstChunkAt } = await drain(res);
    check(firstChunkAt !== null && firstChunkAt < 1000, `первый чанк сразу (${firstChunkAt} мс)`);
    check(text.includes('думаю') && text.includes('ответ'), 'оба чанка DeepSeek дошли');
    check(pingAt.length >= 1, `пинг во время молчания (${pingAt.join(', ')} мс)`);
    check(pingAt[0] >= 9500 && pingAt[0] <= 12000, 'пинг примерно на 10-й секунде', String(pingAt[0]));
    check(!text.includes('event: error'), 'ошибки в потоке нет');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5. proxyStream: обрыв upstream ---
console.log('\nproxyStream: обрыв чтения upstream («terminated»)');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubUpstream(
    scenarioBody([{ chunk: sseChunk({ reasoning_content: 'думаю' }) }, { wait: 50, error: 'terminated' }])
  );
  try {
    const res = await call('/api/chat/completions', {
      method: 'POST',
      accept: 'text/event-stream',
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] })
    });
    const { text } = await drain(res);
    check(text.includes('event: error'), 'клиент получил кадр event: error');
    check(text.includes('Соединение с DeepSeek прервалось'), 'в кадре русский текст ошибки');
    check(text.includes('terminated'), 'в тексте есть причина обрыва');
    check(text.trimEnd().endsWith('data: [DONE]'), 'поток закрыт кадром [DONE]');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 6. diag/burst: доставка быстрого потока через proxyStream ---
console.log('\n/api/diag/burst?chunks=120&size=160&gap=1');
{
  const res = await call('/api/diag/burst?chunks=120&size=160&gap=1');
  const expected = Number(res.headers.get('x-diag-expected-bytes'));
  const { text, elapsedMs } = await drain(res);
  check(expected === 120 * 160, `в заголовке ожидаемо ${120 * 160} Б`, String(expected));
  check(
    text.length === expected,
    `через proxyStream дошли все ${expected} Б (получено ${text.length})`,
    `получено ${text.length}`
  );
  check(elapsedMs < 15000, `быстрый upstream доставлен за ${elapsedMs} мс`);
}

// --- 7. diag/burst?raw=1: тот же upstream без обёртки ---
console.log('\n/api/diag/burst?chunks=120&size=160&raw=1');
{
  const res = await call('/api/diag/burst?chunks=120&size=160&raw=1');
  const expected = Number(res.headers.get('x-diag-expected-bytes'));
  const { text } = await drain(res);
  check(res.headers.get('x-diag-raw') === '1', 'raw-режим помечен заголовком');
  check(text.length === expected, `raw тоже отдаёт все ${expected} Б`, `получено ${text.length}`);
}

// --- 8. diag/silent: пинги без DeepSeek (пинг штатный — раз в 10 с) ---
console.log('\n/api/diag/silent?seconds=12');
{
  const res = await call('/api/diag/silent?seconds=12');
  const { pingAt, text } = await drain(res);
  check(pingAt.length >= 1, `молчащий upstream держится пингом (${pingAt.join(', ')} мс)`);
  check(text.length > 0, 'данные upstream дошли');
}

// --- 9. diag/gen: объём и не-потоковый ответ ---
console.log('\n/api/diag/gen?chunks=30&size=1000 (whole и поток)');
{
  const wholeRes = await call('/api/diag/gen?chunks=30&size=1000&whole=1');
  const whole = await drain(wholeRes);
  check(
    Number(wholeRes.headers.get('x-diag-expected-bytes')) === 30000,
    'в заголовке ожидаемо 30000 Б',
    String(wholeRes.headers.get('x-diag-expected-bytes'))
  );
  check(whole.text.length === 30000, `whole-ответ целиком (${whole.text.length} Б)`, `${whole.text.length} Б`);

  const streamRes = await call('/api/diag/gen?chunks=30&size=1000');
  const streamed = await drain(streamRes);
  check(streamed.text.length === 30000, `поток целиком (${streamed.text.length} Б)`, `${streamed.text.length} Б`);
}

// --- 10. upstream без тела (не стрим) ---
console.log('\nupstream: обычный JSON-ответ');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await call('/api/models');
    const data = await res.json();
    check(res.status === 200 && Array.isArray(data.data), 'JSON проксируется как есть');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\nПроверок: ${total}, провалов: ${failed}`);
if (failed > 0) {
  console.log('Есть проблемы — см. строки с ✖ выше.');
  process.exit(1);
}
console.log('Worker в порядке: пинги доходят, обрыв upstream превращается в понятную ошибку.');
