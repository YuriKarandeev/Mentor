/**
 * Разбор JSON-копии «Ассистента» — чистые функции без Dexie.
 *
 * Экспорт «Ассистента» — это `{ app: 'planer', schema: 3, state: {...} }`,
 * где события лежат в `state.events`. Здесь же принимается «голое» состояние
 * (как в localStorage `hobbies_health_mvp_v3`), поэтому копию можно достать
 * и из файла, и из старого браузера. Запись в базу — в `sync/import-assistant.ts`.
 */
import { text, validDate, validTime } from './planner.ts';

export interface AssistantEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  endTime: string;
  allDay: boolean;
  notes: string;
  createdAt: number;
}

export interface ParsedAssistantBackup {
  events: AssistantEvent[];
  /** Сколько элементов массива не похожи на событие. */
  invalid: number;
  /** `app` из файла — для сообщения пользователю. */
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Достаёт состояние из файла копии или «голого» state. */
export function assistantState(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  if (!root) throw new Error('Файл не похож на копию «Ассистента»');
  const nested = asRecord(root.state);
  return nested ?? root;
}

/** Разбор уже распарсенного JSON в события. Бросает понятную ошибку на мусоре. */
export function parseAssistantBackup(raw: unknown): ParsedAssistantBackup {
  const state = assistantState(raw);
  if (!Array.isArray(state.events)) {
    throw new Error('В файле нет списка событий (state.events)');
  }

  const events: AssistantEvent[] = [];
  let invalid = 0;
  for (const item of state.events) {
    const source = asRecord(item);
    if (!source) {
      invalid += 1;
      continue;
    }
    const title = text(source.title);
    const date = validDate(source.date);
    if (!title || !date) {
      invalid += 1;
      continue;
    }
    const time = validTime(source.time);
    const allDay = source.allDay === true || !time;
    const endTime = allDay ? '' : validTime(source.endTime);
    const createdAt = Number(source.createdAt);
    events.push({
      id: text(source.id),
      title,
      date,
      time: allDay ? '' : time,
      endTime: endTime && endTime > time ? endTime : '',
      allDay,
      notes: text(source.notes),
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0
    });
  }

  const root = asRecord(raw);
  const source = root && typeof root.app === 'string' ? root.app : 'assistant';
  return { events, invalid, source };
}
