/**
 * Проверки объяснений сбоев стрима (src/lib/api/stream-error.ts):
 * без браузера, сети, Dexie и Svelte.
 * Запуск: npm run test:stream
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let total = 0;
const failures = [];
const check = (ok, message) => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

const {
  FirstByteTimeoutError,
  RemoteStreamError,
  StreamInterruptedError,
  StreamStallError,
  classifyStreamFailure,
  describeStreamError,
  isAbortError
} = await import(pathToFileURL(path.resolve('src/lib/api/stream-error.ts')).href);

// --- отмена пользователем ---
const abort = new Error('The user aborted a request.');
abort.name = 'AbortError';
check(isAbortError(abort), 'AbortError распознаётся');
check(classifyStreamFailure(abort) === 'abort', 'отмена классифицируется как abort');
check(describeStreamError(abort) === 'Запрос отменён.', 'текст отмены без технических деталей');

// --- сетевые сбои браузеров ---
for (const text of [
  'Load failed',
  'Failed to fetch',
  'The network connection was lost',
  'network error',
  'TypeError: terminated'
]) {
  check(classifyStreamFailure(new TypeError(text)) === 'network', `«${text}» → network`);
}
const safari = new TypeError('Load failed');
check(
  /Настройк|прокси/i.test(describeStreamError(safari, { stage: 'connect' })),
  'до соединения советуем проверить подключение в настройках'
);
check(/Load failed/.test(describeStreamError(safari)), 'во время стрима упоминаем «Load failed» для Safari');

// --- таймаут первого байта ---
const timeout = new FirstByteTimeoutError(90);
check(classifyStreamFailure(timeout) === 'first-byte-timeout', 'таймаут первого байта классифицируется');
check(/90/.test(describeStreamError(timeout)), 'в тексте таймаута есть число секунд');

// --- молчание посреди потока (у прямого DeepSeek нет пингов) ---
const stall = new StreamStallError(180);
check(classifyStreamFailure(stall) === 'stall', 'молчание посреди потока → stall');
check(/180/.test(describeStreamError(stall)), 'в тексте stall есть число секунд');
check(
  /повторите запрос/i.test(describeStreamError(stall)),
  'совет для stall — повторить запрос'
);
check(classifyStreamFailure({ name: 'StreamStallError' }) === 'stall', 'StreamStallError распознаётся по name');

// --- ошибка из SSE ---
check(
  classifyStreamFailure(new RemoteStreamError('Ответ идёт дольше 240 с')) === 'remote',
  'ошибка из потока → remote'
);
check(
  /DeepSeek вернул ошибку/.test(describeStreamError(new RemoteStreamError('нет баланса'))),
  'текст ошибки из потока'
);

// --- обрыв потока ---
check(classifyStreamFailure(new StreamInterruptedError()) === 'interrupted', 'обрыв без [DONE] → interrupted');

// --- HTTP-ошибка (ApiError по форме) ---
const apiError = Object.assign(new Error('HTTP 401: nope'), { name: 'ApiError', status: 401, detail: 'nope' });
check(classifyStreamFailure(apiError) === 'http', 'ApiError классифицируется как http');
check(/HTTP 401/.test(describeStreamError(apiError)), 'в тексте виден HTTP-статус');

// --- неизвестная ошибка ---
check(classifyStreamFailure(new Error('что-то пошло не так')) === 'other', 'неизвестная ошибка → other');
check(
  /что-то пошло не так/.test(describeStreamError(new Error('что-то пошло не так'))),
  'текст неизвестной ошибки сохраняется'
);

// --- пустые значения и объекты из другого контекста ---
check(classifyStreamFailure(undefined) === 'other', 'undefined не ломает классификацию');
check(describeStreamError(undefined).length > 0, 'для undefined есть текст по умолчанию');
check(classifyStreamFailure({ name: 'FirstByteTimeoutError' }) === 'first-byte-timeout', 'класс распознаётся по name');
check(describeStreamError('просто строка') === 'просто строка', 'строка выводится как есть');

// --- суффикс ---
check(
  describeStreamError(abort, { suffix: 'Черновик сохранён.' }) === 'Запрос отменён. Черновик сохранён.',
  'суффикс добавляется через пробел'
);

if (failures.length > 0) {
  console.error(`\nПровалено ${failures.length} из ${total}:`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}
console.log(`\nВсе проверки пройдены: ${total}`);
