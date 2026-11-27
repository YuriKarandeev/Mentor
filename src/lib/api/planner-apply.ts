/**
 * Применение действий помощника к событиям и делам — чистые функции.
 * Вынесено из `planner-actions.ts`, чтобы разбор ответа модели (там) и
 * применение изменений (здесь) читались отдельно.
 *
 * Модуль без Dexie и Svelte: `npm run test:planner` и `npm run test:tasks`
 * проверяют его обычным импортом из Node.
 */
import type { PlannerEvent, PlannerTask } from '../db/db';
import { uid } from '../utils/ids.ts';
import {
  AI_MAX_ACTIONS,
  AI_MAX_NOTES,
  AI_MAX_TITLE,
  formatDateRu,
  text,
  todayIso,
  validDate,
  validTime
} from '../utils/planner.ts';
import { TASK_MAX_NOTES, TASK_MAX_TITLE, normalizeDays, repeatLabel, withTaskDone } from '../utils/tasks.ts';
import {
  normalizeEventAction,
  normalizeTaskAction,
  type AppliedPlannerAction,
  type EventChangeSet,
  type PlannerApplyResult,
  type PlannerState,
  type TaskChangeSet,
  type UpdateEventAction,
  type UpdateTaskAction
} from './planner-actions.ts';

/** Правка события: меняются только переданные поля. */
function mergeEventUpdate(existing: PlannerEvent, patch: UpdateEventAction): PlannerEvent | null {
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

/** Правка дела: расписание всегда остаётся либо днями, либо одной датой. */
function mergeTaskUpdate(existing: PlannerTask, patch: UpdateTaskAction): PlannerTask | null {
  const title = text(patch.title ?? existing.title, TASK_MAX_TITLE);
  if (!title) return null;
  const onceDate = patch.date !== undefined ? validDate(patch.date) : validDate(existing.onceDate);
  const days = onceDate ? [] : normalizeDays(patch.days ?? existing.days);
  if (!onceDate && days.length === 0) return null;
  return {
    ...existing,
    title,
    notes: patch.notes !== undefined ? text(patch.notes, TASK_MAX_NOTES) : existing.notes,
    days,
    onceDate,
    time: patch.time !== undefined ? validTime(patch.time) : existing.time
  };
}

/**
 * Применяет действия к копиям списков. Возвращает изменения для базы
 * и обратный набор: кнопка «Отменить» откатывает всю пачку одним вызовом.
 *
 * `state` принимает и голый массив событий — так вызов остаётся совместимым
 * со старыми тестами и не требует передавать пустой список дел.
 */
export function applyPlannerActions(
  actions: unknown[],
  state: PlannerEvent[] | PlannerState,
  options: { now?: number; newId?: () => string; today?: string } = {}
): PlannerApplyResult {
  const ts = options.now ?? Date.now();
  const today = validDate(options.today) || todayIso(ts);
  const newId = options.newId ?? (() => uid('ev'));
  const source: PlannerState = Array.isArray(state) ? { events: state } : state;

  const eventMap = new Map(source.events.map((ev) => [ev.id, { ...ev }]));
  const taskMap = new Map((source.tasks ?? []).map((task) => [task.id, { ...task }]));
  /** Исходные версии изменённых/удалённых строк — для отмены. */
  const eventOriginals = new Map<string, PlannerEvent>();
  const taskOriginals = new Map<string, PlannerTask>();
  const createdEvents: string[] = [];
  const createdTasks: string[] = [];
  const deletedEvents: string[] = [];
  const deletedTasks: string[] = [];
  const applied: AppliedPlannerAction[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const raw of Array.isArray(actions) ? actions : []) {
    const type = text((raw as Record<string, unknown> | null)?.type);
    const isTask = type.startsWith('task.');

    if (used >= AI_MAX_ACTIONS) {
      skipped.push(`Слишком много действий: применены первые ${AI_MAX_ACTIONS}`);
      break;
    }

    if (isTask) {
      const action = normalizeTaskAction(raw, today);
      if (!action) {
        skipped.push('Непонятное действие с делом пропущено');
        continue;
      }

      if (action.type === 'task.create') {
        const row: PlannerTask = {
          id: newId(),
          title: action.title,
          notes: action.notes,
          days: action.days,
          onceDate: action.date,
          time: action.time,
          done: [],
          createdAt: ts,
          updatedAt: ts,
          dirty: 1
        };
        taskMap.set(row.id, row);
        createdTasks.push(row.id);
        used += 1;
        applied.push({ entity: 'task', kind: 'create', id: row.id, title: row.title, date: row.onceDate });
        continue;
      }

      const existing = taskMap.get(action.id);
      if (!existing) {
        skipped.push(`Дело не найдено: ${action.id}`);
        continue;
      }

      if (action.type === 'task.update') {
        const merged = mergeTaskUpdate(existing, action);
        if (!merged) {
          skipped.push('Изменение дела пропущено: нужны название и расписание');
          continue;
        }
        if (!taskOriginals.has(existing.id)) taskOriginals.set(existing.id, { ...existing });
        const row: PlannerTask = { ...merged, updatedAt: ts, dirty: 1 };
        taskMap.set(row.id, row);
        used += 1;
        applied.push({ entity: 'task', kind: 'update', id: row.id, title: row.title, date: row.onceDate });
        continue;
      }

      if (action.type === 'task.done') {
        const day = action.date || today;
        if (!taskOriginals.has(existing.id)) taskOriginals.set(existing.id, { ...existing });
        const row: PlannerTask = { ...withTaskDone(existing, day, action.done), updatedAt: ts, dirty: 1 };
        taskMap.set(row.id, row);
        used += 1;
        applied.push({ entity: 'task', kind: 'done', id: row.id, title: row.title, date: day });
        continue;
      }

      if (!taskOriginals.has(existing.id)) taskOriginals.set(existing.id, { ...existing });
      taskMap.delete(existing.id);
      deletedTasks.push(existing.id);
      used += 1;
      applied.push({ entity: 'task', kind: 'delete', id: existing.id, title: existing.title, date: existing.onceDate });
      continue;
    }

    const action = normalizeEventAction(raw);
    if (!action) {
      skipped.push('Непонятное действие пропущено');
      continue;
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
      eventMap.set(row.id, row);
      createdEvents.push(row.id);
      used += 1;
      applied.push({ entity: 'event', kind: 'create', id: row.id, title: row.title, date: row.date });
      continue;
    }

    if (action.type === 'event.update') {
      const existing = eventMap.get(action.id);
      if (!existing) {
        skipped.push(`Событие для изменения не найдено: ${action.id}`);
        continue;
      }
      const merged = mergeEventUpdate(existing, action);
      if (!merged) {
        skipped.push('Изменение события пропущено: некорректные дата или название');
        continue;
      }
      if (!eventOriginals.has(existing.id)) eventOriginals.set(existing.id, { ...existing });
      const row: PlannerEvent = { ...merged, updatedAt: ts, dirty: 1 };
      eventMap.set(row.id, row);
      used += 1;
      applied.push({ entity: 'event', kind: 'update', id: row.id, title: row.title, date: row.date });
      continue;
    }

    const existing = eventMap.get(action.id);
    if (!existing) {
      skipped.push(`Событие для удаления не найдено: ${action.id}`);
      continue;
    }
    if (!eventOriginals.has(existing.id)) eventOriginals.set(existing.id, { ...existing });
    eventMap.delete(existing.id);
    deletedEvents.push(existing.id);
    used += 1;
    applied.push({ entity: 'event', kind: 'delete', id: existing.id, title: existing.title, date: existing.date });
  }

  const eventPut = [...eventMap.values()].filter((row) => eventOriginals.has(row.id) || createdEvents.includes(row.id));
  const taskPut = [...taskMap.values()].filter((row) => taskOriginals.has(row.id) || createdTasks.includes(row.id));

  const eventsUndo: EventChangeSet = {
    put: [...eventOriginals.values()].filter((row) => !createdEvents.includes(row.id)),
    remove: [...createdEvents],
    restore: deletedEvents.filter((id) => eventOriginals.has(id))
  };
  const tasksUndo: TaskChangeSet = {
    put: [...taskOriginals.values()].filter((row) => !createdTasks.includes(row.id)),
    remove: [...createdTasks],
    restore: deletedTasks.filter((id) => taskOriginals.has(id))
  };

  return {
    changes: {
      events: { put: eventPut, remove: deletedEvents },
      tasks: { put: taskPut, remove: deletedTasks }
    },
    undo: { events: eventsUndo, tasks: tasksUndo },
    applied,
    skipped
  };
}

/** Подписи для карточек подтверждения: id пользователю ничего не говорит. */
export function describePlannerActions(
  actions: unknown[],
  state: PlannerEvent[] | PlannerState
): string[] {
  const source: PlannerState = Array.isArray(state) ? { events: state } : state;
  const eventTitles = new Map(source.events.map((ev) => [ev.id, ev.title]));
  const taskTitles = new Map((source.tasks ?? []).map((task) => [task.id, task.title]));

  return actions.map((raw) => {
    const type = text((raw as Record<string, unknown> | null)?.type);

    if (type.startsWith('task.')) {
      const action = normalizeTaskAction(raw);
      if (!action) return 'Непонятное действие с делом — пропущено';
      const name = 'id' in action ? (taskTitles.get(action.id) ?? action.id) : '';

      if (action.type === 'task.create') {
        const time = action.time ? ` в ${action.time}` : '';
        return `Добавить дело «${action.title}»: ${repeatLabel(action.days, action.date)}${time}`;
      }
      if (action.type === 'task.update') {
        const parts: string[] = [];
        if (action.title) parts.push(`название «${action.title}»`);
        if (action.days !== undefined || action.date !== undefined) {
          parts.push(`расписание ${repeatLabel(action.days ?? [], action.date ?? '')}`);
        }
        if (action.time !== undefined) parts.push(action.time ? `время ${action.time}` : 'без времени');
        if (action.notes !== undefined) parts.push('заметка');
        return `Изменить дело «${name}»: ${parts.join(', ') || 'без изменений'}`;
      }
      if (action.type === 'task.done') {
        const when = action.date ? formatDateRu(action.date) : 'сегодня';
        return action.done
          ? `Отметить дело «${name}» выполненным на ${when}`
          : `Снять отметку с дела «${name}» на ${when}`;
      }
      return `Удалить дело «${name}»`;
    }

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
      const name = eventTitles.get(action.id) ?? action.id;
      return `Изменить событие «${name}»: ${parts.join(', ') || 'без изменений'}`;
    }

    return `Удалить событие «${eventTitles.get(action.id) ?? action.id}»`;
  });
}
