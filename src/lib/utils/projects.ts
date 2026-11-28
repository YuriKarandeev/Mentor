/**
 * Проекты и их канбан-доска.
 *
 * Чистые функции без Dexie и DOM: порядок карточек, перенос между колонками,
 * прогресс и подписи. Всё, что пишется в базу, приходит сюда за «планом
 * перемещения» — так одну и ту же логику использует и страница, и тесты.
 */

/** Колонки канбана. Порядок массива — порядок колонок на экране. */
export type CardColumn = 'todo' | 'doing' | 'done';

export const CARD_COLUMNS: CardColumn[] = ['todo', 'doing', 'done'];

export const COLUMN_LABELS: Record<CardColumn, string> = {
  todo: 'Надо',
  doing: 'В работе',
  done: 'Готово'
};

export const COLUMN_HINTS: Record<CardColumn, string> = {
  todo: 'Что предстоит сделать',
  doing: 'Взято в работу прямо сейчас',
  done: 'Завершённые карточки'
};

export const PROJECT_MAX_TITLE = 120;
export const PROJECT_MAX_NOTES = 1000;
export const CARD_MAX_TITLE = 160;
export const CARD_MAX_NOTES = 600;

/** Подписи статуса проекта. */
export const PROJECT_STATUS_LABELS = {
  active: 'активный',
  paused: 'на паузе',
  done: 'завершён'
} as const;

export function normalizeColumn(value: unknown): CardColumn {
  return value === 'doing' || value === 'done' ? value : 'todo';
}

/** Порядок карточки — целое неотрицательное число; мусор из облака становится 0. */
export function normalizeOrder(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface CardLike {
  id: string;
  column: string;
  order: number;
}

export interface CardOrderPatch {
  id: string;
  column: CardColumn;
  order: number;
}

/** Сортировка карточек внутри колонки: сначала порядок, затем id — стабильно на всех устройствах. */
export function compareCards(a: CardLike, b: CardLike): number {
  const diff = normalizeOrder(a.order) - normalizeOrder(b.order);
  if (diff !== 0) return diff;
  return a.id.localeCompare(b.id);
}

/** Карточки одной колонки, отсортированные по порядку. */
export function cardsIn<T extends CardLike>(cards: T[], column: CardColumn): T[] {
  return cards.filter((card) => normalizeColumn(card.column) === column).sort(compareCards);
}

/** Карточки проекта, сгруппированные по колонкам. */
export function boardOf<T extends CardLike & { projectId: string }>(
  cards: T[],
  projectId: string
): Record<CardColumn, T[]> {
  const own = cards.filter((card) => card.projectId === projectId);
  return {
    todo: cardsIn(own, 'todo'),
    doing: cardsIn(own, 'doing'),
    done: cardsIn(own, 'done')
  };
}

/** Следующий свободный номер в колонке — карточка встаёт в конец. */
export function nextOrder(cards: CardLike[], column: CardColumn): number {
  const list = cardsIn(cards, column);
  return list.reduce((max, card) => Math.max(max, normalizeOrder(card.order) + 1), 0);
}

/** Прогресс доски: сколько карточек в «Готово». */
export function boardProgress(cards: CardLike[]): { done: number; total: number; pct: number } {
  const total = cards.length;
  const done = cards.filter((card) => normalizeColumn(card.column) === 'done').length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * План переноса карточки в колонку: она встаёт последней, а порядок всех
 * карточек колонки перенумеровывается без дырок. Возвращаются только те
 * строки, которые действительно меняются, — лишних записей в базу не будет.
 */
export function planMove(cards: CardLike[], cardId: string, column: CardColumn): CardOrderPatch[] {
  const moved = cards.find((card) => card.id === cardId);
  if (!moved) return [];
  // Оставшиеся карточки перенумеровываются без дырок: иначе на месте
  // перемещённой образовался бы дубль порядка.
  const target = cardsIn(cards, column)
    .filter((card) => card.id !== cardId)
    .map((card, index) => ({ ...card, column, order: index }));
  return patchesFor([...target, { ...moved, column, order: target.length }], cards);
}

/**
 * Сдвиг карточки внутри своей колонки: delta −1 — выше, +1 — ниже.
 * На краю списка ничего не происходит.
 */
export function planShift(cards: CardLike[], cardId: string, delta: number): CardOrderPatch[] {
  const moved = cards.find((card) => card.id === cardId);
  if (!moved) return [];
  const column = normalizeColumn(moved.column);
  const list = cardsIn(cards, column);
  const index = list.findIndex((card) => card.id === cardId);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= list.length) return [];
  const reordered = [...list];
  const [item] = reordered.splice(index, 1);
  reordered.splice(next, 0, item);
  return patchesFor(
    reordered.map((card, i) => ({ ...card, order: i })),
    cards
  );
}

/** Патчи только для тех карточек, у которых изменились колонка или порядок. */
function patchesFor(next: CardLike[], current: CardLike[]): CardOrderPatch[] {
  const before = new Map(current.map((card) => [card.id, card] as [string, CardLike]));
  const patches: CardOrderPatch[] = [];
  for (const card of next) {
    const column = normalizeColumn(card.column);
    const order = normalizeOrder(card.order);
    const old = before.get(card.id);
    if (!old || normalizeColumn(old.column) !== column || normalizeOrder(old.order) !== order) {
      patches.push({ id: card.id, column, order });
    }
  }
  return patches;
}

/** Активные проекты идут первыми, затем пауза, затем завершённые. */
export function compareProjects(
  a: { title: string; status: string; dueDate: string; createdAt: number },
  b: { title: string; status: string; dueDate: string; createdAt: number }
): number {
  const rank = (status: string) => (status === 'active' ? 0 : status === 'paused' ? 1 : 2);
  const byStatus = rank(a.status) - rank(b.status);
  if (byStatus !== 0) return byStatus;
  // Ближайший срок — выше; проекты без срока идут после.
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.title.localeCompare(b.title, 'ru');
}

/** Подпись дедлайна: «до 28.11.2026» или пустая строка. */
export function dueLabel(dueDate: string): string {
  return dueDate ? `до ${dueDate.slice(8, 10)}.${dueDate.slice(5, 7)}.${dueDate.slice(0, 4)}` : '';
}
