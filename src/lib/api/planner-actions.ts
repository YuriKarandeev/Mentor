/**
 * Действия помощника с календарём: разбор ответа модели и чистое применение
 * к массиву событий. Модуль без Dexie и Svelte — его проверяет `test:planner`.
 *
 * Главное правило «Ассистента» сохранено: событие без валидной даты и названия
 * не создаётся никогда, а мусорные действия молча отбрасываются.
 */
import type { PlannerEvent } from '../db/db';
import { uid } from '../utils/ids.ts';
import {
  AI_MAX_ACTIONS,
  AI_MAX_NOTES,
  AI_MAX_TITLE,
  formatDateRu,
  text,
  validDate,
  validTime
} from '../utils/planner.ts';

export interface CreateEventAction {
  type: 'event.create';
  title: string;
  date: string;
  time: string;
  endTime: string;
  allDay: boolean;
  notes: string;
}

export interface UpdateEventAction {
  type: 'event.update';
  id: string;
  title?: string;
  date?: string;
  time?: string;
  endTime?: string;
  allDay?: boolean;
  notes?: string;
}

export interface DeleteEventAction {
  type: 'event.delete';
  id: string;
}

export type PlannerEventAction = CreateEventAction | UpdateEventAction | DeleteEventAction;

/** Приведение действия к безопасному виду; null — действие отбрасывается. */
export function normalizeEventAction(raw: unknown): PlannerEventAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const type = text(source.type);

  if (type === 'event.create') {
    const title = text(source.title, AI_MAX_TITLE);
    const date = validDate(source.date);
    if (!title || !date) return null;
    const time = validTime(source.time);
    const allDay = source.allDay === true || !time;
    const endTime = allDay ? '' : validTime(source.endTime);
    return {
      type,
      title,
      date,
      time: allDay ? '' : time,
      endTime: endTime && endTime > time ? endTime : '',
      allDay,
      notes: text(source.notes, AI_MAX_NOTES)
    };
  }

  if (type === 'event.update') {
    const id = text(source.id);
    if (!id) return null;
    const patch: Omit<UpdateEventAction, 'type' | 'id'> = {};
    if (source.title !== undefined) {
      const title = text(source.title, AI_MAX_TITLE);
      if (!title) return null;
      patch.title = title;
    }
    if (source.date !== undefined) {
      const date = validDate(source.date);
      if (!date) return null;
      patch.date = date;
    }
    if (source.allDay === true) {
      patch.allDay = true;
      patch.time = '';
      patch.endTime = '';
    } else if (source.time !== undefined) {
      const time = validTime(source.time);
      if (!time) return null;
      patch.time = time;
      patch.allDay = false;
    }
    if (source.endTime !== undefined) {
      const endTime = validTime(source.endTime);
      if (endTime) patch.endTime = endTime;
    }
    if (source.notes !== undefined) patch.notes = text(source.notes, AI_MAX_NOTES);
    if (Object.keys(patch).length === 0) return null;
    return { type, id, ...patch };
  }

  if (type === 'event.delete') {
    const id = text(source.id);
    return id ? { type, id } : null;
  }

  return null;
}

/** Набор изменений для базы: что записать и что удалить. */
export interface EventChangeSet {
  put: PlannerEvent[];
  remove: string[];
  /** id, у которых нужно снять надгробие (отмена удаления). */
  restore?: string[];
}

export interface AppliedPlannerAction {
  kind: 'create' | 'update' | 'delete';
  id: string;
  title: string;
  date: string;
}

export interface PlannerApplyResult {
  changes: EventChangeSet;
  undo: EventChangeSet;
  applied: AppliedPlannerAction[];
  /** Человекочитаемые причины пропуска — показываются под ответом. */
  skipped: string[];
}

function mergeUpdate(existing: PlannerEvent, patch: UpdateEventAction): PlannerEvent | null {
  const title = patch.title ?? existing.title;
  const date = patch.date ?? existing.date;
  const time = patch.allDay === true ? '' : validTime(patch.time ?? existing.time);
  const allDay = patch.allDay === true || !time;
  const rawEnd = patch.allDay === true ? '' : (patch.endTime ?? existing.endTime);
  const endTime = allDay ? '' : validTime(rawEnd);
  if (!text(title, AI_MAX_TITLE) || !validDate(date)) return null;
  return {
    ...existing,
    title: text(title, AI_MAX_TITLE),
    date: validDate(date),
    time: allDay ? '' : time,
    endTime: endTime && endTime > time ? endTime : '',
    allDay,
    notes: patch.notes !== undefined ? text(patch.notes, AI_MAX_NOTES) : existing.notes
  };
}

/**
 * Применяет действия к копии списка событий. Возвращает изменения для базы
 * и обратный набор — кнопка «Отменить» откатывает всю пачку одним вызовом.
 */
export function applyPlannerActions(
  actions: unknown[],
  events: PlannerEvent[],
  options: { now?: number; newId?: () => string } = {}
): PlannerApplyResult {
  const ts = options.now ?? Date.now();
  const newId = options.newId ?? (() => uid('ev'));

  const byId = new Map(events.map((ev) => [ev.id, { ...ev }]));
  /** Исходные версии изменённых/удалённых строк — для отмены. */
  const originals = new Map<string, PlannerEvent>();
  const created: string[] = [];
  const applied: AppliedPlannerAction[] = [];
  const skipped: string[] = [];

  let used = 0;
  for (const raw of Array.isArray(actions) ? actions : []) {
    const action = normalizeEventAction(raw);
    if (!action) {
      skipped.push('Непонятное действие пропущено');
      continue;
    }
    if (used >= AI_MAX_ACTIONS) {
      skipped.push(`Слишком много действий: применены первые ${AI_MAX_ACTIONS}`);
      break;
    }

    if (action.type === 'event.create') {
      const row: PlannerEvent = {
        id: newId(),
        title: action.title,
        date: action.date,
        time: action.time,
        endTime: action.endTime,
        allDay: action.allDay,
        notes: action.notes,
        createdAt: ts,
        updatedAt: ts,
        dirty: 1
      };
      byId.set(row.id, row);
      created.push(row.id);
      used += 1;
      applied.push({ kind: 'create', id: row.id, title: row.title, date: row.date });
      continue;
    }

    if (action.type === 'event.update') {
      const existing = byId.get(action.id);
      if (!existing) {
        skipped.push(`Событие для изменения не найдено: ${action.id}`);
        continue;
      }
      const merged = mergeUpdate(existing, action);
      if (!merged) {
        skipped.push('Изменение события пропущено: некорректные дата или название');
        continue;
      }
      if (!originals.has(existing.id)) originals.set(existing.id, { ...existing });
      const row: PlannerEvent = { ...merged, updatedAt: ts, dirty: 1 };
      byId.set(row.id, row);
      used += 1;
      applied.push({ kind: 'update', id: row.id, title: row.title, date: row.date });
      continue;
    }

    const existing = byId.get(action.id);
    if (!existing) {
      skipped.push(`Событие для удаления не найдено: ${action.id}`);
      continue;
    }
    if (!originals.has(existing.id)) originals.set(existing.id, { ...existing });
    byId.delete(existing.id);
    used += 1;
    applied.push({ kind: 'delete', id: existing.id, title: existing.title, date: existing.date });
  }

  const put = applied
    .filter((a) => a.kind !== 'delete')
    .map((a) => byId.get(a.id))
    .filter((row): row is PlannerEvent => Boolean(row));
  const remove = applied.filter((a) => a.kind === 'delete').map((a) => a.id);

  const undoPut = [...originals.values()].filter((row) => !created.includes(row.id));
  const undoRemove = [...created];
  const undoRestore = remove.filter((id) => originals.has(id));

  return {
    changes: { put, remove },
    undo: { put: undoPut, remove: undoRemove, restore: undoRestore },
    applied,
    skipped
  };
}

/** Подписи для карточек подтверждения: id пользователю ничего не говорит. */
export function describeEventActions(actions: unknown[], events: PlannerEvent[]): string[] {
  const titles = new Map(events.map((ev) => [ev.id, ev.title]));
  return actions.map((raw) => {
    const action = normalizeEventAction(raw);
    if (!action) return 'Непонятное действие — пропущено';

    if (action.type === 'event.create') {
      return (
        `Добавить событие «${action.title}» на ${formatDateRu(action.date)}` +
        (action.time ? ` в ${action.time}` : ', весь день')
      );
    }

    if (action.type === 'event.update') {
      const parts: string[] = [];
      if (action.title) parts.push(`название «${action.title}»`);
      if (action.date) parts.push(`дата ${formatDateRu(action.date)}`);
      if (action.time) parts.push(`время ${action.time}${action.endTime ? `–${action.endTime}` : ''}`);
      else if (action.allDay) parts.push('весь день');
      if (action.notes !== undefined) parts.push('заметка');
      return `Изменить событие «${titles.get(action.id) ?? action.id}»: ${parts.join(', ') || 'без изменений'}`;
    }

    return `Удалить событие «${titles.get(action.id) ?? action.id}»`;
  });
}

