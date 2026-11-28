/**
 * Денежные действия помощника: разбор ответа модели и чистое применение
 * к массивам счетов, категорий, платежей и активов. Модуль без Dexie
 * и Svelte — его проверяет `npm run test:budget`.
 *
 * Главное правило то же, что у календаря: запись без суммы, счёта или
 * с несуществующим id не создаётся никогда, а мусорные действия молча
 * отбрасываются. Модель присылает рубли, в базе деньги живут в копейках,
 * поэтому единственный пересчёт — `rubToKopecks`.
 */
import type {
  BudgetAsset,
  BudgetCategory,
  BudgetObligation,
  BudgetTransaction,
  MoneyAccount
} from '../db/db';
import {
  BUDGET_MAX_ACTIONS,
  BUDGET_MAX_NOTES,
  BUDGET_MAX_PAYEE,
  TRANSACTION_TYPE_TITLES
} from '../utils/budget.ts';
import { uid } from '../utils/ids.ts';
import { formatMoney, rubToKopecks } from '../utils/money.ts';
import { formatDateRu, text, todayIso, validDate } from '../utils/planner.ts';

export type MoneyTransactionType =
  | 'transaction.expense'
  | 'transaction.income'
  | 'transaction.transfer';

export interface CreateTransactionAction {
  type: MoneyTransactionType;
  /** Сумма в копейках: рубли модели уже пересчитаны. */
  amount: number;
  date: string;
  accountId: string;
  /** Только для перевода. */
  toAccountId: string;
  categoryId: string;
  payee: string;
  notes: string;
}

export interface PayObligationAction {
  type: 'obligation.pay';
  id: string;
  /** 0 — взять сумму из обязательства. */
  amount: number;
  date: string;
  /** Пусто — счёт обязательства. */
  accountId: string;
}

export type BudgetAction = CreateTransactionAction | PayObligationAction;

/**
 * Приведение действия к безопасному виду; null — действие отбрасывается.
 * Неизвестная дата не ошибка: деньги записывают «сейчас», поэтому пустая
 * или битая дата означает сегодня — это видно в карточке подтверждения.
 */
export function normalizeBudgetAction(raw: unknown, today = todayIso()): BudgetAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const type = text(source.type);
  const fallbackDate = validDate(today);

  if (type === 'obligation.pay') {
    const id = text(source.id, 64);
    if (!id) return null;
    return {
      type,
      id,
      amount: rubToKopecks(source.amount),
      date: validDate(source.date) || fallbackDate,
      accountId: text(source.accountId, 64)
    };
  }

  if (
    type !== 'transaction.expense' &&
    type !== 'transaction.income' &&
    type !== 'transaction.transfer'
  ) {
    return null;
  }

  const amount = rubToKopecks(source.amount);
  if (amount <= 0) return null;
  const accountId = text(source.accountId, 64);
  if (!accountId) return null;
  const isTransfer = type === 'transaction.transfer';
  const toAccountId = isTransfer ? text(source.toAccountId, 64) : '';
  if (isTransfer && (!toAccountId || toAccountId === accountId)) return null;

  return {
    type,
    amount,
    date: validDate(source.date) || fallbackDate,
    accountId,
    toAccountId,
    categoryId: isTransfer ? '' : text(source.categoryId, 64),
    payee: text(source.payee ?? source.title, BUDGET_MAX_PAYEE),
    notes: text(source.notes, BUDGET_MAX_NOTES)
  };
}

/** Что уже есть в приложении — к этому состоянию применяются действия. */
export interface BudgetActionState {
  accounts: MoneyAccount[];
  categories?: BudgetCategory[];
  obligations?: BudgetObligation[];
  assets?: BudgetAsset[];
}

export interface TransactionChangeSet {
  put: BudgetTransaction[];
  remove: string[];
  /** id, у которых нужно снять надгробие (отмена удаления). */
  restore?: string[];
}

export interface AssetChangeSet {
  put: BudgetAsset[];
  remove: string[];
  restore?: string[];
}

export interface AppliedBudgetAction {
  kind: 'expense' | 'income' | 'transfer' | 'pay';
  /** id созданной операции: по нему откат её удаляет. */
  id: string;
  title: string;
  amount: number;
  date: string;
}

export interface BudgetApplyResult {
  changes: { transactions: TransactionChangeSet; assets: AssetChangeSet };
  undo: { transactions: TransactionChangeSet; assets: AssetChangeSet };
  applied: AppliedBudgetAction[];
  /** Человекочитаемые причины пропуска — показываются под ответом. */
  skipped: string[];
}

function transactionRow(
  action: CreateTransactionAction,
  ts: number,
  id: string
): BudgetTransaction {
  const type =
    action.type === 'transaction.transfer'
      ? 'transfer'
      : action.type === 'transaction.income'
        ? 'income'
        : 'expense';
  return {
    id,
    date: action.date,
    type,
    amount: action.amount,
    accountId: action.accountId,
    toAccountId: action.toAccountId,
    categoryId: action.categoryId,
    payee: action.payee,
    notes: action.notes,
    obligationId: '',
    createdAt: ts,
    updatedAt: ts,
    dirty: 1
  };
}

/**
 * Применяет действия к копиям списков. Возвращает изменения для базы
 * и обратный набор: «Отменить» удаляет созданные операции и возвращает
 * прежние остатки долгов.
 *
 * Счета не меняются: остаток на счёте считается по операциям, а не хранится.
 */
export function applyBudgetActions(
  actions: unknown[],
  state: BudgetActionState,
  options: { now?: number; today?: string; newId?: () => string } = {}
): BudgetApplyResult {
  const ts = options.now ?? Date.now();
  const today = validDate(options.today) || todayIso(ts);
  const newId = options.newId ?? (() => uid('tx'));

  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const categories = new Map((state.categories ?? []).map((category) => [category.id, category]));
  const obligations = new Map((state.obligations ?? []).map((item) => [item.id, item]));
  const assetMap = new Map((state.assets ?? []).map((asset) => [asset.id, { ...asset }]));

  const created: BudgetTransaction[] = [];
  const assetOriginals = new Map<string, BudgetAsset>();
  const applied: AppliedBudgetAction[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const raw of Array.isArray(actions) ? actions : []) {
    if (used >= BUDGET_MAX_ACTIONS) {
      skipped.push(`Слишком много денежных действий: записаны первые ${BUDGET_MAX_ACTIONS}`);
      break;
    }

    const action = normalizeBudgetAction(raw, today);
    if (!action) {
      skipped.push('Непонятное денежное действие пропущено');
      continue;
    }

    if (action.type === 'obligation.pay') {
      const obligation = obligations.get(action.id);
      if (!obligation) {
        skipped.push(`Платёж не найден: ${action.id}`);
        continue;
      }
      if (obligation.active === false) {
        skipped.push(`Платёж «${obligation.title}» в архиве`);
        continue;
      }
      const accountId = action.accountId || obligation.accountId;
      const account = accountId ? accounts.get(accountId) : undefined;
      if (!account) {
        skipped.push(`Счёт для платежа «${obligation.title}» не найден`);
        continue;
      }
      if (account.archived) {
        skipped.push(`Счёт «${account.title}» в архиве`);
        continue;
      }
      const amount = action.amount || obligation.amount;
      if (!amount || amount <= 0) {
        skipped.push(`У платежа «${obligation.title}» нет суммы`);
        continue;
      }

      const row: BudgetTransaction = {
        id: newId(),
        date: action.date,
        type: 'expense',
        amount,
        accountId,
        toAccountId: '',
        categoryId: obligation.categoryId,
        payee: obligation.title,
        notes: '',
        obligationId: obligation.id,
        createdAt: ts,
        updatedAt: ts,
        dirty: 1
      };
      created.push(row);

      if (obligation.assetId) {
        const linked = assetMap.get(obligation.assetId);
        if (linked) {
          if (!assetOriginals.has(linked.id)) assetOriginals.set(linked.id, { ...linked });
          assetMap.set(linked.id, {
            ...linked,
            value: Math.max(0, linked.value - amount),
            updatedAt: ts,
            dirty: 1
          });
        }
      }

      used += 1;
      applied.push({ kind: 'pay', id: row.id, title: obligation.title, amount, date: row.date });
      continue;
    }

    const account = accounts.get(action.accountId);
    if (!account) {
      skipped.push(`Счёт не найден: ${action.accountId}`);
      continue;
    }
    if (account.archived) {
      skipped.push(`Счёт «${account.title}» в архиве`);
      continue;
    }

    if (action.type === 'transaction.transfer') {
      const target = accounts.get(action.toAccountId);
      if (!target) {
        skipped.push(`Счёт получателя не найден: ${action.toAccountId}`);
        continue;
      }
      if (target.archived) {
        skipped.push(`Счёт получателя «${target.title}» в архиве`);
        continue;
      }
    }

    if (action.categoryId && !categories.has(action.categoryId)) {
      skipped.push(`Категория не найдена: ${action.categoryId}`);
      continue;
    }

    const row = transactionRow(action, ts, newId());
    created.push(row);
    used += 1;

    const category = row.categoryId ? categories.get(row.categoryId) : undefined;
    const title =
      row.payee || category?.title || TRANSACTION_TYPE_TITLES[row.type] || '';
    applied.push({
      kind: row.type === 'transfer' ? 'transfer' : row.type === 'income' ? 'income' : 'expense',
      id: row.id,
      title,
      amount: row.amount,
      date: row.date
    });
  }

  const assetPut = [...assetMap.values()].filter((asset) => assetOriginals.has(asset.id));

  return {
    changes: {
      transactions: { put: created, remove: [] },
      assets: { put: assetPut, remove: [] }
    },
    undo: {
      transactions: { put: [], remove: created.map((row) => row.id) },
      assets: { put: [...assetOriginals.values()], remove: [] }
    },
    applied,
    skipped
  };
}

/** Подписи для карточек подтверждения: id пользователю ничего не говорит. */
export function describeBudgetActions(
  actions: unknown[],
  state: BudgetActionState,
  today = todayIso()
): string[] {
  const accounts = new Map(state.accounts.map((account) => [account.id, account.title]));
  const categories = new Map(
    (state.categories ?? []).map((category) => [category.id, category.title])
  );
  const obligations = new Map((state.obligations ?? []).map((item) => [item.id, item]));

  return actions.map((raw) => {
    const action = normalizeBudgetAction(raw, today);
    if (!action) return 'Непонятное денежное действие — пропущено';

    const account = accounts.get(action.accountId) ?? action.accountId;

    if (action.type === 'obligation.pay') {
      const obligation = obligations.get(action.id);
      const amount = action.amount || obligation?.amount || 0;
      return `Оплатить платёж «${obligation?.title ?? action.id}» — ${formatMoney(amount)}, ${formatDateRu(action.date)}`;
    }

    const date = formatDateRu(action.date);
    if (action.type === 'transaction.transfer') {
      const target = accounts.get(action.toAccountId) ?? action.toAccountId;
      return `Перевести ${formatMoney(action.amount)} с «${account}» на «${target}», ${date}`;
    }

    const kind = action.type === 'transaction.income' ? 'доход' : 'расход';
    const category = action.categoryId ? categories.get(action.categoryId) : '';
    const what = action.payee || category;
    const subject = what ? ` «${what}»` : '';
    return `Записать ${kind}${subject} ${formatMoney(action.amount)} на «${account}», ${date}`;
  });
}
