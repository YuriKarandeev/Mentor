<script lang="ts">
  import type { BudgetCategory, BudgetTransaction, MoneyAccount } from '../db/db';
  import type { TransactionType } from '../utils/budget';
  import { TRANSACTION_TYPE_TITLES } from '../utils/budget';
  import { todayIso, validDate } from '../utils/planner';
  import MoneyInput from './MoneyInput.svelte';

  export interface TransactionFormValue {
    type: TransactionType;
    amount: number;
    date: string;
    accountId: string;
    toAccountId: string;
    categoryId: string;
    payee: string;
    notes: string;
  }

  let {
    open,
    transaction = null,
    accounts,
    categories,
    defaultDate = todayIso(),
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    transaction?: BudgetTransaction | null;
    accounts: MoneyAccount[];
    categories: BudgetCategory[];
    defaultDate?: string;
    onSave: (value: TransactionFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  const TYPES: TransactionType[] = ['expense', 'income', 'transfer'];

  let form = $state<TransactionFormValue>({
    type: 'expense',
    amount: 0,
    date: todayIso(),
    accountId: '',
    toAccountId: '',
    categoryId: '',
    payee: '',
    notes: ''
  });
  let error = $state('');
  let hydratedFor = '';

  const activeAccounts = $derived(accounts.filter((account) => !account.archived));

  const categoryOptions = $derived(
    categories.filter(
      (category) =>
        !category.archived && category.kind === (form.type === 'income' ? 'income' : 'expense')
    )
  );

  const targetAccounts = $derived(
    activeAccounts.filter((account) => account.id !== form.accountId)
  );

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = `${transaction?.id ?? 'new'}:${defaultDate}`;
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    if (transaction) {
      form = {
        type: transaction.type,
        amount: transaction.amount,
        date: transaction.date,
        accountId: transaction.accountId,
        toAccountId: transaction.toAccountId,
        categoryId: transaction.categoryId,
        payee: transaction.payee,
        notes: transaction.notes
      };
      return;
    }
    form = {
      type: 'expense',
      amount: 0,
      date: validDate(defaultDate) || todayIso(),
      accountId: activeAccounts[0]?.id ?? '',
      toAccountId: '',
      categoryId: '',
      payee: '',
      notes: ''
    };
  });

  /** Перевод не должен отправляться на тот же счёт или в пустоту. */
  function changeType(type: TransactionType): void {
    form.type = type;
    form.categoryId = '';
    if (type !== 'transfer') form.toAccountId = '';
  }

  function submit(): void {
    if (!(form.amount > 0)) {
      error = 'Введите сумму больше нуля';
      return;
    }
    if (!form.accountId) {
      error = 'Выберите счёт';
      return;
    }
    if (form.type === 'transfer') {
      if (!form.toAccountId) {
        error = 'Выберите счёт получателя';
        return;
      }
      if (form.toAccountId === form.accountId) {
        error = 'Перевод должен быть между разными счетами';
        return;
      }
    }
    error = '';
    onSave({
      ...form,
      date: validDate(form.date) || todayIso(),
      payee: form.payee.trim(),
      notes: form.notes.trim()
    });
  }
</script>
{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Операция">
      <header class="row-between">
        <h2>{transaction ? 'Операция' : 'Новая операция'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div class="types">
          {#each TYPES as type (type)}
            <button
              type="button"
              class="type"
              class:on={form.type === type}
              aria-pressed={form.type === type}
              onclick={() => changeType(type)}
            >
              {TRANSACTION_TYPE_TITLES[type]}
            </button>
          {/each}
        </div>

        <MoneyInput
          id="tx-amount"
          label="Сумма"
          value={form.amount}
          ariaLabel="Сумма операции"
          onInput={(kopecks) => (form.amount = kopecks)}
        />

        <div class="grid2">
          <div class="col">
            <label for="tx-date">Дата</label>
            <input id="tx-date" type="date" bind:value={form.date} />
          </div>
          <div class="col">
            <label for="tx-account">{form.type === 'transfer' ? 'Со счёта' : 'Счёт'}</label>
            <select id="tx-account" bind:value={form.accountId}>
              {#if activeAccounts.length === 0}
                <option value="">Нет счетов</option>
              {/if}
              {#each activeAccounts as account (account.id)}
                <option value={account.id}>{account.title}</option>
              {/each}
            </select>
          </div>
        </div>

        {#if form.type === 'transfer'}
          <div class="col">
            <label for="tx-target">На счёт</label>
            <select id="tx-target" bind:value={form.toAccountId}>
              <option value="">Выберите счёт</option>
              {#each targetAccounts as account (account.id)}
                <option value={account.id}>{account.title}</option>
              {/each}
            </select>
            {#if targetAccounts.length === 0}
              <p class="tiny mute hint">Для перевода нужен второй счёт — добавьте его в «Обзор».</p>
            {/if}
          </div>
        {:else}
          <div class="col">
            <label for="tx-category">Категория (необязательно)</label>
            <select id="tx-category" bind:value={form.categoryId}>
              <option value="">Без категории</option>
              {#each categoryOptions as category (category.id)}
                <option value={category.id}>
                  {category.icon ? `${category.icon} ` : ''}{category.title}
                </option>
              {/each}
            </select>
          </div>
        {/if}

        <div class="col">
          <label for="tx-payee">Контрагент (необязательно)</label>
          <input
            id="tx-payee"
            bind:value={form.payee}
            maxlength="80"
            placeholder="Пятёрочка, работодатель…"
          />
        </div>

        <div class="col">
          <label for="tx-notes">Заметка</label>
          <textarea
            id="tx-notes"
            bind:value={form.notes}
            maxlength="400"
            rows="2"
            placeholder="За что, подробности"
          ></textarea>
        </div>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if transaction && onDelete}
            <button type="button" class="btn btn-danger btn-sm" onclick={onDelete}>Удалить</button>
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}
<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
      calc(16px + var(--safe-bottom)) calc(16px + var(--safe-left));
    z-index: 100;
  }

  .sheet {
    width: min(560px, 100%);
    max-height: calc(100dvh - 32px - var(--safe-top) - var(--safe-bottom));
    overflow-y: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--bg-elev);
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .types {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .type {
    padding: 8px 6px;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
    color: var(--text-dim);
    font-weight: 600;
  }

  .type.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .hint {
    margin: 0;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
  }

  @media (max-width: 560px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
  }
</style>


