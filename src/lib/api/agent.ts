import {
  ApiError,
  chatOnce,
  chatStream,
  isBadRequest,
  type Connection,
  type StreamHandlers,
  type StreamResult
} from './deepseek';
import { BOOK_SYSTEM, SUMMARY_SYSTEM, mentorSystem, plannerSystem } from './prompts';
import {
  SAVE_PLAN_TOOL,
  UPDATE_PROFILE_TOOL,
  WEB_TOOLS,
  parsePlanArgs,
  profilePatchSchema,
  type PlanArgs
} from './tools';
import type { AppSettings, Effort, Plan, Profile, Topic } from '../db/db';
import type { ApiMessage, Usage } from './types';
import { requestVariants, type RequestBody } from './request-variants';

export function connFrom(settings: AppSettings): Connection {
  return { baseUrl: settings.proxyUrl, token: settings.appToken };
}

/** DeepSeek: thinking + reasoning_effort (low | high | max). */
function thinkingBlock(settings: AppSettings, effort: Effort = settings.effort): Record<string, unknown> {
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

/**
 * Серверные веб-инструменты DeepSeek (`deepseek_web_search`, `deepseek_read_url`)
 * по документации рассчитаны на `deepseek-flash`. Для других моделей их не отправляем,
 * иначе запрос может быть отклонён с HTTP 400.
 */
const WEB_TOOL_MODELS = new Set(['deepseek-flash']);

export function webToolsSupported(model: string): boolean {
  return WEB_TOOL_MODELS.has(model.trim());
}

/** Серверные веб-инструменты подключаем, только если включены и модель их поддерживает. */
function mergeTools(settings: AppSettings, extra: unknown[]): unknown[] {
  const tools = [...extra];
  if (settings.webSearch && webToolsSupported(settings.model)) tools.push(...WEB_TOOLS);
  return tools;
}

/**
 * Выполняет запрос и при HTTP 400 повторяет его в упрощённом виде.
 * Ретрай безопасен и для стрима: 400 приходит до первого байта ответа,
 * поэтому обработчики не получают дублей.
 */
async function withFallback<T extends { fallback?: string }>(
  body: RequestBody,
  run: (body: RequestBody) => Promise<T>
): Promise<T> {
  const variants = requestVariants(body);
  const errors: string[] = [];

  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    try {
      const result = await run(variant.body);
      if (i > 0) {
        console.warn(`[agent] ответ получен в упрощённом режиме (${variant.label}); 400 на: ${errors.join(' → ')}`);
        result.fallback = variant.label;
      }
      return result;
    } catch (e) {
      if (!isBadRequest(e) || i === variants.length - 1) {
        if (errors.length === 0) throw e;
        const last = e instanceof ApiError ? e.detail : String(e);
        throw new ApiError(400, `${errors.join(' → ')} → ${variant.label}: ${last.slice(0, 160)}`);
      }
      const detail = e instanceof ApiError ? e.detail : String(e);
      errors.push(`${variant.label}: ${detail.slice(0, 160)}`);
    }
  }

  throw new ApiError(400, errors.join(' → '));
}

export interface PlanStepResult {
  content: string;
  plan?: PlanArgs;
  error?: string;
  usage?: Usage;
}

/** Один шаг онбординга: либо уточняющий вопрос, либо вызов save_plan. */
export async function planStep(opts: {
  settings: AppSettings;
  topic: Topic;
  profile: Profile;
  history: ApiMessage[];
  signal?: AbortSignal;
}): Promise<PlanStepResult> {
  const body: Record<string, unknown> = {
    model: opts.settings.model,
    messages: [
      { role: 'system', content: plannerSystem(opts.topic, opts.profile) },
      ...opts.history
    ],
    ...thinkingBlock(opts.settings),
    tools: mergeTools(opts.settings, [SAVE_PLAN_TOOL]),
    max_tokens: 4096
  };

  const res = await withFallback(body, (variant) => chatOnce(connFrom(opts.settings), variant, opts.signal));
  const call = res.toolCalls.find((t) => t.function?.name === 'save_plan');
  if (!call) return { content: res.content, usage: res.usage };

  const parsed = parsePlanArgs(call.function.arguments);
  if (!parsed.ok) {
    return { content: res.content, error: parsed.error, usage: res.usage };
  }
  return { content: res.content, plan: parsed.value, usage: res.usage };
}

export interface StreamTurnOptions {
  settings: AppSettings;
  messages: ApiMessage[];
  tools?: unknown[];
  signal?: AbortSignal;
  handlers?: StreamHandlers;
  /** Переопределение глубины размышлений (для книг — `low`: первый байт приходит раньше). */
  effort?: Effort;
  /** Переопределение ожидания первого байта. */
  firstByteTimeoutMs?: number;
}

export async function streamTurn(opts: StreamTurnOptions): Promise<StreamResult> {
  const tools = mergeTools(opts.settings, opts.tools ?? []);
  const body: Record<string, unknown> = {
    model: opts.settings.model,
    messages: opts.messages,
    ...thinkingBlock(opts.settings, opts.effort),
    max_tokens: 8192
  };
  if (tools.length > 0) body.tools = tools;
  return withFallback(body, (variant) =>
    chatStream(connFrom(opts.settings), variant, opts.handlers ?? {}, opts.signal, {
      firstByteTimeoutMs: opts.firstByteTimeoutMs
    })
  );
}

export function toApiMessages(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  limit = 24
): ApiMessage[] {
  return history.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}

export function mentorMessages(
  topic: Topic,
  plan: Plan | undefined,
  profile: Profile,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  memory?: string
): ApiMessage[] {
  const system =
    mentorSystem(topic, plan, profile) + (memory ? `\n\nПамять о прошлых занятиях:\n${memory}` : '');
  return [{ role: 'system', content: system }, ...toApiMessages(history)];
}

/** Сжатие переписки в память (для длинных диалогов). */
export async function summarizeConversation(
  settings: AppSettings,
  topic: Topic,
  transcript: string,
  signal?: AbortSignal
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `Тема: «${topic.title}». Переписка:\n\n${transcript}` }
    ],
    ...thinkingBlock(settings),
    max_tokens: 1024
  };
  const res = await withFallback(body, (variant) => chatOnce(connFrom(settings), variant, signal));
  return res.content.trim();
}

export type ProfilePatch = Partial<Omit<Profile, 'updatedAt'>>;

/** Извлечение устойчивых фактов о пользователе в долгосрочную память. */
export async function extractProfilePatch(
  settings: AppSettings,
  transcript: string,
  signal?: AbortSignal
): Promise<ProfilePatch | undefined> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [
      {
        role: 'system',
        content:
          'Извлеки из переписки устойчивые факты о пользователе (профессия, уровень, цели, интересы, предпочтения). ' +
          'Не выдумывай. Если новых устойчивых фактов нет — не вызывай инструмент и ответь пустой строкой.'
      },
      { role: 'user', content: transcript }
    ],
    ...thinkingBlock(settings),
    tools: [UPDATE_PROFILE_TOOL]
  };
  const res = await withFallback(body, (variant) => chatOnce(connFrom(settings), variant, signal));
  const call = res.toolCalls.find((t) => t.function?.name === 'update_profile');
  if (!call) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(call.function.arguments);
  } catch {
    return undefined;
  }
  const parsed = profilePatchSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export function bookMessages(query: string): ApiMessage[] {
  return [
    { role: 'system', content: BOOK_SYSTEM },
    { role: 'user', content: `Книга: ${query}` }
  ];
}
