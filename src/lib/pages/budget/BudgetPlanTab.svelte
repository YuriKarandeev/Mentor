<script lang="ts">
  import MoneyInput from '../../components/MoneyInput.svelte';
  import type { BudgetCategory, BudgetTransaction, MonthBudget } from '../../db/db';
  import {
    CATEGORY_GROUPS,
    GROUP_SHARES,
    GROUP_TITLES,
    spentByCategory,
    unallocated,
    type CategoryGroup
  } from '../../utils/budget';
  import { formatMoney, moneyPercent } from '../../utils/money';

  let {
    budget,
    month,
    categories,
    transactions,
    onSave,
    onCopyFromPrevious,
    onOpenCategory,
    onNewCategory
  }: {
    budget: MonthBudget | null;
    month: string;
    categories: BudgetCategory[];
    transactions: BudgetTransaction[];
    onSave: (patch: {
      expectedIncome: number;
      savingsTarget: number;
      lines: { categoryId: string; limit: number }[];
      notes: string;
    }) => void;
    onCopyFromPrevious: () => void;
    onOpenCategory?: (category: BudgetCategory) => void;
    onNewCategory?: () => void;
  } = $props();

  let expectedIncome = $state(0);
  let savingsTarget = $state(0);
  let limits = $state<Record<string, number>>({});
  let notes = $state('');
  let hydrated = '';

  $effect(() => {
    const key = `${month}:${budget?.updatedAt ?? 0}`;
    if (key === hydrated) return;
    hydrated = key;
    expectedIncome = budget?.expectedIncome ?? 0;
    savingsTarget = budget?.savingsTarget ?? 0;
    notes = budget?.notes ?? '';
    const next: Record<string, number> = {};
    for (const line of budget?.lines ?? []) next[line.categoryId] = line.limit;
    limits = next;
  });

  const expenseCategories = $derived(categories.filter((category) => !category.archived && category.kind === 'expense'));
  const spentMap = $derived(spentByCategory(transactions, month));

  const groups = $derived.by(() => {
    const rows = CATEGORY_GROUPS.map((group: CategoryGroup) => ({
      group,
      title: GROUP_TITLES[group],
      target: GROUP_SHARES[group],
      items: expenseCategories.filter((category) => category.group === group)
    }));
    return rows.filter((row) => row.items.length > 0);
  });

  const limitTotal = $derived(
    Object.values(limits).reduce((sum, value) => sum + (Number(value) || 0), 0)
  );
  const left = $derived(
    unallocated({
      expectedIncome,
      savingsTarget,
      lines: Object.entries(limits).map(([categoryId, limit]) => ({ categoryId, limit }))
    })
  );

  function spentOf(categoryId: string): number {
    return spentMap[categoryId] ?? 0;
  }

  function save(): void {
    onSave({
      expectedIncome,
      savingsTarget,
      lines: Object.entries(limits)
        .filter(([, limit]) => limit > 0)
        .map(([categoryId, limit]) => ({ categoryId, limit })),
      notes: notes.trim()
    });
  }
</script>
<div class="tab">
  <div class="card col">
    <div class="row-between">
      <strong>Деньги месяца</strong>
      <div class="row" style="gap: 6px">
        {#if onNewCategory}
          <button class="btn btn-sm" onclick={onNewCategory}>+ Категория</button>
        {/if}
        <button class="btn btn-sm" onclick={onCopyFromPrevious}>С прошлого месяца</button>
      </div>
    </div>

    <div class="grid2">
      <MoneyInput
        id="plan-income"
        label="Ожидаемый доход"
        value={expectedIncome}
        ariaLabel="Ожидаемый доход месяца"
        onInput={(kopecks) => (expectedIncome = kopecks)}
      />
      <MoneyInput
        id="plan-savings"
        label="Цель по сбережениям"
        value={savingsTarget}
        ariaLabel="Цель по сбережениям"
        onInput={(kopecks) => (savingsTarget = kopecks)}
      />
    </div>

    <div class="row wrap summary">
      <span class="chip">Лимиты <strong>{formatMoney(limitTotal)}</strong></span>
      <span class="chip" class:good={left === 0} class:bad={left < 0}>
        Нераспределено <strong>{formatMoney(left, { sign: true })}</strong>
      </span>
    </div>

    <p class="tiny mute hint">
      Zero-based: доход минус лимиты и цель по сбережениям должен дать ноль. Если осталось
      положительное число — эти деньги пока без назначения; отрицательное — план обещает больше,
      чем придёт.
    </p>
  </div>

  {#if expenseCategories.length === 0}
    <div class="card empty">
      <p>Категорий расходов нет — они появятся вместе с разделом.</p>
    </div>
  {:else}
    {#each groups as group (group.group)}
      <div class="card">
        <div class="row-between">
          <strong>{group.title}</strong>
          <span class="tiny mute">ориентир {group.target} % расходов</span>
        </div>
        <ul class="rows">
          {#each group.items as category (category.id)}
            {@const limit = limits[category.id] ?? 0}
            {@const used = spentOf(category.id)}
            <li class="row-item">
              <div class="head">
                <span class="name">
                  {#if onOpenCategory}
                    <button class="name-btn" onclick={() => onOpenCategory(category)}>
                      {category.icon ? `${category.icon} ` : ''}{category.title}
                    </button>
                  {:else}
                    {category.icon ? `${category.icon} ` : ''}{category.title}
                  {/if}
                  {#if category.essential}<span class="chip tiny">обязательное</span>{/if}
                </span>
                <span class="tiny mute">
                  потрачено {formatMoney(used)}{limit > 0 ? ` · ${moneyPercent(used, limit)} %` : ''}
                </span>
              </div>
              <div class="limit">
                <MoneyInput
                  value={limit}
                  placeholder="0"
                  ariaLabel={`Лимит: ${category.title}`}
                  onInput={(kopecks) => (limits = { ...limits, [category.id]: kopecks })}
                />
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}

  <div class="card col">
    <div class="col">
      <label for="plan-notes">Заметка к плану</label>
      <textarea
        id="plan-notes"
        bind:value={notes}
        maxlength="400"
        rows="2"
        placeholder="Что важно помнить в этом месяце"
      ></textarea>
    </div>
    <div class="row-between">
      <button class="btn btn-primary" onclick={save}>Сохранить план</button>
      <span class="tiny mute">конвертов: {Object.values(limits).filter((value) => value > 0).length}</span>
    </div>
  </div>
</div>
<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .summary {
    gap: 8px;
  }

  .chip.good strong {
    color: var(--ok);
  }

  .chip.bad strong {
    color: var(--danger);
  }

  .hint {
    margin: 0;
  }

  .rows {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .row-item {
    display: grid;
    grid-template-columns: 1fr 140px;
    gap: 10px;
    align-items: center;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-soft);
  }

  .row-item:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .name {
    font-weight: 550;
    overflow-wrap: anywhere;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .name-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-weight: 550;
    color: inherit;
    text-align: left;
  }

  .name-btn:hover {
    color: var(--accent);
  }

  .limit {
    min-width: 0;
  }

  .empty {
    text-align: center;
  }

  .empty p {
    margin: 0;
  }

  @media (max-width: 560px) {
    .grid2 {
      grid-template-columns: 1fr;
    }

    .row-item {
      grid-template-columns: 1fr;
    }
  }
</style>


