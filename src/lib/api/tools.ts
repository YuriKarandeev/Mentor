import { z } from 'zod';

/** Схема аргументов инструмента save_plan (валидируем ответ модели через zod). */
export const planArgsSchema = z.object({
  title: z.string().min(2).max(120),
  summary: z.string().max(1200).optional(),
  modules: z
    .array(
      z.object({
        title: z.string().min(2).max(160),
        goal: z.string().max(800).optional(),
        items: z
          .array(
            z.object({
              title: z.string().min(2).max(240),
              kind: z.enum(['theory', 'practice', 'check']),
              estMin: z.number().int().min(5).max(480).optional()
            })
          )
          .min(1)
          .max(12)
      })
    )
    .min(1)
    .max(10)
});

export type PlanArgs = z.infer<typeof planArgsSchema>;

/** JSON-схема инструмента для DeepSeek (OpenAI-совместимый function calling). */
export const SAVE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'save_plan',
    description:
      'Сохранить итоговый структурированный план обучения по теме. Вызывай только когда собрал достаточно вводных (цель, уровень, время) и готов предложить конкретный план.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'modules'],
      properties: {
        title: { type: 'string', description: 'Короткое название плана (до 120 символов)' },
        summary: { type: 'string', description: 'Что даст план: 1–3 предложения' },
        modules: {
          type: 'array',
          description: '3–6 модулей от простого к сложному',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'items'],
            properties: {
              title: { type: 'string', description: 'Название модуля' },
              goal: { type: 'string', description: 'Результат модуля' },
              items: {
                type: 'array',
                minItems: 1,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'kind'],
                  properties: {
                    title: { type: 'string', description: 'Конкретный шаг: что прочитать/сделать' },
                    kind: { type: 'string', enum: ['theory', 'practice', 'check'] },
                    estMin: {
                      type: 'integer',
                      minimum: 5,
                      maximum: 480,
                      description: 'Оценка времени в минутах'
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

/** Разбор строки аргументов от модели в валидный PlanArgs. */
export function parsePlanArgs(raw: string): { ok: true; value: PlanArgs } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Аргументы не являются валидным JSON' };
  }
  const parsed = planArgsSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

/** Серверные инструменты DeepSeek (объявляются в tools без type: function). */
export const WEB_TOOLS = [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }] as const;

/** Профиль памяти, который модель возвращает инструментом update_profile. */
export const profilePatchSchema = z.object({
  name: z.string().max(60).optional(),
  occupation: z.string().max(120).optional(),
  level: z.enum(['новичок', 'средний', 'продвинутый']).optional(),
  goals: z.array(z.string().max(200)).max(10).optional(),
  interests: z.array(z.string().max(80)).max(20).optional(),
  preferredStyle: z.string().max(300).optional()
});

export const UPDATE_PROFILE_TOOL = {
  type: 'function',
  function: {
    name: 'update_profile',
    description:
      'Обновить долгосрочную память о пользователе (цели, интересы, стиль объяснений). Вызывай, когда узнал устойчивую информацию, которая пригодится в будущих сессиях.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        occupation: { type: 'string' },
        level: { type: 'string', enum: ['новичок', 'средний', 'продвинутый'] },
        goals: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        interests: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        preferredStyle: { type: 'string' }
      }
    }
  }
} as const;
