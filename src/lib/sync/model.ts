/**
 * Чистые функции обмена с облаком: никакого Firebase и Dexie внутри,
 * поэтому модуль легко проверять отдельным скриптом (npm run test:sync).
 */
import type {
  BudgetAsset,
  BudgetCategory,
  BudgetObligation,
  BudgetSnapshot,
  BudgetTransaction,
  MemoryRow,
  MoneyAccount,
  MonthBudget,
  Note,
  Plan,
  PlannerEvent,
  PlannerTask,
  Profile,
  Project,
  ProjectCard,
  StoredMessage,
  Topic,
  Tombstone
} from '../db/db';
import {
  normalizeAccount,
  normalizeAsset,
  normalizeBudget,
  normalizeCategory,
  normalizeObligation,
  normalizeSnapshot,
  normalizeTransaction,
  validMonth
} from '../utils/budget.ts';
import { AI_MAX_NOTES, AI_MAX_TITLE, text, validDate, validTime } from '../utils/planner.ts';
import { normalizeDoneDates, normalizeDays } from '../utils/tasks.ts';
import {
  CARD_MAX_NOTES,
  CARD_MAX_TITLE,
  PROJECT_MAX_NOTES,
  PROJECT_MAX_TITLE,
  normalizeColumn,
  normalizeOrder
} from '../utils/projects.ts';

/** Коллекции Firestore внутри users/{uid}. */
export type SyncedCollection =
  | 'topics'
  | 'plans'
  | 'messages'
  | 'notes'
  | 'memory'
  | 'events'
  | 'tasks'
  | 'projects'
  | 'projectCards'
  | 'accounts'
  | 'categories'
  | 'transactions'
  | 'budgets'
  | 'obligations'
  | 'assets'
  | 'snapshots';

export const SYNCED_COLLECTIONS: SyncedCollection[] = [
  'topics',
  'plans',
  'messages',
  'notes',
  'memory',
  'events',
  'tasks',
  'projects',
  'projectCards',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'obligations',
  'assets',
  'snapshots'
];

export const COLLECTION_PROFILE = 'profile';
export const PROFILE_DOC_ID = 'main';
export const COLLECTION_TOMBSTONES = 'tombstones';

/** Версия формата документа в облаке — на случай будущих миграций. */
export const CLOUD_SCHEMA_VERSION = 2;

/** Firestore принимает до 500 операций в батче, берём с запасом. */
export const MAX_BATCH_WRITES = 400;
export const PULL_PAGE_SIZE = 200;
/** Перекрытие окна выгрузки: страховка от расхождения часов между устройствами. */
export const PULL_OVERLAP_MS = 10 * 60 * 1000;

export function collectionForTombstone(type: Tombstone['type']): string {
  switch (type) {
    case 'topic':
      return 'topics';
    case 'plan':
      return 'plans';
    case 'message':
      return 'messages';
    case 'note':
      return 'notes';
    case 'memory':
      return 'memory';
    case 'profile':
      return COLLECTION_PROFILE;
    case 'event':
      return 'events';
    case 'task':
      return 'tasks';
    case 'project':
      return 'projects';
    case 'projectCard':
      return 'projectCards';
    case 'account':
      return 'accounts';
    case 'category':
      return 'categories';
    case 'transaction':
      return 'transactions';
    case 'budget':
      return 'budgets';
    case 'obligation':
      return 'obligations';
    case 'asset':
      return 'assets';
    case 'snapshot':
      return 'snapshots';
  }
}

export function docIdForTombstone(tombstone: Tombstone): string {
  return tombstone.type === 'profile' ? PROFILE_DOC_ID : tombstone.refId;
}

export interface Versioned {
  updatedAt: number;
}

/**
 * Разрешение конфликтов: побеждает более новая запись по клиентскому updatedAt.
 * При равных метках оставляем локальную копию — она уже применена на устройстве.
 */
export function shouldApply(local: Versioned | undefined | null, remote: Versioned): boolean {
  if (!local) return true;
  const localAt = Number(local.updatedAt ?? 0);
  const remoteAt = Number(remote.updatedAt ?? 0);
  return remoteAt > localAt;
}

export function pickUpdatedAt(data: Record<string, unknown>): number {
  const value = Number(data.updatedAt ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Убирает служебное поле srvUpdatedAt перед записью в локальную базу. */
export function withoutServerFields(data: Record<string, unknown>): Record<string, unknown> {
  const { srvUpdatedAt: _srv, ...rest } = data;
  return rest;
}

/* --- Локальная запись → документ облака (явные белые списки полей) --- */

export function toRemoteTopic(topic: Topic): Record<string, unknown> {
  return {
    title: topic.title,
    goal: topic.goal,
    level: topic.level,
    hoursPerWeek: topic.hoursPerWeek,
    status: topic.status,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemotePlan(plan: Plan): Record<string, unknown> {
  return {
    topicId: plan.topicId,
    title: plan.title,
    summary: plan.summary ?? null,
    modules: plan.modules,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteMessage(message: StoredMessage): Record<string, unknown> {
  return {
    topicId: message.topicId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning ?? null,
    citations: message.citations ?? [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteNote(note: Note): Record<string, unknown> {
  return {
    topicId: note.topicId ?? null,
    title: note.title,
    md: note.md,
    source: note.source,
    tags: note.tags ?? [],
    citations: note.citations ?? [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteMemory(row: MemoryRow): Record<string, unknown> {
  return {
    text: row.text,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function toRemoteEvent(event: PlannerEvent): Record<string, unknown> {
  return {
    title: event.title,
    date: event.date,
    time: event.time,
    endTime: event.endTime,
    allDay: event.allDay,
    notes: event.notes,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

/**
 * Документ облака → строка локальной базы. Дата и время прогоняются через
 * валидаторы: битые значения из чужой версии клиента не должны появиться
 * в календаре (движок пропускает записи без даты).
 */
export function fromRemoteEvent(id: string, data: Record<string, unknown>): PlannerEvent {
  const updatedAt = pickUpdatedAt(data);
  const time = validTime(data.time);
  const allDay = data.allDay === true || !time;
  const endTime = validTime(data.endTime);
  return {
    id,
    title: text(data.title, AI_MAX_TITLE),
    date: validDate(data.date),
    time: allDay ? '' : time,
    endTime: allDay || !endTime || endTime <= time ? '' : endTime,
    allDay,
    notes: text(data.notes, AI_MAX_NOTES),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/**
 * Дело в облако. `done` — история отметок, поэтому она тоже уходит:
 * иначе на втором устройстве пропадёт, что сделано вчера.
 */
export function toRemoteTask(task: PlannerTask): Record<string, unknown> {
  return {
    title: task.title,
    notes: task.notes,
    days: normalizeDays(task.days),
    onceDate: task.onceDate || '',
    time: task.time,
    done: normalizeDoneDates(task.done),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

/**
 * Документ облака → дело. Расписание нормализуется: без дней и без даты
 * дело не выполняется никогда, такие записи движок отбрасывает.
 */
export function fromRemoteTask(id: string, data: Record<string, unknown>): PlannerTask {
  const updatedAt = pickUpdatedAt(data);
  const onceDate = validDate(data.onceDate);
  return {
    id,
    title: text(data.title, AI_MAX_TITLE),
    notes: text(data.notes, AI_MAX_NOTES),
    days: onceDate ? [] : normalizeDays(data.days),
    onceDate,
    time: validTime(data.time),
    done: normalizeDoneDates(data.done),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/**
 * Проект в облако. Карточки едут отдельными документами: перенос одной
 * карточки не перезаписывает весь проект.
 */
export function toRemoteProject(project: Project): Record<string, unknown> {
  return {
    title: project.title,
    goal: project.goal,
    notes: project.notes,
    status: project.status,
    dueDate: project.dueDate,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteProject(id: string, data: Record<string, unknown>): Project {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    title: text(data.title, PROJECT_MAX_TITLE),
    goal: text(data.goal, PROJECT_MAX_TITLE),
    notes: text(data.notes, PROJECT_MAX_NOTES),
    status: data.status === 'paused' || data.status === 'done' ? data.status : 'active',
    dueDate: validDate(data.dueDate),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/**
 * Карточка в облако. `column` и `order` обязательны: по ним строится доска.
 * `projectId` — ссылка на проект, как `topicId` у плана.
 */
export function toRemoteProjectCard(card: ProjectCard): Record<string, unknown> {
  return {
    projectId: card.projectId,
    title: card.title,
    notes: card.notes,
    column: normalizeColumn(card.column),
    order: normalizeOrder(card.order),
    dueDate: card.dueDate,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteProjectCard(id: string, data: Record<string, unknown>): ProjectCard {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    projectId: text(data.projectId),
    title: text(data.title, CARD_MAX_TITLE),
    notes: text(data.notes, CARD_MAX_NOTES),
    column: normalizeColumn(data.column),
    order: normalizeOrder(data.order),
    dueDate: validDate(data.dueDate),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/**
 * Профиль в облако. Именно белый список полей гарантирует,
 * что токен прокси и прочие настройки устройства никогда не утекут.
 */
export function toRemoteProfile(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name ?? null,
    occupation: profile.occupation ?? null,
    level: profile.level ?? null,
    goals: profile.goals ?? [],
    interests: profile.interests ?? [],
    preferredStyle: profile.preferredStyle ?? null,
    updatedAt: profile.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

/* --- Бюджет: суммы в облаке тоже в копейках --- */

export function toRemoteAccount(row: MoneyAccount): Record<string, unknown> {
  return {
    title: row.title,
    kind: row.kind,
    openingBalance: row.openingBalance,
    includeInFree: row.includeInFree,
    archived: row.archived,
    order: row.order,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteAccount(id: string, data: Record<string, unknown>): MoneyAccount {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeAccount(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

export function toRemoteCategory(row: BudgetCategory): Record<string, unknown> {
  return {
    title: row.title,
    kind: row.kind,
    group: row.group,
    essential: row.essential,
    icon: row.icon,
    archived: row.archived,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteCategory(id: string, data: Record<string, unknown>): BudgetCategory {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeCategory(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/**
 * Операция в облако. `amount` — целые копейки; `normalizeTransaction`
 * на обратном пути числа не пересчитывает, поэтому суммы не «размножаются».
 */
export function toRemoteTransaction(row: BudgetTransaction): Record<string, unknown> {
  return {
    date: row.date,
    type: row.type,
    amount: row.amount,
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    categoryId: row.categoryId,
    payee: row.payee,
    notes: row.notes,
    obligationId: row.obligationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteTransaction(id: string, data: Record<string, unknown>): BudgetTransaction {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeTransaction(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}
export function toRemoteBudget(row: MonthBudget): Record<string, unknown> {
  return {
    expectedIncome: row.expectedIncome,
    savingsTarget: row.savingsTarget,
    notes: row.notes,
    lines: row.lines.map((line) => ({ categoryId: line.categoryId, limit: line.limit })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

/** `id` документа — сам месяц: бюджет января один на всех устройствах. */
export function fromRemoteBudget(id: string, data: Record<string, unknown>): MonthBudget {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeBudget(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

export function toRemoteObligation(row: BudgetObligation): Record<string, unknown> {
  return {
    title: row.title,
    kind: row.kind,
    amount: row.amount,
    frequency: row.frequency,
    dueDay: row.dueDay,
    dueDate: row.dueDate,
    active: row.active,
    remind: row.remind,
    categoryId: row.categoryId,
    accountId: row.accountId,
    assetId: row.assetId,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteObligation(id: string, data: Record<string, unknown>): BudgetObligation {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeObligation(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

export function toRemoteAsset(row: BudgetAsset): Record<string, unknown> {
  return {
    title: row.title,
    kind: row.kind,
    assetClass: row.assetClass,
    value: row.value,
    ratePercent: row.ratePercent,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteAsset(id: string, data: Record<string, unknown>): BudgetAsset {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeAsset(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

export function toRemoteSnapshot(row: BudgetSnapshot): Record<string, unknown> {
  return {
    date: row.date,
    assetsTotal: row.assetsTotal,
    liabilitiesTotal: row.liabilitiesTotal,
    netWorth: row.netWorth,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: CLOUD_SCHEMA_VERSION
  };
}

export function fromRemoteSnapshot(id: string, data: Record<string, unknown>): BudgetSnapshot {
  const updatedAt = pickUpdatedAt(data);
  return {
    id,
    ...normalizeSnapshot(data),
    createdAt: Number(data.createdAt ?? updatedAt),
    updatedAt,
    dirty: 0
  };
}

/** Бюджетный месяц из id документа: всё, что не «ГГГГ-ММ», считаем мусором. */
export function budgetMonthOf(id: string): string {
  return validMonth(id);
}

export function chunk<T>(items: T[], size: number = MAX_BATCH_WRITES): T[][] {

  const step = size > 0 ? size : MAX_BATCH_WRITES;
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += step) pages.push(items.slice(i, i + step));
  return pages;
}

/**
 * Firestore отклоняет `undefined` во вложенных полях, а `null` принимает.
 * Рекурсивно вычищаем undefined из объектов и превращаем в null в массивах.
 */
export function toPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toPlain(item))) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = toPlain(item);
    }
    return out as T;
  }
  return value;
}
