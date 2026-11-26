import type { Citation } from '../db/db';
import type { Annotation, BalanceResponse, ChatResponse, ToolCall, Usage } from './types';
import { FirstByteTimeoutError, RemoteStreamError } from './stream-error';

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(status ? `HTTP ${status}: ${detail.slice(0, 240)}` : detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Ответ API отклонён как некорректный запрос (400). Такой запрос можно
 * безопасно повторить в упрощённом виде: ошибка приходит до первого байта ответа.
 */
export function isBadRequest(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

export interface Connection {
  baseUrl: string;
  token: string;
}

function endpoint(conn: Connection, path: string): string {
  const base = conn.baseUrl.trim().replace(/\/+$/, '');
  if (!base) {
    throw new ApiError(0, 'Не задан адрес прокси. Откройте «Настройки» и укажите URL воркера.');
  }
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function authHeaders(conn: Connection): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const token = conn.token.trim();
  if (token) h['x-app-token'] = token;
  return h;
}

async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  throw new ApiError(res.status, text || res.statusText);
}

export function extractCitations(annotations: Annotation[] | undefined): Citation[] {
  if (!Array.isArray(annotations)) return [];
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const a of annotations) {
    if (!a || typeof a !== 'object') continue;
    const url = (a.url_citation?.url ?? (a.url as string | undefined) ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: a.url_citation?.title ?? (a.title as string | undefined),
      site: a.url_citation?.site
    });
  }
  return out;
}

export async function listModels(conn: Connection, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(endpoint(conn, '/api/models'), { headers: authHeaders(conn), signal });
  await ensureOk(res);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
}

export async function getBalance(conn: Connection, signal?: AbortSignal): Promise<BalanceResponse> {
  const res = await fetch(endpoint(conn, '/api/user/balance'), { headers: authHeaders(conn), signal });
  await ensureOk(res);
  return (await res.json()) as BalanceResponse;
}

interface RawChatMessage {
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  annotations?: Annotation[];
}

interface RawCompletion {
  choices?: Array<{ message?: RawChatMessage }>;
  usage?: Usage;
}

export async function chatOnce(
  conn: Connection,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ChatResponse> {
  const res = await fetch(endpoint(conn, '/api/chat/completions'), {
    method: 'POST',
    headers: authHeaders(conn),
    body: JSON.stringify({ ...body, stream: false }),
    signal
  });
  await ensureOk(res);
  const json = (await res.json()) as RawCompletion;
  const message = json.choices?.[0]?.message ?? {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    annotations: Array.isArray(message.annotations) ? message.annotations : [],
    usage: json.usage
  };
}

export interface StreamHandlers {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolEvent?: (event: unknown) => void;
  onCitations?: (citations: Citation[]) => void;
  onUsage?: (usage: Usage) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  citations: Citation[];
  usage?: Usage;
  /** Заполняется, если запрос удался только в упрощённом виде (после HTTP 400). */
  fallback?: string;
  /** `true` — поток закрылся без маркера `[DONE]`: текст мог обрезаться. */
  interrupted?: boolean;
}

interface RawStreamChoice {
  delta?: { content?: string | null; reasoning_content?: string; annotations?: Annotation[] };
  message?: { annotations?: Annotation[] };
  server_tool_event?: unknown;
}

interface RawStream {
  choices?: RawStreamChoice[];
  usage?: Usage;
  /** Ошибка, которую прислал прокси/DeepSeek прямо в потоке. */
  error?: unknown;
}

/** Сколько ждём первый байт (включая heartbeat-пинги прокси), прежде чем сообщить о таймауте. */
const FIRST_BYTE_TIMEOUT_MS = 90_000;

function describeRemoteError(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  try {
    const text = JSON.stringify(error);
    if (typeof text === 'string' && text && text !== '{}') return text;
  } catch {
    /* циклические ссылки — вернём общий текст */
  }
  return 'ошибка без описания';
}

export interface StreamOptions {
  /** Переопределение ожидания первого байта (нужно тестам и «быстрым» сценариям). */
  firstByteTimeoutMs?: number;
}

/**
 * Стриминговый запрос к /chat/completions через прокси.
 * Устойчив к незнакомым событиям: разбираем только те поля, которые знаем.
 */
export async function chatStream(
  conn: Connection,
  body: Record<string, unknown>,
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
  options: StreamOptions = {}
): Promise<StreamResult> {
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;

  // Свой контроллер нужен, чтобы оборвать запрос по нашему таймауту
  // и при этом пробросить отмену из интерфейса («Стоп»).
  const controller = new AbortController();
  let firstByteTimedOut = false;
  const timeoutId = setTimeout(() => {
    firstByteTimedOut = true;
    controller.abort();
  }, firstByteTimeoutMs);
  const onOuterAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort);
  }
  const cleanup = (): void => {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onOuterAbort);
  };
  const timeoutError = (): FirstByteTimeoutError =>
    new FirstByteTimeoutError(Math.round(firstByteTimeoutMs / 1000));

  let res: Response;
  try {
    res = await fetch(endpoint(conn, '/api/chat/completions'), {
      method: 'POST',
      headers: { ...authHeaders(conn), accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal
    });
  } catch (e) {
    cleanup();
    if (firstByteTimedOut) throw timeoutError();
    throw e;
  }

  try {
    await ensureOk(res);
  } catch (e) {
    cleanup();
    throw e;
  }

  let content = '';
  let reasoning = '';
  let citations: Citation[] = [];
  let usage: Usage | undefined;

  const reader = res.body?.getReader();
  if (!reader) {
    cleanup();
    const text = await res.text();
    handlers.onDelta?.(text);
    return { content: text, reasoning, citations, usage };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handlePayload = (payload: string): void => {
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    let json: RawStream;
    try {
      json = JSON.parse(payload) as RawStream;
    } catch {
      return; // частичный/неизвестный кадр — игнорируем
    }
    if (json.error !== undefined && json.error !== null) {
      throw new RemoteStreamError(describeRemoteError(json.error));
    }
    if (json.usage) {
      usage = json.usage;
      handlers.onUsage?.(json.usage);
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      handlers.onReasoning?.(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      handlers.onDelta?.(delta.content);
    }
    const anns = delta.annotations ?? choice.message?.annotations;
    if (Array.isArray(anns) && anns.length > 0) {
      citations = extractCitations(anns);
      handlers.onCitations?.(citations);
    }
    if (choice.server_tool_event) {
      handlers.onToolEvent?.(choice.server_tool_event);
    }
  };

  const drainLines = (flush = false): void => {
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) handlePayload(payload);
      }
      if (finished) return;
      nl = buffer.indexOf('\n');
    }
    if (flush) {
      const line = buffer.trim();
      buffer = '';
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) handlePayload(payload);
      }
    }
  };

  let firstByteSeen = false;
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteSeen) {
        firstByteSeen = true;
        clearTimeout(timeoutId);
      }
      buffer += decoder.decode(value, { stream: true });
      drainLines();
    }
    if (!finished) drainLines(true);
  } catch (e) {
    if (firstByteTimedOut) throw timeoutError();
    throw e;
  } finally {
    cleanup();
    try {
      await reader.cancel();
    } catch {
      /* поток уже закрыт */
    }
  }

  // Без маркера [DONE] поток мог закрыться из-за обрыва: отдаём частичный текст и флаг.
  return { content, reasoning, citations, usage, interrupted: !finished };
}

