/**
 * Бюджет: счета, категории, операции, конверты месяца, обязательства и капитал.
 *
 * Модуль без Dexie, Svelte и сети — его проверяет `npm run test:budget`.
 * Принципы, на которых построены расчёты (подробнее в `docs/BUDGET.md`):
 *
 * - поток и баланс раздельно: операция меняет либо остаток счёта, либо ничего
 *   не меняет (перевод), но никогда не путает доход с расходом;
 * - кассовый метод: доход считается в день поступления, а не в день начисления;
 * - конверты zero-based: лимиты не больше ожидаемого дохода, «нераспределено» = 0;
 * - балансы, остатки конвертов и нетто-капитал не хранятся, а вычисляются.
 *
 * Суммы — всегда копейки (`money.ts`), даты — локальные «ГГГГ-ММ-ДД», месяц —
 * «ГГГГ-ММ».
 */
import { toKopecks } from './money.ts';
import { formatDateRu, pad2, text, todayIso, validDate } from './planner.ts';

export const ACCOUNT_KINDS = ['cash', 'card', 'bank', 'savings', 'invest'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_TITLES: Record<AccountKind, string> = {
  cash: 'Наличные',
  card: 'Карта',
  bank: 'Счёт в банке',
  savings: 'Накопления',
  invest: 'Инвестиции'
};

export const CATEGORY_KINDS = ['income', 'expense'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Группы нужны для правила 50/30/20 и для резерва. */
export const CATEGORY_GROUPS = ['needs', 'wants', 'savings'] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const GROUP_TITLES: Record<CategoryGroup, string> = {
  needs: 'Нужды',
  wants: 'Желания',
  savings: 'Сбережения'
};

/** Ориентир 50/30/20 — доля расходов месяца, а не жёсткое правило. */
export const GROUP_SHARES: Record<CategoryGroup, number> = { needs: 50, wants: 30, savings: 20 };

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_TITLES: Record<TransactionType, string> = {
  income: 'Доход',
  expense: 'Расход',
  transfer: 'Перевод'
};

export const OBLIGATION_KINDS = ['bill', 'subscription', 'loan', 'debt'] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const OBLIGATION_KIND_TITLES: Record<ObligationKind, string> = {
  bill: 'Платёж',
  subscription: 'Подписка',
  loan: 'Кредит',
  debt: 'Долг'
};

/**
 * Периодичность обязательств. Недельных намеренно нет: повтор по дням недели
 * уже живёт в «Делах», а у платежа недельный цикл только путает прогноз месяца.
 */
export const FREQUENCIES = ['monthly', 'yearly', 'once'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_TITLES: Record<Frequency, string> = {
  monthly: 'каждый месяц',
  yearly: 'раз в год',
  once: 'один раз'
};

export const ASSET_KINDS = ['asset', 'liability'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_TITLES: Record<AssetKind, string> = {
  asset: 'Актив',
  liability: 'Обязательство'
};

export const ASSET_CLASSES = ['estate', 'transport', 'tech', 'invest', 'other'] as const;
export const ASSET_CLASS_TITLES: Record<string, string> = {
  estate: 'Недвижимость',
  transport: 'Транспорт',
  tech: 'Техника',
  invest: 'Инвестиции',
  other: 'Прочее'
};

export const LIABILITY_CLASSES = ['mortgage', 'credit', 'card', 'loan', 'other'] as const;
export const LIABILITY_CLASS_TITLES: Record<string, string> = {
  mortgage: 'Ипотека',
  credit: 'Кредит',
  card: 'Карта рассрочки',
  debt: 'Долг',
  loan: 'Займ',
  other: 'Прочее'
};

export const BUDGET_MAX_TITLE = 80;
export const BUDGET_MAX_PAYEE = 80;
export const BUDGET_MAX_NOTES = 400;
/** Сколько строк конвертов храним в месяце: защита от случайной простыни. */
export const BUDGET_MAX_LINES = 60;
/** Сколько денежных действий модель может сделать за один ответ. */
export const BUDGET_MAX_ACTIONS = 4;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = text(value).toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = text(value).toLowerCase();
  if (['true', '1', 'yes', 'y', 'да', 'истина'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'нет', 'ложь'].includes(raw)) return false;
  return fallback;
}
export interface AccountData {
  title: string;
  kind: AccountKind;
  openingBalance: number;
  includeInFree: boolean;
  archived: boolean;
  order: number;
  notes: string;
}

/** «Карта» — безопасное имя по умолчанию: пустое название в UI недопустимо. */
export function normalizeAccount(raw: unknown): AccountData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = pick(src.kind, ACCOUNT_KINDS, 'card');
  const profit = kind === 'savings' || kind === 'invest';
  return {
    title: text(src.title, BUDGET_MAX_TITLE) || ACCOUNT_KIND_TITLES[kind],
    kind,
    openingBalance: toKopecks(src.openingBalance),
    includeInFree: bool(src.includeInFree, !profit),
    archived: bool(src.archived, false),
    order: intInRange(src.order, 0, 9999, 0),
    notes: text(src.notes, BUDGET_MAX_NOTES)
  };
}

export interface CategoryData {
  title: string;
  kind: CategoryKind;
  group: CategoryGroup;
  essential: boolean;
  icon: string;
  archived: boolean;
  order: number;
}

export function normalizeCategory(raw: unknown): CategoryData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = pick(src.kind, CATEGORY_KINDS, 'expense');
  const group = kind === 'income' ? 'needs' : pick(src.group, CATEGORY_GROUPS, 'wants');
  return {
    title: text(src.title, BUDGET_MAX_TITLE),
    kind,
    group,
    essential: kind === 'expense' ? bool(src.essential, false) : false,
    icon: text(src.icon, 4),
    archived: bool(src.archived, false),
    order: intInRange(src.order, 0, 9999, 0)
  };
}

export interface TransactionData {
  date: string;
  type: TransactionType;
  amount: number;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  payee: string;
  notes: string;
  obligationId: string;
}

/**
 * Правила операции: перевод всегда между разными счетами и без категории,
 * доход и расход категорию не требуют (категорию можно уточнить позже).
 */
export function normalizeTransaction(raw: unknown): TransactionData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = pick(src.type, TRANSACTION_TYPES, 'expense');
  const accountId = text(src.accountId, 64);
  const toCandidate = text(src.toAccountId, 64);
  const isTransfer = type === 'transfer';
  return {
    date: validDate(src.date),
    type,
    amount: toKopecks(src.amount),
    accountId,
    toAccountId: isTransfer && toCandidate !== accountId ? toCandidate : '',
    categoryId: isTransfer ? '' : text(src.categoryId, 64),
    payee: text(src.payee, BUDGET_MAX_PAYEE),
    notes: text(src.notes, BUDGET_MAX_NOTES),
    obligationId: isTransfer ? '' : text(src.obligationId, 64)
  };
}
export interface ObligationData {
  title: string;
  kind: ObligationKind;
  amount: number;
  frequency: Frequency;
  dueDay: number;
  dueDate: string;
  active: boolean;
  remind: boolean;
  categoryId: string;
  accountId: string;
  assetId: string;
  notes: string;
}

/**
 * `dueDay = 31` — законное значение: в коротком месяце платёж сдвигается на
 * последний день (`clampDueDay`). Для `yearly` и `once` нужна `dueDate`.
 */
export function normalizeObligation(raw: unknown): ObligationData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = pick(src.kind, OBLIGATION_KINDS, 'bill');
  const frequency = pick(src.frequency, FREQUENCIES, 'monthly');
  return {
    title: text(src.title, BUDGET_MAX_TITLE) || OBLIGATION_KIND_TITLES[kind],
    kind,
    amount: toKopecks(src.amount),
    frequency,
    dueDay: intInRange(src.dueDay, 1, 31, 1),
    dueDate: validDate(src.dueDate),
    active: bool(src.active, true),
    remind: bool(src.remind, true),
    categoryId: text(src.categoryId, 64),
    accountId: text(src.accountId, 64),
    assetId: text(src.assetId, 64),
    notes: text(src.notes, BUDGET_MAX_NOTES)
  };
}

export interface AssetData {
  title: string;
  kind: AssetKind;
  assetClass: string;
  value: number;
  ratePercent: number;
  notes: string;
}

/** У пассива `value` — остаток долга: уменьшается при оплате связанного платежа. */
export function normalizeAsset(raw: unknown): AssetData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = pick(src.kind, ASSET_KINDS, 'asset');
  const allowed = kind === 'asset' ? ASSET_CLASSES : LIABILITY_CLASSES;
  return {
    title: text(src.title, BUDGET_MAX_TITLE) || ASSET_KIND_TITLES[kind],
    kind,
    assetClass: pick(src.assetClass ?? src.class, allowed, 'other'),
    value: toKopecks(src.value),
    ratePercent: intInRange(src.ratePercent, 0, 1000, 0),
    notes: text(src.notes, BUDGET_MAX_NOTES)
  };
}

export interface BudgetLine {
  categoryId: string;
  limit: number;
}

export interface BudgetData {
  expectedIncome: number;
  savingsTarget: number;
  notes: string;
  lines: BudgetLine[];
}

/** Строки конвертов: без повторов категорий, нулевые лимиты выкидываем. */
export function normalizeBudgetLines(value: unknown): BudgetLine[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const lines: BudgetLine[] = [];
  for (const item of value) {
    const src = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const categoryId = text(src.categoryId, 64);
    const limit = toKopecks(src.limit);
    if (!categoryId || !limit || seen.has(categoryId)) continue;
    seen.add(categoryId);
    lines.push({ categoryId, limit });
    if (lines.length >= BUDGET_MAX_LINES) break;
  }
  return lines;
}

export function normalizeBudget(raw: unknown): BudgetData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    expectedIncome: toKopecks(src.expectedIncome),
    savingsTarget: toKopecks(src.savingsTarget),
    notes: text(src.notes, BUDGET_MAX_NOTES),
    lines: normalizeBudgetLines(src.lines)
  };
}

export interface SnapshotData {
  date: string;
  assetsTotal: number;
  liabilitiesTotal: number;
  netWorth: number;
  notes: string;
}

/** Нетто-капитал не принимаем извне: он всегда разность, иначе снимки врут. */
export function normalizeSnapshot(raw: unknown): SnapshotData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const assetsTotal = toKopecks(src.assetsTotal);
  const liabilitiesTotal = toKopecks(src.liabilitiesTotal);
  return {
    date: validDate(src.date),
    assetsTotal,
    liabilitiesTotal,
    netWorth: assetsTotal - liabilitiesTotal,
    notes: text(src.notes, BUDGET_MAX_NOTES)
  };
}
export interface SeedCategory {
  id: string;
  title: string;
  kind: CategoryKind;
  group: CategoryGroup;
  essential: boolean;
  icon: string;
  order: number;
}

/**
 * Стартовый справочник. Идентификаторы фиксированные: два устройства,
 * обновившиеся одновременно, засеют одни и те же записи — дублей не будет.
 */
export const SEED_CATEGORIES: SeedCategory[] = [
  { id: 'cat:food', title: 'Продукты', kind: 'expense', group: 'needs', essential: true, icon: '🛒', order: 10 },
  { id: 'cat:home', title: 'Жильё и ЖКХ', kind: 'expense', group: 'needs', essential: true, icon: '🏠', order: 20 },
  { id: 'cat:transport', title: 'Транспорт', kind: 'expense', group: 'needs', essential: true, icon: '🚌', order: 30 },
  { id: 'cat:health', title: 'Здоровье', kind: 'expense', group: 'needs', essential: true, icon: '💊', order: 40 },
  { id: 'cat:communication', title: 'Связь и подписки', kind: 'expense', group: 'needs', essential: true, icon: '📱', order: 50 },
  { id: 'cat:clothes', title: 'Одежда', kind: 'expense', group: 'wants', essential: false, icon: '👕', order: 60 },
  { id: 'cat:fun', title: 'Кафе и развлечения', kind: 'expense', group: 'wants', essential: false, icon: '☕', order: 70 },
  { id: 'cat:education', title: 'Обучение', kind: 'expense', group: 'wants', essential: false, icon: '🎓', order: 80 },
  { id: 'cat:gifts', title: 'Подарки', kind: 'expense', group: 'wants', essential: false, icon: '🎁', order: 90 },
  { id: 'cat:other', title: 'Прочее', kind: 'expense', group: 'wants', essential: false, icon: '📦', order: 100 },
  { id: 'cat:reserve', title: 'Сбережения', kind: 'expense', group: 'savings', essential: false, icon: '🏦', order: 110 },
  { id: 'inc:salary', title: 'Зарплата', kind: 'income', group: 'needs', essential: false, icon: '💼', order: 10 },
  { id: 'inc:freelance', title: 'Фриланс', kind: 'income', group: 'needs', essential: false, icon: '💻', order: 20 },
  { id: 'inc:gift', title: 'Подарки и помощь', kind: 'income', group: 'needs', essential: false, icon: '🤝', order: 30 },
  { id: 'inc:interest', title: 'Проценты и дивиденды', kind: 'income', group: 'needs', essential: false, icon: '📈', order: 40 },
  { id: 'inc:other', title: 'Прочие доходы', kind: 'income', group: 'needs', essential: false, icon: '➕', order: 50 }
];

const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь'
];

const MONTH_NAMES_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек'
];

/** Месяц даты: «ГГГГ-ММ»; невалидная дата даёт пустую строку. */
export function monthOf(iso: unknown): string {
  const date = validDate(iso);
  return date ? date.slice(0, 7) : '';
}

export function validMonth(value: unknown): string {
  const raw = text(value).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(raw)) return '';
  const month = Number(raw.slice(5, 7));
  return month >= 1 && month <= 12 ? raw : '';
}

export function currentMonth(now?: Date | number | string): string {
  return todayIso(now).slice(0, 7);
}

/** Сдвиг месяца с переходом через год: `shiftMonth('2026-01', -1)` → «2025-12». */
export function shiftMonth(key: string, delta: number): string {
  const month = validMonth(key);
  if (!month) return '';
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + Math.trunc(Number(delta) || 0);
  const d = new Date(year, index, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function monthDays(key: string): number {
  const month = validMonth(key);
  if (!month) return 0;
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
}

export function monthRange(key: string): { start: string; end: string } {
  const month = validMonth(key);
  if (!month) return { start: '', end: '' };
  return { start: `${month}-01`, end: `${month}-${pad2(monthDays(month))}` };
}

/** «ноябрь 2026». */
export function monthLabel(key: string): string {
  const month = validMonth(key);
  if (!month) return '';
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** «ноя 2026» — для тесных подписей на графиках. */
export function monthShortLabel(key: string): string {
  const month = validMonth(key);
  if (!month) return '';
  return `${MONTH_NAMES_SHORT[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** День платежа внутри месяца: 31-е в феврале становится 28-м или 29-м. */
export function clampDueDay(day: number, key: string): number {
  const days = monthDays(key);
  if (!days) return 0;
  const num = Math.trunc(Number(day) || 1);
  return Math.min(Math.max(1, num), days);
}

/** Последние N месяцев до текущего включительно: нужно для графиков и резерва. */
export function lastMonths(count: number, now?: Date | number | string): string[] {
  const total = Math.max(1, Math.trunc(Number(count) || 1));
  const end = currentMonth(now);
  const out: string[] = [];
  for (let i = total - 1; i >= 0; i -= 1) out.push(shiftMonth(end, -i));
  return out;
}
export interface AccountLike {
  id: string;
  title?: string;
  kind?: AccountKind;
  openingBalance?: number;
  includeInFree?: boolean;
  archived?: boolean;
}

export interface TransactionLike {
  id?: string;
  date: string;
  type: TransactionType;
  amount: number;
  accountId: string;
  toAccountId?: string;
  categoryId?: string;
  obligationId?: string;
  payee?: string;
  notes?: string;
}

export interface CategoryLike {
  id: string;
  title?: string;
  kind?: CategoryKind;
  group?: CategoryGroup;
  essential?: boolean;
  archived?: boolean;
  icon?: string;
}

export interface ObligationLike {
  id: string;
  title?: string;
  kind?: ObligationKind;
  amount?: number;
  frequency?: Frequency;
  dueDay?: number;
  dueDate?: string;
  active?: boolean;
  remind?: boolean;
  categoryId?: string;
  accountId?: string;
  assetId?: string;
  notes?: string;
}

export interface AssetLike {
  id: string;
  title?: string;
  kind?: AssetKind;
  assetClass?: string;
  value?: number;
  ratePercent?: number;
}

export interface BudgetLike {
  expectedIncome?: number;
  savingsTarget?: number;
  lines?: BudgetLine[];
}

/**
 * Изменение остатка счёта за выбранные операции.
 * Перевод — не доход и не расход: он уходит с одного счёта и приходит на другой.
 */
export function accountDelta(accountId: string, txs: TransactionLike[]): number {
  let delta = 0;
  for (const tx of txs) {
    const amount = Number(tx.amount) || 0;
    if (tx.type === 'income' && tx.accountId === accountId) delta += amount;
    else if (tx.type === 'expense' && tx.accountId === accountId) delta -= amount;
    else if (tx.type === 'transfer') {
      if (tx.accountId === accountId) delta -= amount;
      if (tx.toAccountId === accountId) delta += amount;
    }
  }
  return delta;
}

/** Остаток счёта: начальный остаток плюс всё, что по нему прошло. */
export function accountBalance(account: AccountLike, txs: TransactionLike[]): number {
  return (Number(account.openingBalance) || 0) + accountDelta(account.id, txs);
}

/** Остатки всех счетов: `Record<accountId, kopecks>`. */
export function accountBalances(
  accounts: AccountLike[],
  txs: TransactionLike[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const account of accounts) out[account.id] = accountBalance(account, txs);
  return out;
}

/**
 * «Деньги, которыми можно распоряжаться» — остатки на счетах, которые
 * пользователь отметил как свободные (`includeInFree`). Копилки и брокерский
 * счёт по умолчанию сюда не входят: они уже имеют назначение.
 */
export function liquidTotal(accounts: AccountLike[], txs: TransactionLike[]): number {
  return accounts
    .filter((account) => !account.archived && account.includeInFree !== false)
    .reduce((sum, account) => sum + accountBalance(account, txs), 0);
}

/** Остаток на «неприкосновенных» счетах — резерв и инвестиции. */
export function savingsTotal(accounts: AccountLike[], txs: TransactionLike[]): number {
  return accounts
    .filter(
      (account) =>
        !account.archived && (account.kind === 'savings' || account.kind === 'invest')
    )
    .reduce((sum, account) => sum + accountBalance(account, txs), 0);
}

export interface MonthFlow {
  income: number;
  expense: number;
  /** Переводы на копилки и расходы из группы «Сбережения». */
  saved: number;
  /** Доход минус расход: переводы сюда не входят. */
  net: number;
}

/**
 * Поток месяца по кассовому методу. Переводы не влияют на доход и расход, но
 * пополнение копилки считается сбережением.
 */
export function monthFlow(
  txs: TransactionLike[],
  month: string,
  accounts: AccountLike[] = [],
  categories: CategoryLike[] = []
): MonthFlow {
  const key = validMonth(month);
  const savingsAccounts = new Set(
    accounts.filter((a) => a.kind === 'savings' || a.kind === 'invest').map((a) => a.id)
  );
  const savingsCategories = new Set(
    categories.filter((c) => c.group === 'savings').map((c) => c.id)
  );
  let income = 0;
  let expense = 0;
  let saved = 0;
  if (!key) return { income, expense, saved, net: 0 };
  for (const tx of txs) {
    if (monthOf(tx.date) !== key) continue;
    const amount = Number(tx.amount) || 0;
    if (tx.type === 'income') income += amount;
    else if (tx.type === 'expense') {
      expense += amount;
      if (tx.categoryId && savingsCategories.has(tx.categoryId)) saved += amount;
    } else if (tx.type === 'transfer' && tx.toAccountId && savingsAccounts.has(tx.toAccountId)) {
      saved += amount;
    }
  }
  return { income, expense, saved, net: income - expense };
}

/** Расходы месяца по категориям (только `expense`). */
export function spentByCategory(txs: TransactionLike[], month: string): Record<string, number> {
  const key = validMonth(month);
  const out: Record<string, number> = {};
  if (!key) return out;
  for (const tx of txs) {
    if (tx.type !== 'expense' || monthOf(tx.date) !== key || !tx.categoryId) continue;
    out[tx.categoryId] = (out[tx.categoryId] || 0) + (Number(tx.amount) || 0);
  }
  return out;
}
export interface BudgetUsageLine {
  categoryId: string;
  limit: number;
  spent: number;
  /** Положительный остаток конверта; при перерасходе — 0. */
  left: number;
  /** Перерасход: больше нуля, если потратили больше лимита. */
  over: number;
  /** Сколько лимита израсходовано, проценты (может быть >100). */
  percent: number;
}

export interface BudgetUsage {
  lines: BudgetUsageLine[];
  limit: number;
  spent: number;
  left: number;
  over: number;
}

/** Исполнение конвертов месяца: лимит, потрачено, остаток и перерасход. */
export function budgetUsage(
  budget: BudgetLike | null | undefined,
  txs: TransactionLike[],
  month: string
): BudgetUsage {
  const spent = spentByCategory(txs, month);
  const lines: BudgetUsageLine[] = [];
  let limitTotal = 0;
  let spentTotal = 0;
  for (const line of budget?.lines || []) {
    const limit = Math.max(0, Number(line.limit) || 0);
    const used = spent[line.categoryId] || 0;
    const left = Math.max(0, limit - used);
    const over = Math.max(0, used - limit);
    limitTotal += limit;
    spentTotal += used;
    lines.push({
      categoryId: line.categoryId,
      limit,
      spent: used,
      left,
      over,
      percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0
    });
  }
  return {
    lines,
    limit: limitTotal,
    spent: spentTotal,
    left: Math.max(0, limitTotal - spentTotal),
    over: Math.max(0, spentTotal - limitTotal)
  };
}

/**
 * «Нераспределено»: ожидаемый доход минус лимиты конвертов и цель по
 * сбережениям. В zero-based бюджете это ноль; плюс — деньги без назначения,
 * минус — план обещает больше, чем придёт.
 */
export function unallocated(budget: BudgetLike | null | undefined): number {
  const income = Number(budget?.expectedIncome) || 0;
  const limits = (budget?.lines || []).reduce((sum, line) => sum + (Number(line.limit) || 0), 0);
  const target = Number(budget?.savingsTarget) || 0;
  return income - limits - target;
}

/**
 * Дата платежа обязательства в конкретном месяце. Пустая строка — в этом
 * месяце платить не нужно (разовый платёж в другом месяце, годовой в другом
 * месяце, неактивное обязательство).
 */
export function obligationDate(obligation: ObligationLike, month: string): string {
  const key = validMonth(month);
  if (!key || obligation.active === false) return '';
  const amount = Number(obligation.amount) || 0;
  if (amount <= 0) return '';
  const frequency = obligation.frequency || 'monthly';
  const due = validDate(obligation.dueDate);
  if (frequency === 'once') return due && monthOf(due) === key ? due : '';
  if (frequency === 'yearly') {
    if (!due) return '';
    return due.slice(5, 7) === key.slice(5, 7) && due.slice(0, 4) <= key.slice(0, 4) ? due : '';
  }
  const day = clampDueDay(Number(obligation.dueDay) || 1, key);
  return day ? `${key}-${pad2(day)}` : '';
}

/** Ближайшая дата платежа после `fromIso` включительно: для подписи «далее». */
export function nextObligationDate(obligation: ObligationLike, fromIso?: string): string {
  const today = validDate(fromIso) || todayIso();
  if (obligation.active === false || !(Number(obligation.amount) > 0)) return '';
  const frequency = obligation.frequency || 'monthly';
  if (frequency === 'once') {
    const due = validDate(obligation.dueDate);
    return due && due >= today ? due : '';
  }
  if (frequency === 'yearly') {
    const due = validDate(obligation.dueDate);
    if (!due) return '';
    const thisYear = `${today.slice(0, 4)}-${due.slice(5, 10)}`;
    if (thisYear >= today) return thisYear;
    return `${Number(today.slice(0, 4)) + 1}-${due.slice(5, 10)}`;
  }
  let month = monthOf(today);
  for (let i = 0; i < 13; i += 1) {
    const date = obligationDate(obligation, month);
    if (date && date >= today) return date;
    month = shiftMonth(month, 1);
  }
  return '';
}

export interface ObligationDue<T extends ObligationLike = ObligationLike> {
  obligation: T;
  date: string;
  amount: number;
  paid: boolean;
  paidDate: string;
}

/**
 * Обязательства месяца с признаком оплаты. Оплаченным считается расход с тем
 * же `obligationId` в этом месяце: история платежей не дублируется отдельной
 * таблицей.
 */
export function obligationsForMonth<T extends ObligationLike>(
  obligations: T[],
  month: string,
  txs: TransactionLike[] = []
): ObligationDue<T>[] {
  const key = validMonth(month);
  if (!key) return [];
  const paid = new Map<string, string>();
  for (const tx of txs) {
    if (tx.type !== 'expense' || !tx.obligationId || monthOf(tx.date) !== key) continue;
    const prev = paid.get(tx.obligationId);
    if (!prev || tx.date > prev) paid.set(tx.obligationId, tx.date);
  }
  const out: ObligationDue<T>[] = [];
  for (const obligation of obligations) {
    const date = obligationDate(obligation, key);
    if (!date) continue;
    const paidDate = paid.get(obligation.id) || '';
    out.push({
      obligation,
      date,
      amount: Number(obligation.amount) || 0,
      paid: Boolean(paidDate),
      paidDate
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || text(a.obligation.title).localeCompare(text(b.obligation.title), 'ru'));
}
/** Месячный эквивалент платежа: годовой делим на 12, разовый в прогноз не входит. */
export function monthlyEquivalent(obligation: ObligationLike): number {
  const amount = Number(obligation.amount) || 0;
  if (obligation.active === false || amount <= 0) return 0;
  const frequency = obligation.frequency || 'monthly';
  if (frequency === 'yearly') return Math.round(amount / 12);
  if (frequency === 'once') return 0;
  return amount;
}

/** Общая сумма обязательств в месяц — база для долговой нагрузки. */
export function obligationsMonthlyTotal(obligations: ObligationLike[]): number {
  return obligations.reduce((sum, obligation) => sum + monthlyEquivalent(obligation), 0);
}

/** Неоплаченные платежи в диапазоне дат: «сколько ещё нужно до конца месяца». */
export function unpaidBetween<T extends ObligationLike>(
  obligations: T[],
  txs: TransactionLike[],
  fromIso: string,
  toIso: string
): ObligationDue<T>[] {
  const start = validDate(fromIso);
  const end = validDate(toIso);
  if (!start || !end || start > end) return [];
  const lastMonth = monthOf(end);
  const out: ObligationDue<T>[] = [];
  let month = monthOf(start);
  for (let i = 0; i < 24 && month && month <= lastMonth; i += 1) {
    for (const due of obligationsForMonth(obligations, month, txs)) {
      if (due.paid || due.date < start || due.date > end) continue;
      out.push(due);
    }
    month = shiftMonth(month, 1);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface FreeMoneyInput {
  accounts: AccountLike[];
  transactions: TransactionLike[];
  obligations?: ObligationLike[];
  budget?: BudgetLike | null;
  categories?: CategoryLike[];
  month?: string;
  now?: Date | number | string;
}

export interface FreeMoney {
  /** Остаток на свободных счетах. */
  onHands: number;
  /** Занято конвертами: остатки лимитов, включая ещё не потраченное. */
  reserved: number;
  /** Неоплаченные обязательства до конца месяца. */
  bills: number;
  /** Сколько не хватает до цели по сбережениям. */
  savings: number;
  /** Свободные деньги: то, чем можно распоряжаться без нарушения плана. */
  free: number;
}

/**
 * Свободные деньги = на счетах − занято конвертами − обязательства до конца
 * месяца − непокрытая цель по сбережениям. Может быть отрицательной: это
 * честный сигнал, что план расходов больше денег.
 */
export function freeMoney(input: FreeMoneyInput): FreeMoney {
  const month = validMonth(input.month) || currentMonth(input.now);
  const today = todayIso(input.now);
  const onHands = liquidTotal(input.accounts, input.transactions);
  const usage = budgetUsage(input.budget, input.transactions, month);
  const reserved = usage.left;
  const bills = unpaidBetween(
    input.obligations || [],
    input.transactions,
    today,
    monthRange(month).end || today
  ).reduce((sum, due) => sum + due.amount, 0);
  const flow = monthFlow(input.transactions, month, input.accounts, input.categories || []);
  const target = Number(input.budget?.savingsTarget) || 0;
  const savings = Math.max(0, target - flow.saved);
  return {
    onHands,
    reserved,
    bills,
    savings,
    free: onHands - reserved - bills - savings
  };
}
/** Норма сбережений: доля сбережённого от дохода, проценты. */
export function savingsRate(flow: MonthFlow): number {
  if (!flow || flow.income <= 0) return 0;
  return Math.round((flow.saved / flow.income) * 1000) / 10;
}

/** Долговая нагрузка: доля обязательных платежей от дохода, проценты. */
export function debtLoad(minPayments: number, income: number): number {
  const base = Number(income) || 0;
  if (base <= 0) return 0;
  return Math.round(((Number(minPayments) || 0) / base) * 1000) / 10;
}

/** Резерв в месяцах: сколько месяцев обычных трат покрывают накопления. */
export function reserveMonths(savings: number, essentialPerMonth: number): number {
  const base = Number(essentialPerMonth) || 0;
  if (base <= 0) return 0;
  return Math.round(((Number(savings) || 0) / base) * 10) / 10;
}

/** Средние обязательные (essential) расходы в месяц за выбранные месяцы. */
export function essentialMonthly(
  txs: TransactionLike[],
  categories: CategoryLike[],
  months: string[]
): number {
  const essential = new Set(categories.filter((c) => c.essential).map((c) => c.id));
  if (essential.size === 0 || months.length === 0) return 0;
  const keys = new Set(months.map((m) => validMonth(m)).filter(Boolean));
  let sum = 0;
  for (const tx of txs) {
    if (tx.type !== 'expense' || !tx.categoryId || !essential.has(tx.categoryId)) continue;
    if (!keys.has(monthOf(tx.date))) continue;
    sum += Number(tx.amount) || 0;
  }
  return Math.round(sum / months.length);
}

export interface NetWorth {
  /** Деньги на всех счетах, включая копилки и инвестиции. */
  cash: number;
  /** Прочие активы из `assets`. */
  assets: number;
  /** Остатки долгов из `assets` с `kind: 'liability'`. */
  liabilities: number;
  net: number;
}

/** Нетто-капитал: деньги + прочие активы − долги. Счета в `assets` не дублируем. */
export function netWorth(
  accounts: AccountLike[],
  txs: TransactionLike[],
  assets: AssetLike[]
): NetWorth {
  const cash = accounts
    .filter((account) => !account.archived)
    .reduce((sum, account) => sum + accountBalance(account, txs), 0);
  let other = 0;
  let liabilities = 0;
  for (const asset of assets) {
    const value = Math.max(0, Number(asset.value) || 0);
    if (asset.kind === 'liability') liabilities += value;
    else other += value;
  }
  return { cash, assets: other, liabilities, net: cash + other - liabilities };
}

/** Сколько дней месяца уже прошло: для прогноза на конец месяца. */
function elapsedDays(month: string, now?: Date | number | string): number {
  const key = validMonth(month);
  const today = todayIso(now);
  const days = monthDays(key);
  if (!key || !days) return 0;
  const todayMonth = monthOf(today);
  if (key < todayMonth) return days;
  if (key > todayMonth) return 0;
  return Number(today.slice(8, 10));
}

export interface MonthSpend {
  /** Расходы месяца на текущий момент. */
  spent: number;
  /** Средний расход в день по прошедшим дням. */
  perDay: number;
  /** Прошедших дней месяца (для будущего месяца — 0). */
  days: number;
  /** Прогноз расходов к последнему дню месяца. */
  forecast: number;
}

/** Средний расход в день и прогноз до конца месяца. */
export function monthSpend(
  txs: TransactionLike[],
  month: string,
  now?: Date | number | string
): MonthSpend {
  const key = validMonth(month);
  const days = monthDays(key);
  if (!key || !days) return { spent: 0, perDay: 0, days: 0, forecast: 0 };
  const spent = txs
    .filter((tx) => tx.type === 'expense' && monthOf(tx.date) === key)
    .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  const elapsed = elapsedDays(key, now);
  if (elapsed <= 0) return { spent: 0, perDay: 0, days: 0, forecast: 0 };
  const perDay = Math.round(spent / elapsed);
  return { spent, perDay, days: elapsed, forecast: perDay * days };
}
export interface GroupShare {
  group: CategoryGroup;
  title: string;
  amount: number;
  percent: number;
  target: number;
}

export interface GroupShareResult {
  total: number;
  groups: GroupShare[];
}

/**
 * Расходы месяца по группам 50/30/20. Категория без группы считается
 * «желанием» — так безопаснее: план не выглядит выполненным за счёт неизвестного.
 */
export function groupShares(
  txs: TransactionLike[],
  month: string,
  categories: CategoryLike[]
): GroupShareResult {
  const map = new Map(categories.map((category) => [category.id, category]));
  const sums: Record<CategoryGroup, number> = { needs: 0, wants: 0, savings: 0 };
  let total = 0;
  for (const tx of txs) {
    if (tx.type !== 'expense' || monthOf(tx.date) !== validMonth(month)) continue;
    const amount = Number(tx.amount) || 0;
    const group = (tx.categoryId && map.get(tx.categoryId)?.group) || 'wants';
    sums[group] += amount;
    total += amount;
  }
  return {
    total,
    groups: CATEGORY_GROUPS.map((group) => ({
      group,
      title: GROUP_TITLES[group],
      amount: sums[group],
      percent: total > 0 ? Math.round((sums[group] / total) * 1000) / 10 : 0,
      target: GROUP_SHARES[group]
    }))
  };
}

export interface CategorySpend {
  categoryId: string;
  title: string;
  icon: string;
  amount: number;
  share: number;
}

/** Топ категорий расходов месяца: для графика и списка «куда уходят деньги». */
export function topCategories(
  txs: TransactionLike[],
  month: string,
  categories: CategoryLike[],
  limit = 5
): CategorySpend[] {
  const map = new Map(categories.map((category) => [category.id, category]));
  const spent = spentByCategory(txs, month);
  const total = Object.values(spent).reduce((sum, value) => sum + value, 0);
  return Object.entries(spent)
    .map(([categoryId, amount]) => {
      const category = map.get(categoryId);
      return {
        categoryId,
        title: category?.title || 'Без категории',
        icon: category?.icon || '•',
        amount,
        share: total > 0 ? Math.round((amount / total) * 1000) / 10 : 0
      };
    })
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, Math.max(1, Math.trunc(Number(limit) || 5)));
}

/** Изменение к прошлому месяцу в процентах; null — сравнивать не с чем. */
export function categoryDelta(current: number, previous: number): number | null {
  const base = Number(previous) || 0;
  if (base <= 0) return null;
  return Math.round((((Number(current) || 0) - base) / base) * 1000) / 10;
}

/** Сортировка журнала: свежие сверху, внутри дня — крупные первыми. */
export function sortTransactions(a: TransactionLike, b: TransactionLike): number {
  const byDate = (b.date || '').localeCompare(a.date || '');
  if (byDate !== 0) return byDate;
  return (Number(b.amount) || 0) - (Number(a.amount) || 0);
}

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

function dayDiff(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T12:00:00`).getTime();
  const to = new Date(`${toIso}T12:00:00`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Подпись срока платежа: «сегодня», «завтра», «просрочено на 3 дня»,
 * «через 5 дней», иначе «12 дек».
 */
export function dueLabel(iso: string, now?: Date | number | string): string {
  const date = validDate(iso);
  if (!date) return '';
  const today = todayIso(now);
  const diff = dayDiff(today, date);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  if (diff < 0) {
    const days = Math.abs(diff);
    return `просрочено на ${days} ${pluralDays(days)}`;
  }
  if (diff <= 7) return `через ${diff} ${pluralDays(diff)}`;
  const day = Number(date.slice(8, 10));
  const monthIndex = Number(date.slice(5, 7)) - 1;
  return `${day} ${MONTHS_GENITIVE[monthIndex]}`;
}

/** Русское склонение слова «день» — только для подписей, не для расчётов. */
export function pluralDays(count: number): string {
  const abs = Math.abs(Math.trunc(Number(count) || 0));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

/** Подпись расписания обязательства: «каждый месяц, 15-го». */
export function obligationScheduleLabel(obligation: ObligationLike): string {
  const frequency = obligation.frequency || 'monthly';
  const due = validDate(obligation.dueDate);
  if (frequency === 'once') return due ? `один раз, ${formatDateRu(due)}` : 'один раз, дата не задана';
  if (frequency === 'yearly') {
    if (!due) return 'раз в год, дата не задана';
    const day = Number(due.slice(8, 10));
    const monthIndex = Number(due.slice(5, 7)) - 1;
    return `раз в год, ${day} ${MONTHS_GENITIVE[monthIndex]}`;
  }
  return `каждый месяц, ${Math.trunc(Number(obligation.dueDay) || 1)}-го`;
}








