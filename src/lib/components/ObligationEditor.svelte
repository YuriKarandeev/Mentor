<script lang="ts">
  import type { BudgetAsset, BudgetCategory, BudgetObligation, MoneyAccount } from '../db/db';
  import {
    FREQUENCIES,
    FREQUENCY_TITLES,
    OBLIGATION_KINDS,
    OBLIGATION_KIND_TITLES,
    type Frequency,
    type ObligationKind
  } from '../utils/budget';
  import { todayIso } from '../utils/planner';
  import MoneyInput from './MoneyInput.svelte';

  export interface ObligationFormValue {
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

  let {
    open,
    obligation = null,
    accounts,
    categories,
    assets,
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    obligation?: BudgetObligation | null;
    accounts: MoneyAccount[];
    categories: BudgetCategory[];
    assets: BudgetAsset[];
    onSave: (value: ObligationFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<ObligationFormValue>({
    title: '',
    kind: 'bill',
    amount: 0,
    frequency: 'monthly',
    dueDay: 1,
    dueDate: todayIso(),
    active: true,
    remind: true,
    categoryId: '',
    accountId: '',
    assetId: '',
    notes: ''
  });
  let error = $state('');
  let hydratedFor = '';

  const activeAccounts = $derived(accounts.filter((account) => !account.archived));
  const expenseCategories = $derived(categories.filter((category) => category.kind === 'expense'));
  const liabilities = $derived(assets.filter((asset) => asset.kind === 'liability'));

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = obligation?.id ?? 'new';
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = obligation
      ? {
          title: obligation.title,
          kind: obligation.kind,
          amount: obligation.amount,
          frequency: obligation.frequency,
          dueDay: obligation.dueDay,
          dueDate: obligation.dueDate || todayIso(),
          active: obligation.active,
          remind: obligation.remind,
          categoryId: obligation.categoryId,
          accountId: obligation.accountId,
          assetId: obligation.assetId,
          notes: obligation.notes
        }
      : {
          title: '',
          kind: 'bill',
          amount: 0,
          frequency: 'monthly',
          dueDay: 1,
          dueDate: todayIso(),
          active: true,
          remind: true,
          categoryId: '',
          accountId: activeAccounts[0]?.id ?? '',
          assetId: '',
          notes: ''
        };
  });

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название платежа';
      return;
    }
    if (!(form.amount > 0)) {
      error = 'Введите сумму больше нуля';
      return;
    }
    if (form.frequency !== 'monthly' && !form.dueDate) {
      error = 'Выберите дату платежа';
      return;
    }
    error = '';
    onSave({
      ...form,
      title,
      notes: form.notes.trim(),
      dueDate: form.frequency === 'monthly' ? '' : form.dueDate
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Обязательство">
      <header class="row-between">
        <h2>{obligation ? 'Платёж' : 'Новый платёж'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div class="col">
          <label for="obl-title">Название</label>
          <input id="obl-title" bind:value={form.title} maxlength="80" placeholder="Аренда, подписка, кредит…" />
        </div>

        <div class="grid2">
          <div class="col">
            <label for="obl-kind">Тип</label>
            <select
              id="obl-kind"
              value={form.kind}
              onchange={(e) =>
                (form.kind = (e.currentTarget as HTMLSelectElement).value as ObligationKind)}
            >
              {#each OBLIGATION_KINDS as kind (kind)}
                <option value={kind}>{OBLIGATION_KIND_TITLES[kind]}</option>
              {/each}
            </select>
          </div>
          <div class="col">
            <label for="obl-freq">Периодичность</label>
            <select
              id="obl-freq"
              value={form.frequency}
              onchange={(e) =>
                (form.frequency = (e.currentTarget as HTMLSelectElement).value as Frequency)}
            >
              {#each FREQUENCIES as frequency (frequency)}
                <option value={frequency}>{FREQUENCY_TITLES[frequency]}</option>
              {/each}
            </select>
          </div>
        </div>

        <MoneyInput
          id="obl-amount"
          label="Сумма платежа"
          value={form.amount}
          ariaLabel="Сумма платежа"
          onInput={(kopecks) => (form.amount = kopecks)}
        />

        {#if form.frequency === 'monthly'}
          <div class="col">
            <label for="obl-day">День месяца (1–31)</label>
            <input
              id="obl-day"
              type="number"
              min="1"
              max="31"
              value={form.dueDay}
              oninput={(e) =>
                (form.dueDay = Math.min(31, Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1)))}
            />
            <p class="tiny mute hint">Если в месяце меньше дней, платёж переносится на последний день.</p>
          </div>
        {:else}
          <div class="col">
            <label for="obl-date">Дата платежа</label>
            <input id="obl-date" type="date" bind:value={form.dueDate} />
          </div>
        {/if}

        <div class="grid2">
          <div class="col">
            <label for="obl-account">Счёт списания</label>
            <select id="obl-account" bind:value={form.accountId}>
              <option value="">Не указан</option>
              {#each activeAccounts as account (account.id)}
                <option value={account.id}>{account.title}</option>
              {/each}
            </select>
          </div>
          <div class="col">
            <label for="obl-category">Категория</label>
            <select id="obl-category" bind:value={form.categoryId}>
              <option value="">Без категории</option>
              {#each expenseCategories as category (category.id)}
                <option value={category.id}>
                  {category.icon ? `${category.icon} ` : ''}{category.title}
                </option>
              {/each}
            </select>
          </div>
        </div>

        {#if form.kind === 'loan' || form.kind === 'debt'}
          <div class="col">
            <label for="obl-asset">Связанный долг</label>
            <select id="obl-asset" bind:value={form.assetId}>
              <option value="">Не связан</option>
              {#each liabilities as asset (asset.id)}
                <option value={asset.id}>{asset.title}</option>
              {/each}
            </select>
            <p class="tiny mute hint">При оплате остаток этого долга уменьшится на сумму платежа.</p>
          </div>
        {/if}

        <label class="check">
          <input type="checkbox" bind:checked={form.remind} />
          напоминать о платеже (за день и в день оплаты)
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={form.active} />
          платёж активен
        </label>

        <div class="col">
          <label for="obl-notes">Заметка</label>
          <textarea id="obl-notes" bind:value={form.notes} maxlength="400" rows="2" placeholder="Реквизиты, условия"></textarea>
        </div>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if obligation && onDelete}
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

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    color: var(--text-dim);
    margin: 0;
  }

  .check input {
    width: auto;
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


