/**
 * Действия помощника с календарём и делами: разбор ответа модели и чистое
 * применение к массивам событий и задач. Модуль без Dexie и Svelte —
 * его проверяют `npm run test:planner` и `npm run test:tasks`.
 *
 * Главное правило «Ассистента» сохранено: событие без валидной даты и названия
 * не создаётся никогда, а мусорные действия молча отбрасываются. Для дел
 * так же обязательны название и расписание (дни недели или дата).
 */
import type { PlannerEvent, PlannerTask } from '../db/db';
import {
  AI_MAX_NOTES,
  AI_MAX_TITLE,
  text,
  todayIso,
  validDate,
  validTime
} from '../utils/planner.ts';
import { TASK_MAX_NOTES, TASK_MAX_TITLE, parseDays } from '../utils/tasks.ts';

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

export interface CreateTaskAction {
  type: 'task.create';
  title: string;
  /** Дни недели повтора: 0 — понедельник … 6 — воскресенье. */
  days: number[];
  /** Разовая дата; при ней `days` пустой. */
  date: string;
  time: string;
  notes: string;
}

export interface UpdateTaskAction {
  type: 'task.update';
  id: string;
  title?: string;
  days?: number[];
  date?: string;
  time?: string;
  notes?: string;
}

export interface DeleteTaskAction {
  type: 'task.delete';
  id: string;
}

export interface DoneTaskAction {
  type: 'task.done';
  id: string;
  /** День, за который ставится отметка; по умолчанию сегодня. */
  date: string;
  done: boolean;
}

export type PlannerTaskAction = CreateTaskAction | UpdateTaskAction | DeleteTaskAction | DoneTaskAction;

export type PlannerAction = PlannerEventAction | PlannerTaskAction;

/**
 * Приведение действия с делом к безопасному виду; null — действие отбрасывается.
 * Расписание обязательно: без дней и без даты дело не появляется в списке
 * никогда, поэтому такое действие бесполезно.
 */
export function normalizeTaskAction(raw: unknown, fallbackDate = todayIso()): PlannerTaskAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const type = text(source.type);

  if (type === 'task.create') {
    const title = text(source.title, TASK_MAX_TITLE);
    if (!title) return null;
    const onceDate = validDate(source.date);
    const days = onceDate ? [] : parseDays(source.days);
    if (!onceDate && days.length === 0) return null;
    return {
      type,
      title,
      days,
      date: onceDate,
      time: validTime(source.time),
      notes: text(source.notes, TASK_MAX_NOTES)
    };
  }

  if (type === 'task.update') {
    const id = text(source.id);
    if (!id) return null;
    const patch: Omit<UpdateTaskAction, 'type' | 'id'> = {};
    if (source.title !== undefined) {
      const title = text(source.title, TASK_MAX_TITLE);
      if (!title) return null;
      patch.title = title;
    }
    if (source.date !== undefined) {
      const date = validDate(source.date);
      if (!date) return null;
      patch.date = date;
      patch.days = [];
    } else if (source.days !== undefined) {
      const days = parseDays(source.days);
      if (days.length === 0) return null;
      patch.days = days;
      patch.date = '';
    }
    if (source.time !== undefined) patch.time = validTime(source.time);
    if (source.notes !== undefined) patch.notes = text(source.notes, TASK_MAX_NOTES);
    if (Object.keys(patch).length === 0) return null;
    return { type, id, ...patch };
  }

  if (type === 'task.delete') {
    const id = text(source.id);
    return id ? { type, id } : null;
  }

  if (type === 'task.done') {
    const id = text(source.id);
    if (!id) return null;
    return {
      type,
      id,
      date: validDate(source.date) || validDate(fallbackDate),
      done: source.done !== false
    };
  }

  return null;
}

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

export interface TaskChangeSet {
  put: PlannerTask[];
  remove: string[];
  restore?: string[];
}

export interface AppliedPlannerAction {
  entity: 'event' | 'task';
  kind: 'create' | 'update' | 'delete' | 'done';
  id: string;
  title: string;
  /** Дата события или день, за который отмечено дело. */
  date: string;
}

export interface PlannerApplyResult {
  changes: { events: EventChangeSet; tasks: TaskChangeSet };
  undo: { events: EventChangeSet; tasks: TaskChangeSet };
  applied: AppliedPlannerAction[];
  /** Человекочитаемые причины пропуска — показываются под ответом. */
  skipped: string[];
}

/** Состояние, к которому применяются действия помощника. */
export interface PlannerState {
  events: PlannerEvent[];
  tasks?: PlannerTask[];
}

export { applyPlannerActions, describePlannerActions } from "./planner-apply.ts";
