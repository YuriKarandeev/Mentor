/**
 * Импорт календаря из «Ассистента» (Project1/PlanerOld) в Dexie.
 *
 * Разбор файла живёт в чистом `utils/assistant-backup.ts` (его проверяет
 * `npm run test:planner`), здесь — только запись. Повторный импорт безопасен:
 * события дедуплицируются по «дата + время + название», а битые даты
 * отбрасываются ещё на разборе.
 */
import { addEvent, allEvents } from '../db/db';
import {
  parseAssistantBackup,
  type AssistantEvent,
  type ParsedAssistantBackup
} from '../utils/assistant-backup.ts';

export type { AssistantEvent, ParsedAssistantBackup };
export { assistantState, parseAssistantBackup } from '../utils/assistant-backup.ts';

/** Ключ дедупликации: одно и то же событие не должно задвоиться при повторе. */
function eventKey(date: string, time: string, title: string): string {
  return `${date}|${time}|${title.trim().toLowerCase()}`;
}

export interface ImportResult {
  created: number;
  /** Уже были в календаре (или повторяются внутри файла). */
  duplicates: number;
  /** Нет названия/даты — импортировать нельзя. */
  invalid: number;
}

/**
 * Записывает события в Dexie. Каждое создание идёт через `addEvent`, поэтому
 * строка получает `createdAt/updatedAt/dirty` и сразу попадает в очередь
 * синхронизации — как обычная ручная правка.
 */
export async function importAssistantEvents(events: AssistantEvent[]): Promise<ImportResult> {
  const existing = await allEvents();
  const seen = new Set(existing.map((ev) => eventKey(ev.date, ev.time, ev.title)));
  let created = 0;
  let duplicates = 0;

  for (const ev of events) {
    const key = eventKey(ev.date, ev.time, ev.title);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    await addEvent({
      title: ev.title,
      date: ev.date,
      time: ev.time,
      endTime: ev.endTime,
      allDay: ev.allDay,
      notes: ev.notes
    });
    seen.add(key);
    created += 1;
  }

  return { created, duplicates, invalid: 0 };
}

/** Разбор текста файла и импорт — одна операция для страницы настроек. */
export async function importAssistantFileText(raw: string): Promise<ImportResult> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Не удалось прочитать JSON: файл повреждён или это не копия «Ассистента»');
  }
  const parsed = parseAssistantBackup(json);
  const result = await importAssistantEvents(parsed.events);
  return { ...result, invalid: parsed.invalid };
}
