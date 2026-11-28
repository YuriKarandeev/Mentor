<script lang="ts">
  import AccountEditor, { type AccountFormValue } from '../components/AccountEditor.svelte';
  import AssetEditor, { type AssetFormValue } from '../components/AssetEditor.svelte';
  import CategoryEditor, { type CategoryFormValue } from '../components/CategoryEditor.svelte';
  import ObligationEditor, { type ObligationFormValue } from '../components/ObligationEditor.svelte';
  import TransactionEditor, {
    type TransactionFormValue
  } from '../components/TransactionEditor.svelte';
  import {
    addAccount,
    addAsset,
    addCategory,
    addObligation,
    addTransaction,
    allAccounts,
    allAssets,
    allCategories,
    allObligations,
    allSnapshots,
    allTransactions,
    archiveAccount,
    copyMonthBudget,
    ensureBudgetDefaults,
    getMonthBudget,
    payObligation,
    removeAccount,
    removeAsset,
    removeCategory,
    removeObligation,
    removeTransaction,
    saveMonthBudget,
    takeSnapshot,
    updateAccount,
    updateAsset,
    updateCategory,
    updateObligation,
    updateTransaction,
    type BudgetAsset,
    type BudgetCategory,
    type BudgetObligation,
    type BudgetSnapshot,
    type BudgetTransaction,
    type MoneyAccount,
    type MonthBudget
  } from '../db/db';
  import { BUDGET_TABS, router, type BudgetTab } from '../router.svelte';
  import { sync } from '../sync/state.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { currentMonth, monthLabel, shiftMonth } from '../utils/budget';
  import BudgetAnalytics from './budget/BudgetAnalytics.svelte';
  import BudgetAssets from './budget/BudgetAssets.svelte';
  import BudgetJournal from './budget/BudgetJournal.svelte';
  import BudgetObligations from './budget/BudgetObligations.svelte';
  import BudgetOverview from './budget/BudgetOverview.svelte';
  import BudgetPlanTab from './budget/BudgetPlanTab.svelte';

  let { tab = 'overview' }: { tab?: BudgetTab } = $props();

  const TAB_TITLES: Record<BudgetTab, string> = {
    overview: 'Обзор',
    journal: 'Журнал',
    plan: 'План',
    obligations: 'Платежи',
    assets: 'Капитал',
    analytics: 'Аналитика'
  };

  let month = $state(currentMonth());
  let loading = $state(true);

  let accounts = $state<MoneyAccount[]>([]);
  let categories = $state<BudgetCategory[]>([]);
  let transactions = $state<BudgetTransaction[]>([]);
  let budget = $state<MonthBudget | null>(null);
  let obligations = $state<BudgetObligation[]>([]);
  let assets = $state<BudgetAsset[]>([]);
  let snapshots = $state<BudgetSnapshot[]>([]);

  let txEditor = $state<{ open: boolean; row: BudgetTransaction | null }>({ open: false, row: null });
  let accountEditor = $state<{ open: boolean; row: MoneyAccount | null }>({ open: false, row: null });
  let categoryEditor = $state<{ open: boolean; row: BudgetCategory | null }>({
    open: false,
    row: null
  });
  let obligationEditor = $state<{ open: boolean; row: BudgetObligation | null }>({
    open: false,
    row: null
  });
  let assetEditor = $state<{ open: boolean; row: BudgetAsset | null }>({ open: false, row: null });

  /** Все операции уже в памяти, поэтому месяц фильтруем локально, без запроса. */
  const monthRows = $derived(transactions.filter((tx) => tx.date.slice(0, 7) === month));

  async function load(): Promise<void> {
    await ensureBudgetDefaults();
    const [acc, cat, txs, plan, obl, ast, snaps] = await Promise.all([
      allAccounts(),
      allCategories(),
      allTransactions(),
      getMonthBudget(month),
      allObligations(),
      allAssets(),
      allSnapshots()
    ]);
    accounts = acc;
    categories = cat;
    transactions = txs;
    budget = plan ?? null;
    obligations = obl;
    assets = ast;
    snapshots = snaps;
    loading = false;
  }

  $effect(() => {
    sync.revision;
    month;
    void load();
  });

  function goTab(next: BudgetTab): void {
    router.go(`/budget/${next}`);
  }

  function fail(e: unknown): void {
    toasts.error(e instanceof Error ? e.message : String(e));
  }

  /* --- операции --- */

  async function saveTransaction(value: TransactionFormValue): Promise<void> {
    const editing = txEditor.row;
    try {
      if (editing) await updateTransaction(editing.id, value);
      else await addTransaction(value);
      txEditor = { open: false, row: null };
      await load();
      toasts.success(editing ? 'Операция обновлена' : 'Операция добавлена');
    } catch (e) {
      fail(e);
    }
  }

  async function deleteTransaction(): Promise<void> {
    if (!txEditor.row) return;
    if (!confirm('Удалить операцию? Остатки счетов пересчитаются.')) return;
    try {
      await removeTransaction(txEditor.row.id);
      txEditor = { open: false, row: null };
      await load();
      toasts.success('Операция удалена');
    } catch (e) {
      fail(e);
    }
  }

  /* --- счета --- */

  async function saveAccount(value: AccountFormValue): Promise<void> {
    const editing = accountEditor.row;
    try {
      if (editing) await updateAccount(editing.id, value);
      else await addAccount(value);
      accountEditor = { open: false, row: null };
      await load();
      toasts.success(editing ? 'Счёт обновлён' : 'Счёт добавлен');
    } catch (e) {
      fail(e);
    }
  }

  /** Счёт с операциями не удаляется — предлагаем архив, чтобы история осталась. */
  async function deleteAccount(): Promise<void> {
    const row = accountEditor.row;
    if (!row) return;
    if (!confirm(`Удалить счёт «${row.title}»? Если по нему есть операции, он уйдёт в архив.`)) return;
    try {
      await removeAccount(row.id);
      accountEditor = { open: false, row: null };
      await load();
      toasts.success('Счёт удалён');
    } catch {
      try {
        await archiveAccount(row.id, true);
        accountEditor = { open: false, row: null };
        await load();
        toasts.success('Счёт в архиве — история операций сохранена');
      } catch (e) {
        fail(e);
      }
    }
  }

  /* --- категории --- */

  async function saveCategory(value: CategoryFormValue): Promise<void> {
    const editing = categoryEditor.row;
    try {
      if (editing) await updateCategory(editing.id, value);
      else await addCategory(value);
      categoryEditor = { open: false, row: null };
      await load();
      toasts.success(editing ? 'Категория обновлена' : 'Категория добавлена');
    } catch (e) {
      fail(e);
    }
  }

  async function deleteCategory(): Promise<void> {
    const row = categoryEditor.row;
    if (!row) return;
    if (!confirm(`Удалить категорию «${row.title}»?`)) return;
    try {
      await removeCategory(row.id);
      categoryEditor = { open: false, row: null };
      await load();
      toasts.success('Категория удалена');
    } catch (e) {
      fail(e);
    }
  }

  /* --- платежи --- */

  async function saveObligation(value: ObligationFormValue): Promise<void> {
    const editing = obligationEditor.row;
    try {
      if (editing) await updateObligation(editing.id, value);
      else await addObligation(value);
      obligationEditor = { open: false, row: null };
      await load();
      toasts.success(editing ? 'Платёж обновлён' : 'Платёж добавлен');
    } catch (e) {
      fail(e);
    }
  }

  async function deleteObligation(): Promise<void> {
    const row = obligationEditor.row;
    if (!row) return;
    if (!confirm(`Удалить платёж «${row.title}»? Операции оплаты останутся в журнале.`)) return;
    try {
      await removeObligation(row.id);
      obligationEditor = { open: false, row: null };
      await load();
      toasts.success('Платёж удалён');
    } catch (e) {
      fail(e);
    }
  }

  async function pay(obligation: BudgetObligation): Promise<void> {
    try {
      const result = await payObligation(obligation.id);
      await load();
      if (!result) {
        toasts.error('Платёж не найден — обновите раздел');
        return;
      }
      toasts.success(`«${obligation.title}» оплачен`);
    } catch (e) {
      fail(e);
    }
  }

  /* --- активы и снимки --- */

  async function saveAsset(value: AssetFormValue): Promise<void> {
    const editing = assetEditor.row;
    try {
      if (editing) await updateAsset(editing.id, value);
      else await addAsset(value);
      assetEditor = { open: false, row: null };
      await load();
      toasts.success(editing ? 'Запись обновлена' : 'Актив добавлен');
    } catch (e) {
      fail(e);
    }
  }

  async function deleteAsset(): Promise<void> {
    const row = assetEditor.row;
    if (!row) return;
    if (!confirm(`Удалить «${row.title}»? Связанные платежи останутся, но потеряют ссылку.`)) return;
    try {
      await removeAsset(row.id);
      assetEditor = { open: false, row: null };
      await load();
      toasts.success('Удалено');
    } catch (e) {
      fail(e);
    }
  }

  async function snapshot(): Promise<void> {
    try {
      await takeSnapshot();
      await load();
      toasts.success('Снимок капитала сохранён');
    } catch (e) {
      fail(e);
    }
  }

  /* --- план месяца --- */

  async function savePlan(patch: {
    expectedIncome: number;
    savingsTarget: number;
    lines: { categoryId: string; limit: number }[];
    notes: string;
  }): Promise<void> {
    try {
      await saveMonthBudget(month, patch);
      await load();
      toasts.success('План месяца сохранён');
    } catch (e) {
      fail(e);
    }
  }

  async function copyPreviousPlan(): Promise<void> {
    try {
      await copyMonthBudget(shiftMonth(month, -1), month);
      await load();
      toasts.success('План скопирован с прошлого месяца');
    } catch (e) {
      fail(e);
    }
  }
</script>
<div class="page">
  <header class="page-head">
    <div>
      <h1>Бюджет</h1>
      <p class="muted small">
        {#if loading}
          Загрузка…
        {:else}
          Счета, операции и конверты на {monthLabel(month)}.
        {/if}
      </p>
    </div>
    <div class="row wrap" style="gap: 8px">
      <button class="btn btn-sm btn-primary" onclick={() => (txEditor = { open: true, row: null })}>
        + Операция
      </button>
      <button class="btn btn-sm" onclick={() => (categoryEditor = { open: true, row: null })}>
        + Категория
      </button>
    </div>
  </header>

  <div class="card month">
    <button class="btn btn-sm" onclick={() => (month = shiftMonth(month, -1))} aria-label="Предыдущий месяц">
      ←
    </button>
    <strong>{monthLabel(month)}</strong>
    <div class="row" style="gap: 6px">
      <button class="btn btn-sm" onclick={() => (month = currentMonth())}>Сейчас</button>
      <button class="btn btn-sm" onclick={() => (month = shiftMonth(month, 1))} aria-label="Следующий месяц">
        →
      </button>
    </div>
  </div>

  <nav class="tabs" aria-label="Разделы бюджета">
    {#each BUDGET_TABS as item (item)}
      <button
        class="tab-btn"
        class:on={tab === item}
        aria-pressed={tab === item}
        onclick={() => goTab(item)}
      >
        {TAB_TITLES[item]}
      </button>
    {/each}
  </nav>

  {#if loading}
    <div class="card empty">Загрузка бюджета…</div>
  {:else if tab === 'overview'}
    <BudgetOverview
      {accounts}
      {categories}
      {transactions}
      {obligations}
      {budget}
      {month}
      onOpenAccount={(row) => (accountEditor = { open: true, row })}
      onNewAccount={() => (accountEditor = { open: true, row: null })}
      onNewTransaction={() => (txEditor = { open: true, row: null })}
      onOpenPlan={() => goTab('plan')}
    />
  {:else if tab === 'journal'}
    <BudgetJournal
      transactions={monthRows}
      {accounts}
      {categories}
      {month}
      onOpen={(row) => (txEditor = { open: true, row })}
      onNew={() => (txEditor = { open: true, row: null })}
    />
  {:else if tab === 'plan'}
    <BudgetPlanTab
      {budget}
      {month}
      {categories}
      transactions={monthRows}
      onSave={savePlan}
      onCopyFromPrevious={copyPreviousPlan}
      onOpenCategory={(row) => (categoryEditor = { open: true, row })}
      onNewCategory={() => (categoryEditor = { open: true, row: null })}
    />
  {:else if tab === 'obligations'}
    <BudgetObligations
      {obligations}
      {categories}
      {accounts}
      transactions={monthRows}
      {month}
      onOpen={(row) => (obligationEditor = { open: true, row })}
      onNew={() => (obligationEditor = { open: true, row: null })}
      onPay={pay}
    />
  {:else if tab === 'assets'}
    <BudgetAssets
      {accounts}
      {transactions}
      {assets}
      {snapshots}
      onOpen={(row) => (assetEditor = { open: true, row })}
      onNew={() => (assetEditor = { open: true, row: null })}
      onSnapshot={snapshot}
    />
  {:else}
    <BudgetAnalytics
      {accounts}
      {categories}
      {transactions}
      {budget}
      {obligations}
      {month}
    />
  {/if}
</div>

<TransactionEditor
  open={txEditor.open}
  transaction={txEditor.row}
  accounts={accounts}
  categories={categories}
  onSave={saveTransaction}
  onClose={() => (txEditor = { open: false, row: null })}
  onDelete={txEditor.row ? deleteTransaction : undefined}
/>

<AccountEditor
  open={accountEditor.open}
  account={accountEditor.row}
  onSave={saveAccount}
  onClose={() => (accountEditor = { open: false, row: null })}
  onDelete={accountEditor.row ? deleteAccount : undefined}
/>

<CategoryEditor
  open={categoryEditor.open}
  category={categoryEditor.row}
  onSave={saveCategory}
  onClose={() => (categoryEditor = { open: false, row: null })}
  onDelete={categoryEditor.row ? deleteCategory : undefined}
/>

<ObligationEditor
  open={obligationEditor.open}
  obligation={obligationEditor.row}
  {accounts}
  {categories}
  {assets}
  onSave={saveObligation}
  onClose={() => (obligationEditor = { open: false, row: null })}
  onDelete={obligationEditor.row ? deleteObligation : undefined}
/>

<AssetEditor
  open={assetEditor.open}
  asset={assetEditor.row}
  onSave={saveAsset}
  onClose={() => (assetEditor = { open: false, row: null })}
  onDelete={assetEditor.row ? deleteAsset : undefined}
/>
<style>
  .page {
    max-width: 1024px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page-head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .page-head h1 {
    margin: 0 0 4px;
    font-size: 1.3rem;
  }

  .page-head p {
    margin: 0;
  }

  .month {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
  }

  .tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab-btn {
    flex: 0 0 auto;
    padding: 7px 12px;
    border-radius: 999px;
    border: 1px solid var(--border-soft);
    background: var(--bg-elev);
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 550;
    white-space: nowrap;
  }

  .tab-btn.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }
</style>

