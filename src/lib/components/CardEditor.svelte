<script lang="ts">
  import type { ProjectCard } from '../db/db';
  import { CARD_COLUMNS, COLUMN_HINTS, COLUMN_LABELS, type CardColumn } from '../utils/projects';

  interface CardFormValue {
    title: string;
    notes: string;
    column: CardColumn;
    dueDate: string;
  }

  let {
    open,
    card = null,
    defaultColumn = 'todo',
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    card?: ProjectCard | null;
    defaultColumn?: CardColumn;
    onSave: (value: CardFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<CardFormValue>({ title: '', notes: '', column: 'todo', dueDate: '' });
  let error = $state('');
  let hydratedFor = '';

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = `${card?.id ?? 'new'}:${defaultColumn}`;
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = card
      ? { title: card.title, notes: card.notes, column: card.column, dueDate: card.dueDate }
      : { title: '', notes: '', column: defaultColumn, dueDate: '' };
  });

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название карточки';
      return;
    }
    error = '';
    onSave({
      title,
      notes: form.notes.trim(),
      column: form.column,
      dueDate: form.dueDate
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Карточка">
      <header class="row-between">
        <h2>{card ? 'Карточка' : 'Новая карточка'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label for="card-title">Название</label>
        <input
          id="card-title"
          bind:value={form.title}
          maxlength="160"
          placeholder="Например, собрать документы"
        />

        <div class="col" style="gap: 6px">
          <span class="label-text">Колонка</span>
          <div class="row wrap" style="gap: 6px">
            {#each CARD_COLUMNS as column (column)}
              <button
                type="button"
                class="btn btn-sm"
                class:btn-primary={form.column === column}
                aria-pressed={form.column === column}
                onclick={() => (form.column = column)}
              >
                {COLUMN_LABELS[column]}
              </button>
            {/each}
          </div>
          <p class="mute tiny hint">{COLUMN_HINTS[form.column]}</p>
        </div>

        <label for="card-due">Срок (необязательно)</label>
        <input id="card-due" type="date" bind:value={form.dueDate} />

        <label for="card-notes">Заметка</label>
        <textarea
          id="card-notes"
          bind:value={form.notes}
          maxlength="600"
          rows="3"
          placeholder="Что нужно сделать, ссылки, следующий шаг…"
        ></textarea>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if card && onDelete}
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
    max-height: calc(100vh - 32px);
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

  .label-text {
    font-size: 0.86rem;
    color: var(--text-dim);
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
</style>
