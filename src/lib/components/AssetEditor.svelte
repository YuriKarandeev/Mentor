<script lang="ts">
  import type { BudgetAsset } from '../db/db';
  import {
    ASSET_CLASSES,
    ASSET_CLASS_TITLES,
    ASSET_KINDS,
    ASSET_KIND_TITLES,
    LIABILITY_CLASSES,
    LIABILITY_CLASS_TITLES,
    type AssetKind
  } from '../utils/budget';
  import MoneyInput from './MoneyInput.svelte';

  export interface AssetFormValue {
    title: string;
    kind: AssetKind;
    assetClass: string;
    value: number;
    ratePercent: number;
    notes: string;
  }

  let {
    open,
    asset = null,
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    asset?: BudgetAsset | null;
    onSave: (value: AssetFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<AssetFormValue>({
    title: '',
    kind: 'asset',
    assetClass: 'other',
    value: 0,
    ratePercent: 0,
    notes: ''
  });
  let error = $state('');
  let hydratedFor = '';

  const isLiability = $derived(form.kind === 'liability');
  const classOptions = $derived(isLiability ? LIABILITY_CLASSES : ASSET_CLASSES);
  const classTitles = $derived(isLiability ? LIABILITY_CLASS_TITLES : ASSET_CLASS_TITLES);

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = asset?.id ?? 'new';
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = asset
      ? {
          title: asset.title,
          kind: asset.kind,
          assetClass: asset.assetClass,
          value: asset.value,
          ratePercent: asset.ratePercent,
          notes: asset.notes
        }
      : { title: '', kind: 'asset', assetClass: 'other', value: 0, ratePercent: 0, notes: '' };
  });

  /** Класс из другого списка (например, «Ипотека» у актива) сбрасывается. */
  function changeKind(kind: AssetKind): void {
    form.kind = kind;
    form.assetClass = 'other';
  }

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название';
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Актив">
      <header class="row-between">
        <h2>{asset ? 'Актив или долг' : 'Новый актив или долг'}</h2>
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
          <label for="asset-title">Название</label>
          <input id="asset-title" bind:value={form.title} maxlength="80" placeholder="Квартира, машина, ипотека…" />
        </div>

        <div class="grid2">
          <div class="col">
            <label for="asset-kind">Что это</label>
            <select
              id="asset-kind"
              value={form.kind}
              onchange={(e) => changeKind((e.currentTarget as HTMLSelectElement).value as AssetKind)}
            >
              {#each ASSET_KINDS as kind (kind)}
                <option value={kind}>{ASSET_KIND_TITLES[kind]}</option>
              {/each}
            </select>
          </div>
          <div class="col">
            <label for="asset-class">Вид</label>
            <select id="asset-class" bind:value={form.assetClass}>
              {#each classOptions as item (item)}
                <option value={item}>{classTitles[item] ?? item}</option>
              {/each}
            </select>
          </div>
        </div>

        <MoneyInput
          id="asset-value"
          label={isLiability ? 'Остаток долга' : 'Стоимость'}
          value={form.value}
          ariaLabel={isLiability ? 'Остаток долга' : 'Стоимость'}
          onInput={(kopecks) => (form.value = kopecks)}
        />

        {#if isLiability}
          <div class="col">
            <label for="asset-rate">Ставка, % годовых (необязательно)</label>
            <input
              id="asset-rate"
              type="number"
              min="0"
              max="1000"
              value={form.ratePercent}
              oninput={(e) =>
                (form.ratePercent = Math.max(
                  0,
                  Math.min(1000, Math.round(Number((e.currentTarget as HTMLInputElement).value) || 0))
                ))}
            />
          </div>
        {/if}

        <div class="col">
          <label for="asset-notes">Заметка</label>
          <textarea
            id="asset-notes"
            bind:value={form.notes}
            maxlength="400"
            rows="2"
            placeholder="Оценка, банк, условия"
          ></textarea>
        </div>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if asset && onDelete}
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

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
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


