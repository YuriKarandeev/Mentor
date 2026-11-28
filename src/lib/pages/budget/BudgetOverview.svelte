<script lang="ts">
  import BarList from '../../components/BarList.svelte';
  import Stat from '../../components/Stat.svelte';
  import type {
    BudgetCategory,
    BudgetObligation,
    BudgetTransaction,
    MoneyAccount,
    MonthBudget
  } from '../../db/db';
  import {
    accountBalances,
    budgetUsage,
    dueLabel,
    freeMoney,
    monthFlow,
    monthRange,
    unpaidBetween
  } from '../../utils/budget';
  import { formatMoney, moneyPercent } from '../../utils/money';
  import { addDaysIso, todayIso } from '../../utils/planner';

  let {
    accounts,
    categories,
    transactions,
    obligations,
    budget,
    month,
    onOpenAccount,
    onNewAccount,
    onNewTransaction,
    onOpenPlan
  }: {
    accounts: MoneyAccount[];
    categories: BudgetCategory[];
    transactions: BudgetTransaction[];
    obligations: BudgetObligation[];
    budget: MonthBudget | null;
    month: string;
    onOpenAccount: (account: MoneyAccount) => void;
    onNewAccount: () => void;
    onNewTransaction: () => void;
    onOpenPlan: () => void;
  } = $props();

  const today = todayIso();
  const categoryMap = $derived(new Map(categories.map((category) => [category.id, category])));
  const balances = $derived(accountBalances(accounts, transactions));
  const flow = $derived(monthFlow(transactions, month, accounts, categories));
  const money = $derived(
    freeMoney({ accounts, transactions, obligations, budget, categories, month })
  );
  const usage = $derived(budgetUsage(budget, transactions, month));

  const visibleAccounts = $derived(accounts.filter((account) => !account.archived));

  const envelopeBars = $derived(
    usage.lines
      .map((line) => {
        const category = categoryMap.get(line.categoryId);
        return {
          key: line.categoryId,
          label: `${category?.icon ?? '•'} ${category?.title ?? 'Без категории'}`,
          valueLabel: formatMoney(line.spent),
          percent: moneyPercent(line.spent, line.limit),
          note:
            line.over > 0
              ? `перерасход ${formatMoney(line.over)}`
              : `осталось ${formatMoney(line.left)} из ${formatMoney(line.limit)}`,
          tone: line.over > 0 ? ('bad' as const) : ('neutral' as const)
        };
      })
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 6)
  );

  /** Платежи на ближайшие 7 дней, включая просроченные. */
  const upcoming = $derived.by(() => {
    const range = monthRange(month);
    if (!range.start) return [];
    const horizon = addDaysIso(today, 7);
    return unpaidBetween(obligations, transactions, range.start, range.end)
      .filter((due) => due.date <= horizon)
      .slice(0, 5);
  });

  const tone = $derived(money.free < 0 ? 'bad' : money.free === 0 ? 'warn' : 'good');
</script>
<div class="tab">
  <div class="card free">
    <div class="row-between">
      <div>
        <span class="tiny mute">Свободные деньги</span>
        <div class="big" class:bad={money.free < 0}>{formatMoney(money.free, { sign: true })}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick={onNewTransaction}>+ Операция</button>
    </div>
    <div class="breakdown">
      <div class="tile">
        <span class="tiny mute">на счетах</span>
        <strong>{formatMoney(money.onHands)}</strong>
      </div>
      <div class="tile">
        <span class="tiny mute">в конвертах</span>
        <strong>−{formatMoney(money.reserved)}</strong>
      </div>
      <div class="tile">
        <span class="tiny mute">платежи до конца месяца</span>
        <strong>−{formatMoney(money.bills)}</strong>
      </div>
      <div class="tile">
        <span class="tiny mute">до цели по сбережениям</span>
        <strong>−{formatMoney(money.savings)}</strong>
      </div>
    </div>
    <p class="tiny mute hint">
      Свободные деньги — остаток на счетах за вычетом конвертов, ещё не оплаченных платежей и
      непокрытой цели по сбережениям. Отрицательное значение значит, что план дороже денег.
    </p>
  </div>

  <div class="tiles">
    <Stat label="Доходы месяца" value={formatMoney(flow.income)} hint="кассовый метод" />
    <Stat label="Расходы месяца" value={formatMoney(flow.expense)} />
    <Stat
      label="Осталось в конвертах"
      value={formatMoney(usage.left)}
      hint={usage.over > 0
        ? `перерасход ${formatMoney(usage.over)}`
        : `${usage.lines.length} конвертов`}
      tone={usage.over > 0 ? 'bad' : 'neutral'}
    />
    <Stat
      label="Свободно"
      value={formatMoney(money.free)}
      hint={money.free < 0 ? 'план больше денег' : 'без нарушения плана'}
      {tone}
    />
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Счета</strong>
      <button class="btn btn-sm" onclick={onNewAccount}>+ Счёт</button>
    </div>
    {#if visibleAccounts.length === 0}
      <p class="mute small empty-line">Добавьте хотя бы один счёт — с него начнётся учёт денег.</p>
    {:else}
      <ul class="list">
        {#each visibleAccounts as account (account.id)}
          <li>
            <button class="row-btn" onclick={() => onOpenAccount(account)}>
              <span class="grow">
                <span class="name">{account.title}</span>
                <span class="tiny mute">
                  {account.kind === 'cash'
                    ? 'наличные'
                    : account.kind === 'card'
                      ? 'карта'
                      : account.kind === 'bank'
                        ? 'счёт в банке'
                        : account.kind === 'savings'
                          ? 'накопления'
                          : 'инвестиции'}{account.includeInFree ? '' : ' · вне свободных'}
                </span>
              </span>
              <strong class="amount" class:neg={(balances[account.id] ?? 0) < 0}>
                {formatMoney(balances[account.id] ?? 0)}
              </strong>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if accounts.some((account) => account.archived)}
      <p class="tiny mute empty-line">
        Архивных счетов: {accounts.filter((account) => account.archived).length}
      </p>
    {/if}
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Конверты месяца</strong>
      <button class="btn btn-sm" onclick={onOpenPlan}>План</button>
    </div>
    <BarList
      items={envelopeBars}
      empty="Лимиты не заданы — откройте «План» и распределите деньги."
    />
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Ближайшие платежи</strong>
      <span class="mute tiny">{formatMoney(money.bills)} до конца месяца</span>
    </div>
    {#if upcoming.length === 0}
      <p class="mute small empty-line">На неделю вперёд платежей нет.</p>
    {:else}
      <ul class="list">
        {#each upcoming as due (due.obligation.id + due.date)}
          <li class="row-between small">
            <span>{due.obligation.title}</span>
            <span class="row" style="gap: 8px">
              <span class="tiny mute" class:over={due.date < today}>{dueLabel(due.date)}</span>
              <strong class="amount">{formatMoney(due.amount)}</strong>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .free {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .big {
    font-size: 1.7rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--ok);
  }

  .big.bad {
    color: var(--danger);
  }

  .breakdown {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-elev-2);
    border-radius: var(--radius-s);
    padding: 8px 10px;
  }

  .tile strong {
    font-variant-numeric: tabular-nums;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }

  .list {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .list li {
    border-bottom: 1px solid var(--border-soft);
    padding: 6px 0;
  }

  .list li:last-child {
    border-bottom: none;
  }

  .row-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: inherit;
  }

  .row-btn:hover .name {
    color: var(--accent);
  }

  .name {
    display: block;
    font-weight: 550;
  }

  .amount {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .amount.neg {
    color: var(--danger);
  }

  .hint {
    margin: 0;
  }

  .empty-line {
    margin: 8px 0 0;
  }

  .over {
    color: var(--danger);
  }
</style>


