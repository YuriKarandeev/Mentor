/**
 * Понятные человеку объяснения сбоев стрима.
 *
 * Модуль без зависимостей (импортов нет вообще): логику проверяет отдельный
 * тест `scripts/test-stream.mjs` без браузера, сети и Dexie.
 */

/** Модель не прислала ни байта за отведённое время. */
export class FirstByteTimeoutError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`Модель не начала отвечать за ${seconds} с`);
    this.name = 'FirstByteTimeoutError';
    this.seconds = seconds;
  }
}

/** Ошибку прислал DeepSeek внутри SSE-потока (например, прокси закрыл лимит). */
export class RemoteStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteStreamError';
  }
}

/** Поток закончился раньше времени: маркер `[DONE]` так и не пришёл. */
export class StreamInterruptedError extends Error {
  constructor(message = 'Ответ оборвался, не дойдя до конца') {
    super(message);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * Соединение открыто, но новых данных нет дольше отведённого времени.
 * У прокси простой закрывают пинги, у прямого DeepSeek их нет — сторож
 * обрывает молчащий поток, чтобы не ждать таймаута браузера.
 */
export class StreamStallError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`Соединение молчит дольше ${seconds} с`);
    this.name = 'StreamStallError';
    this.seconds = seconds;
  }
}

export type StreamFailure =
  | 'abort'
  | 'first-byte-timeout'
  | 'stall'
  | 'remote'
  | 'interrupted'
  | 'network'
  | 'http'
  | 'other';

/** Тексты сетевых сбоев браузеров: Safari/iOS, Chrome, WebKit. */
const NETWORK_PATTERNS: RegExp[] = [
  /load failed/i,
  /failed to fetch/i,
  /network connection was lost/i,
  /internet connection appears to be offline/i,
  /network ?error/i,
  /network request failed/i,
  /connection (?:reset|closed|aborted|lost)/i,
  /err_(?:connection|network|internet)/i,
  /terminated/i
];

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (error === undefined || error === null) return '';
  return String(error);
}

/** HTTP-статус из ApiError (0 — если ответа не было вовсе). */
function httpStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status > 0) return status;
  }
  return 0;
}

function httpDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return '';
}

export function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError';
}

/**
 * Категория сбоя. Ошибки распознаём и по классу, и по `name`: объект может
 * прийти из другого JS-контекста, где `instanceof` не работает.
 */
export function classifyStreamFailure(error: unknown): StreamFailure {
  const name = errorName(error);
  if (error instanceof FirstByteTimeoutError || name === 'FirstByteTimeoutError') return 'first-byte-timeout';
  if (error instanceof StreamStallError || name === 'StreamStallError') return 'stall';
  if (error instanceof RemoteStreamError || name === 'RemoteStreamError') return 'remote';
  if (error instanceof StreamInterruptedError || name === 'StreamInterruptedError') return 'interrupted';
  if (isAbortError(error)) return 'abort';
  if (httpStatus(error) > 0) return 'http';
  const message = errorMessage(error);
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(message))) return 'network';
  return 'other';
}

export interface DescribeOptions {
  /** `connect` — ответа ещё не было; `stream` — поток уже шёл. */
  stage?: 'connect' | 'stream';
  /** Дополнительный контекст, который добавляется к тексту (например, «черновик сохранён»). */
  suffix?: string;
}

/** Готовый текст для интерфейса: без англоязычных «TypeError: Load failed». */
export function describeStreamError(error: unknown, options: DescribeOptions = {}): string {
  const stage = options.stage ?? 'stream';
  const message = errorMessage(error);
  let text: string;

  switch (classifyStreamFailure(error)) {
    case 'abort':
      text = 'Запрос отменён.';
      break;
    case 'first-byte-timeout':
      text = `${message}. Модель не успела начать ответ — уменьшите глубину размышлений или повторите запрос.`;
      break;
    case 'stall':
      text = `${message}. Ответ мог не дойти из-за сети — повторите запрос или уменьшите глубину размышлений.`;
      break;
    case 'remote':
      text = `DeepSeek вернул ошибку: ${message}`;
      break;
    case 'interrupted':
      text = `${message}. Уже полученный текст можно сохранить и продолжить позже.`;
      break;
    case 'http': {
      const status = httpStatus(error);
      const detail = (httpDetail(error) || message).slice(0, 240);
      text = `Сервер ответил HTTP ${status}: ${detail}`;
      break;
    }
    case 'network':
      text =
        stage === 'connect'
          ? 'Не удалось соединиться с DeepSeek: проверьте сеть и подключение в «Настройках» (ключ или адрес прокси).'
          : 'Соединение оборвалось до конца ответа (Safari пишет «Load failed»). Проверьте сеть и повторите запрос.';
      break;
    default:
      text = message || 'Неизвестная ошибка запроса.';
      break;
  }

  const suffix = options.suffix?.trim();
  return suffix ? `${text} ${suffix}` : text;
}
