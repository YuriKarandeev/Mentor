<script lang="ts">
  import type { BudgetCategory } from '../db/db';
  import {
    CATEGORY_GROUPS,
    GROUP_TITLES,
    type CategoryGroup,
    type CategoryKind
  } from '../utils/budget';

  export interface CategoryFormValue {
    title: string;
    kind: CategoryKind;
    group: CategoryGroup;
    essential: boolean;
    icon: string;
    archived: boolean;
  }

  const ICONS = ['🛒', '🏠', '🚌', '💊', '📱', '👕', '☕', '🎓', '🎁', '📦', '🏦', '💼', '💻', '📈', '🤝', '➕'];

  let {
    open,
    category = null,
    defaultKind = 'expense',
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    category?: BudgetCategory | null;
    defaultKind?: CategoryKind;
    onSave: (value: CategoryFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<CategoryFormValue>({
    title: '',
    kind: 'expense',
    group: 'wants',
    essential: false,
    icon: '📦',
    archived: false
  });
  let error = $state('');
  let hydratedFor = '';

  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = `${category?.id ?? 'new'}:${defaultKind}`;
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = category
      ? {
          title: category.title,
          kind: category.kind,
          group: category.group,
          essential: category.essential,
          icon: category.icon,
          archived: category.archived
        }
      : {
          title: '',
          kind: defaultKind,
          group: 'wants',
          essential: false,
          icon: defaultKind === 'income' ? '💼' : '📦',
          archived: false
        };
  });

  function changeKind(kind: CategoryKind): void {
    form.kind = kind;
    if (kind === 'income') {
      form.group = 'needs';
      form.essential = false;
    }
  }

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название категории';
      return;
    }
    error = '';
    onSave({ ...form, title });
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Категория">
      <header class="row-between">
        <h2>{category ? 'Категория' : 'Новая категория'}</h2>
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
          <label for="cat-title">Название</label>
          <input id="cat-title" bind:value={form.title} maxlength="80" placeholder="Спорт, питомцы…" />
        </div>

        <div class="col">
          <label for="cat-kind">Тип</label>
          <select
            id="cat-kind"
            value={form.kind}
            onchange={(e) => changeKind((e.currentTarget as HTMLSelectElement).value as CategoryKind)}
          >
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
        </div>

        {#if form.kind === 'expense'}
          <div class="col">
            <label for="cat-group">Группа (правило 50/30/20)</label>
            <select
              id="cat-group"
              value={form.group}
              onchange={(e) =>
                (form.group = (e.currentTarget as HTMLSelectElement).value as CategoryGroup)}
            >
              {#each CATEGORY_GROUPS as group (group)}
                <option value={group}>{GROUP_TITLES[group]}</option>
              {/each}
            </select>
          </div>

          <label class="check">
            <input type="checkbox" bind:checked={form.essential} />
            обязательная трата (учитывается в резерве)
          </label>
        {/if}

        <div class="col">
          <span class="label-text">Значок</span>
          <div class="icons">
            {#each ICONS as icon (icon)}
              <button
                type="button"
                class="icon"
                class:on={form.icon === icon}
                aria-pressed={form.icon === icon}
                onclick={() => (form.icon = icon)}
              >
                {icon}
              </button>
            {/each}
          </div>
        </div>

        <label class="check">
          <input type="checkbox" bind:checked={form.archived} />
          категория в архиве
        </label>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if category && onDelete}
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

  .label-text {
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .icons {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .icon {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
  }

  .icon.on {
    background: var(--accent-soft);
    border-color: transparent;
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

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
  }
</style>


