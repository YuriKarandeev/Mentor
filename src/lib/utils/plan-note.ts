import type { Note, Plan, PlanItem, PlanModule } from '../db/db';

/**
 * Тег заметки, которая служит конспектом пункта плана.
 *
 * Привязку храним в `tags`, а не в отдельном поле: `toRemoteNote` синхронизирует
 * теги, а произвольные новые поля в белый список облака не попадают.
 */
export const PLAN_ITEM_TAG_PREFIX = 'plan-item:';

export function itemTag(itemId: string): string {
  return `${PLAN_ITEM_TAG_PREFIX}${itemId}`;
}

/**
 * Конспект пункта по списку заметок темы. Список приходит отсортированным
 * по `createdAt` вниз, поэтому `find` отдаёт самую свежую версию.
 */
export function findItemNote(notes: Note[], itemId: string): Note | undefined {
  const tag = itemTag(itemId);
  return notes.find((n) => (n.tags ?? []).includes(tag));
}

/** id пунктов, для которых уже есть сохранённый конспект. */
export function summarisedItemIds(notes: Note[]): Set<string> {
  const ids = new Set<string>();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      if (tag.startsWith(PLAN_ITEM_TAG_PREFIX)) ids.add(tag.slice(PLAN_ITEM_TAG_PREFIX.length));
    }
  }
  return ids;
}

/** Пункт плана вместе с модулем — нужен для промпта и заголовка конспекта. */
export interface PlanItemRef {
  module: PlanModule;
  item: PlanItem;
}

export function findPlanItem(plan: Plan | undefined, itemId: string): PlanItemRef | undefined {
  if (!plan) return undefined;
  for (const module of plan.modules) {
    const item = module.items.find((i) => i.id === itemId);
    if (item) return { module, item };
  }
  return undefined;
}
