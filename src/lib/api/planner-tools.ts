import { z } from 'zod';
import { AI_MAX_ACTIONS, AI_MAX_NOTES, AI_MAX_TITLE } from '../utils/planner.ts';

/**
 * Инструмент помощника: календарь и дела. В отличие от «Ассистента», который
 * просил модель вернуть JSON текстом, здесь используется function calling:
 * аргументы приходят строкой JSON, разбираются zod-схемой и только потом
 * применяются.
 *
 * `actions` описаны свободно (`unknown[]`): мусор вроде неизвестного типа
 * отбрасывает `normalizeEventAction` / `normalizeTaskAction`, а не роняет ответ.
 */
export const plannerReplySchema = z.object({
  reply: z.string().max(1500),
  actions: z.array(z.unknown()).max(AI_MAX_ACTIONS * 2).optional()
});

export type PlannerReply = {
  reply: string;
  actions: unknown[];
};

export const PLANNER_ACTIONS_TOOL = {
  type: 'function',
  function: {
    name: 'planner_actions',
    description:
      'Ответить пользователю и, если он прямо просит, изменить события календаря и дела. Вызывай инструмент на каждый ответ помощника; без просьбы что-то изменить оставляй actions пустым.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reply'],
      properties: {
        reply: {
          type: 'string',
          description: 'Ответ пользователю по-русски: 1–3 коротких предложения.'
        },
        actions: {
          type: 'array',
          description: `Не больше ${AI_MAX_ACTIONS} действий за ответ.`,
          maxItems: AI_MAX_ACTIONS,
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'event.create',
                  'event.update',
                  'event.delete',
                  'task.create',
                  'task.update',
                  'task.delete',
                  'task.done'
                ],
                description: 'Что сделать: событие календаря (event.*) или дело (task.*).'
              },
              id: {
                type: 'string',
                description:
                  'id существующего события или дела — для event.update/event.delete и task.update/task.delete/task.done.'
              },
              title: {
                type: 'string',
                description: `Название события или дела, до ${AI_MAX_TITLE} символов.`
              },
              date: {
                type: 'string',
                description:
                  'Дата в формате ГГГГ-ММ-ДД. Для дела с date создаётся разовое дело; для task.done — день отметки.'
              },
              days: {
                type: 'array',
                items: { type: 'integer', minimum: 0, maximum: 6 },
                description:
                  'Дни недели повтора дела: 0 — понедельник, 1 — вторник, … 6 — воскресенье. Для «каждый день» — все семь.'
              },
              done: {
                type: 'boolean',
                description: 'Для task.done: true — отметить выполненным, false — снять отметку.'
              },
              time: { type: 'string', description: 'Начало в 24-часовом формате ЧЧ:ММ.' },
              endTime: { type: 'string', description: 'Окончание ЧЧ:ММ, если названо.' },
              allDay: { type: 'boolean', description: 'true — событие на весь день.' },
              notes: {
                type: 'string',
                description: `Заметка к событию или делу, до ${AI_MAX_NOTES} символов.`
              }
            }
          }
        }
      }
    }
  }
} as const;

/** Разбор аргументов инструмента. Пустой reply допустим только вместе с действиями. */
export function parsePlannerArgs(
  raw: string
): { ok: true; value: PlannerReply } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Аргументы не являются валидным JSON' };
  }
  const parsed = plannerReplySchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    };
  }
  const reply = parsed.data.reply.trim();
  const actions = parsed.data.actions ?? [];
  if (!reply && actions.length === 0) {
    return { ok: false, error: 'Пустой ответ и нет действий' };
  }
  return { ok: true, value: { reply, actions } };
}
