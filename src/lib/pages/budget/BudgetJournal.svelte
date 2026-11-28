<script lang="ts">
  import type {
    BudgetCategory,
    BudgetTransaction,
    MoneyAccount
  } from '../../db/db';
  import { TRANSACTION_TYPE_TITLES, monthFlow } from '../../utils/budget';
  import { formatMoney } from '../../utils/money';
  import { formatDateHuman } from '../../utils/planner';

  let {
    transactions,
    accounts,
    categories,
    month,
    onOpen,
    onNew
  }: {
    transactions: BudgetTransaction[];
    accounts: MoneyAccount[];
    categories: BudgetCategory[];
    month: string;
    onOpen: (transaction: BudgetTransaction) => void;
    onNew: () => void;
  } = $props();

  type Filter = 'all' | 'income' | 'expense' | 'transfer';
  let filter = $state<Filter>('all');

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'Все' },
    { key: 'expense', label: 'Расходы' },
    { key: 'income', label: 'Доходы' },
    { key: 'transfer', label: 'Переводы' }
  ];

  const accountMap = $derived(new Map(accounts.map((account) => [account.id, account])));
  const categoryMap = $derived(new Map(categories.map((category) => [category.id, category])));
  const flow = $derived(monthFlow(transactions, month, accounts, categories));

  const list = $derived(
    filter === 'all' ? transactions : transactions.filter((tx) => tx.type === filter)
  );

  const groups = $derived.by(() => {
    const out: { date: string; items: BudgetTransaction[] }[] = [];
    for (const tx of list) {
      const last = out[out.length - 1];
      if (last && last.date === tx.date) last.items.push(tx);
      else out.push({ date: tx.date, items: [tx] });
    }
    return out;
  });

  function title(tx: BudgetTransaction): string {
    if (tx.type === 'transfer') {
      const from = accountMap.get(tx.accountId)?.title ?? 'счёт';
      const to = accountMap.get(tx.toAccountId)?.title ?? 'счёт';
      return `${from} → ${to}`;
    }
    if (tx.payee) return tx.payee;
    const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
    return category?.title ?? TRANSACTION_TYPE_TITLES[tx.type];
  }

  function subtitle(tx: BudgetTransaction): string {
    const parts: string[] = [];
    if (tx.type !== 'transfer') {
      const category = tx.categoryId ? categoryMap.get(tx.categoryId) : undefined;
      if (category && tx.payee) parts.push(`${category.icon ? `${category.icon} ` : ''}${category.title}`);
      const account = accountMap.get(tx.accountId);
      if (account) parts.push(account.title);
    }
    if (tx.notes) parts.push(tx.notes);
    return parts.join(' · ');
  }

  function signOf(tx: BudgetTransaction): string {
    if (tx.type === 'income') return '+';
    if (tx.type === 'expense') return '−';
    return '';
  }
</script>
<div class="tab">
  <div class="card row-between">
    <div class="row wrap summary">
      <span class="chip">Доходы <strong>{formatMoney(flow.income)}</strong></span>
      <span class="chip">Расходы <strong>{formatMoney(flow.expense)}</strong></span>
      <span class="chip chip-accent">Итог <strong>{formatMoney(flow.net, { sign: true })}</strong></span>
    </div>
    <button class="btn btn-primary btn-sm" onclick={onNew}>+ Операция</button>
  </div>

  <div class="filters">
    {#each FILTERS as item (item.key)}
      <button
        class="chip filter"
        class:on={filter === item.key}
        aria-pressed={filter === item.key}
        onclick={() => (filter = item.key)}
      >
        {item.label}
      </button>
    {/each}
  </div>

  {#if groups.length === 0}
    <div class="card empty">
      <p>За этот месяц операций нет.</p>
      <button class="btn btn-primary btn-sm" onclick={onNew}>Добавить первую</button>
    </div>
  {:else}
    {#each groups as group (group.date)}
      <div class="card day">
        <div class="row-between">
          <strong class="small">{formatDateHuman(group.date)}</strong>
          <span class="tiny mute">{group.date}</span>
        </div>
        <ul class="list">
          {#each group.items as tx (tx.id)}
            <li>
              <button class="row-btn" onclick={() => onOpen(tx)}>
                <span
                  class="ico"
                  class:income={tx.type === 'income'}
                  class:transfer={tx.type === 'transfer'}
                >
                  {tx.type === 'income' ? '↑' : tx.type === 'expense' ? '↓' : '⇄'}
                </span>
                <span class="grow">
                  <span class="name">{title(tx)}</span>
                  {#if subtitle(tx)}<span class="meta">{subtitle(tx)}</span>{/if}
                </span>
                <strong
                  class="amount"
                  class:income={tx.type === 'income'}
                  class:transfer={tx.type === 'transfer'}
                >
                  {signOf(tx)}{formatMoney(tx.amount)}
                </strong>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>
<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .summary {
    gap: 6px;
  }

  .filters {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .filter {
    cursor: pointer;
    background: var(--bg-elev);
  }

  .filter.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
    font-weight: 600;
  }

  .day {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .list li {
    border-bottom: 1px solid var(--border-soft);
  }

  .list li:last-child {
    border-bottom: none;
  }

  .row-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 0;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
  }

  .row-btn:hover .name {
    color: var(--accent);
  }

  .ico {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
    font-size: 0.9rem;
  }

  .ico.income {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
  }

  .ico.transfer {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .name {
    display: block;
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .meta {
    display: block;
    font-size: 0.75rem;
    color: var(--text-mute);
    overflow-wrap: anywhere;
  }

  .amount {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--danger);
  }

  .amount.income {
    color: var(--ok);
  }

  .amount.transfer {
    color: var(--text-dim);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .empty p {
    margin: 0;
  }
</style>


