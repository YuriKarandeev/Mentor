import {
  chatOnce,
  chatStream,
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
import type { AppSettings, Plan, Profile, Topic } from '../db/db';
import type { ApiMessage, Usage } from './types';

export function connFrom(settings: AppSettings): Connection {
  return { baseUrl: settings.proxyUrl, token: settings.appToken };
}

/** DeepSeek: thinking + reasoning_effort (low | high | max). */
function thinkingBlock(settings: AppSettings): Record<string, unknown> {
  return { thinking: { type: 'enabled' }, reasoning_effort: settings.effort };
}

/** Серверные веб-инструменты подключаем только если включены в настройках. */
function mergeTools(settings: AppSettings, extra: unknown[]): unknown[] {
  const tools = [...extra];
  if (settings.webSearch) tools.push(...WEB_TOOLS);
  return tools;
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

  const res = await chatOnce(connFrom(opts.settings), body, opts.signal);
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
}

export async function streamTurn(opts: StreamTurnOptions): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: opts.settings.model,
    messages: opts.messages,
    ...thinkingBlock(opts.settings),
    max_tokens: 8192
  };
  const tools = mergeTools(opts.settings, opts.tools ?? []);
  if (tools.length > 0) body.tools = tools;
  return chatStream(connFrom(opts.settings), body, opts.handlers ?? {}, opts.signal);
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
  const res = await chatOnce(connFrom(settings), body, signal);
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
  const res = await chatOnce(connFrom(settings), body, signal);
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
