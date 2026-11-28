<script lang="ts">
  import Stat from '../../components/Stat.svelte';
  import type {
    BudgetCategory,
    BudgetObligation,
    BudgetTransaction,
    MoneyAccount
  } from '../../db/db';
  import {
    dueLabel,
    obligationsForMonth,
    obligationsMonthlyTotal,
    obligationScheduleLabel,
    nextObligationDate
  } from '../../utils/budget';
  import { formatMoney } from '../../utils/money';

  let {
    obligations,
    categories,
    accounts,
    transactions,
    month,
    onOpen,
    onNew,
    onPay
  }: {
    obligations: BudgetObligation[];
    categories: BudgetCategory[];
    accounts: MoneyAccount[];
    transactions: BudgetTransaction[];
    month: string;
    onOpen: (obligation: BudgetObligation) => void;
    onNew: () => void;
    onPay: (obligation: BudgetObligation) => void;
  } = $props();

  const categoryMap = $derived(new Map(categories.map((category) => [category.id, category])));
  const accountMap = $derived(new Map(accounts.map((account) => [account.id, account])));
  const due = $derived(obligationsForMonth(obligations, month, transactions));
  const paidTotal = $derived(due.filter((item) => item.paid).reduce((sum, item) => sum + item.amount, 0));
  const dueTotal = $derived(due.reduce((sum, item) => sum + item.amount, 0));
  const monthlyLoad = $derived(obligationsMonthlyTotal(obligations));

  function categoryLabel(id: string): string {
    const category = id ? categoryMap.get(id) : undefined;
    return category ? `${category.icon ? `${category.icon} ` : ''}${category.title}` : '';
  }
</script>

<div class="tab">
  <div class="row-between">
    <div class="tiles">
      <Stat label="Платежи месяца" value={formatMoney(dueTotal)} hint={`${due.length} платежей`} />
      <Stat label="Оплачено" value={formatMoney(paidTotal)} tone="good" />
      <Stat
        label="Осталось"
        value={formatMoney(Math.max(0, dueTotal - paidTotal))}
        tone={dueTotal - paidTotal > 0 ? 'warn' : 'neutral'}
      />
      <Stat label="В месяц" value={formatMoney(monthlyLoad)} hint="с учётом годовых" />
    </div>
    <button class="btn btn-primary btn-sm" onclick={onNew}>+ Платёж</button>
  </div>

  <div class="card">
    <strong>Платежи месяца</strong>
    {#if due.length === 0}
      <p class="mute small empty-line">
        В этом месяце платежей нет. Добавьте аренду, подписки и кредиты — они попадут в свободные
        деньги и в напоминания.
      </p>
    {:else}
      <ul class="list">
        {#each due as item (item.obligation.id + item.date)}
          <li class="item">
            <button class="main" onclick={() => onOpen(item.obligation)}>
              <span class="title">
                {item.obligation.title}
                {#if item.obligation.frequency === 'once'}<span class="chip tiny">разовый</span>{/if}
              </span>
              <span class="meta">
                {dueLabel(item.date)}
                {#if item.obligation.accountId && accountMap.get(item.obligation.accountId)}
                  · {accountMap.get(item.obligation.accountId)?.title}
                {/if}
                {#if categoryLabel(item.obligation.categoryId)}
                  · {categoryLabel(item.obligation.categoryId)}
                {/if}
              </span>
            </button>
            <div class="right">
              <strong class="amount">{formatMoney(item.amount)}</strong>
              {#if item.paid}
                <span class="chip done">оплачено</span>
              {:else}
                <button class="btn btn-sm" onclick={() => onPay(item.obligation)}>Оплатить</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Все обязательства</strong>
      <span class="mute tiny">{obligations.filter((item) => item.active).length} активных</span>
    </div>
    {#if obligations.length === 0}
      <p class="mute small empty-line">Пока пусто.</p>
    {:else}
      <ul class="list">
        {#each obligations as obligation (obligation.id)}
          <li class="item">
            <button class="main" onclick={() => onOpen(obligation)}>
              <span class="title" class:off={!obligation.active}>
                {obligation.title}
                {#if !obligation.active}<span class="chip tiny">выключен</span>{/if}
              </span>
              <span class="meta">
                {obligationScheduleLabel(obligation)}
                {#if obligation.active}
                  · далее {dueLabel(nextObligationDate(obligation))}
                {/if}
              </span>
            </button>
            <strong class="amount">{formatMoney(obligation.amount)}</strong>
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

  .row-between {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .list {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-soft);
  }

  .item:last-child {
    border-bottom: none;
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: inherit;
  }

  .main:hover .title {
    color: var(--accent);
  }

  .title {
    font-weight: 550;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .title.off {
    color: var(--text-mute);
  }

  .meta {
    font-size: 0.75rem;
    color: var(--text-mute);
    overflow-wrap: anywhere;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .amount {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chip.done {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 35%, transparent);
  }

  .empty-line {
    margin: 8px 0 0;
  }

  @media (max-width: 560px) {
    .item {
      flex-wrap: wrap;
    }

    .right {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>

