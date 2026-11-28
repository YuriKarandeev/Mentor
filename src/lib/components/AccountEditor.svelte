<script lang="ts">
  import type { MoneyAccount } from '../db/db';
  import { ACCOUNT_KINDS, ACCOUNT_KIND_TITLES, type AccountKind } from '../utils/budget';
  import MoneyInput from './MoneyInput.svelte';

  export interface AccountFormValue {
    title: string;
    kind: AccountKind;
    openingBalance: number;
    includeInFree: boolean;
    archived: boolean;
    notes: string;
  }

  let {
    open,
    account = null,
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    account?: MoneyAccount | null;
    onSave: (value: AccountFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<AccountFormValue>({
    title: '',
    kind: 'card',
    openingBalance: 0,
    includeInFree: true,
    archived: false,
    notes: ''
  });
  let error = $state('');
  let hydratedFor = '';

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = account?.id ?? 'new';
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = account
      ? {
          title: account.title,
          kind: account.kind,
          openingBalance: account.openingBalance,
          includeInFree: account.includeInFree,
          archived: account.archived,
          notes: account.notes
        }
      : {
          title: '',
          kind: 'card',
          openingBalance: 0,
          includeInFree: true,
          archived: false,
          notes: ''
        };
  });

  /** У копилок и брокерского счёта деньги уже имеют назначение. */
  function changeKind(kind: AccountKind): void {
    form.kind = kind;
    if (kind === 'savings' || kind === 'invest') form.includeInFree = false;
  }

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название счёта';
      return;
    }
    error = '';
    onSave({ ...form, title, notes: form.notes.trim() });
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Счёт">
      <header class="row-between">
        <h2>{account ? 'Счёт' : 'Новый счёт'}</h2>
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
          <label for="acc-title">Название</label>
          <input id="acc-title" bind:value={form.title} maxlength="80" placeholder="Карта Сбербанка" />
        </div>

        <div class="col">
          <label for="acc-kind">Тип</label>
          <select
            id="acc-kind"
            value={form.kind}
            onchange={(e) => changeKind((e.currentTarget as HTMLSelectElement).value as AccountKind)}
          >
            {#each ACCOUNT_KINDS as kind (kind)}
              <option value={kind}>{ACCOUNT_KIND_TITLES[kind]}</option>
            {/each}
          </select>
        </div>

        <MoneyInput
          id="acc-opening"
          label="Остаток сейчас"
          value={form.openingBalance}
          ariaLabel="Остаток на счёте"
          onInput={(kopecks) => (form.openingBalance = kopecks)}
        />
        <p class="tiny mute hint">
          Это точка отсчёта: дальше остаток считается по операциям. Меняя сумму у старого счёта,
          вы сдвигаете всю его историю.
        </p>

        <label class="check">
          <input type="checkbox" bind:checked={form.includeInFree} />
          учитывать в свободных деньгах
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={form.archived} />
          счёт в архиве
        </label>

        <div class="col">
          <label for="acc-notes">Заметка</label>
          <textarea id="acc-notes" bind:value={form.notes} maxlength="400" rows="2" placeholder="Проценты, лимит, банк"></textarea>
        </div>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if account && onDelete}
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
    width: min(520px, 100%);
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
    margin: -4px 0 0;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
  }
</style>
