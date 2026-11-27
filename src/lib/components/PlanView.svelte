<script lang="ts">
  import type { Citation, Plan } from '../db/db';
  import { planProgress } from '../db/db';
  import { formatMinutes } from '../utils/format';
  import ItemSummary from './ItemSummary.svelte';

  /**
   * План обучения. Пункт состоит из чекбокса (отметка «сделано») и кнопки
   * с названием: клик по названию открывает конспект пункта. Состояние
   * читалки держит страница — так его можно сбросить при смене темы.
   */
  let {
    plan,
    onToggle,
    openItemId = null,
    summaryIds,
    onOpenItem,
    itemText = '',
    itemBusy = false,
    itemError = '',
    itemCached = false,
    itemCitations = [],
    onRegenerate,
    onStop,
    onClose
  }: {
    plan: Plan;
    onToggle: (moduleId: string, itemId: string) => void;
    openItemId?: string | null;
    /** id пунктов, у которых уже есть сохранённый конспект. */
    summaryIds?: Set<string>;
    onOpenItem: (itemId: string) => void;
    itemText?: string;
    itemBusy?: boolean;
    itemError?: string;
    itemCached?: boolean;
    itemCitations?: Citation[];
    onRegenerate: () => void;
    onStop: () => void;
    onClose: () => void;
  } = $props();

  const stats = $derived(planProgress(plan));
  const totalMin = $derived(
    plan.modules.reduce((acc, m) => acc + m.items.reduce((s, i) => s + i.estMin, 0), 0)
  );

  const KIND_LABEL: Record<string, string> = {
    theory: 'теория',
    practice: 'практика',
    check: 'проверка'
  };

  const summaryId = (itemId: string) => `item-summary-${itemId}`;
</script>

<div class="plan">
  <div class="head">
    <div>
      <h2>{plan.title}</h2>
      {#if plan.summary}<p class="muted small">{plan.summary}</p>{/if}
      <p class="mute tiny">Нажмите на задание, чтобы открыть конспект по нему.</p>
    </div>
    <div class="row wrap">
      <span class="chip">{stats.done} / {stats.total}</span>
      <span class="chip">{formatMinutes(totalMin)}</span>
      <span class="chip chip-accent">{stats.pct}%</span>
    </div>
  </div>

  <div class="bar"><div class="bar-fill" style="width: {stats.pct}%"></div></div>

  {#each plan.modules as mod, mi (mod.id)}
    <section class="module">
      <header class="mod-head">
        <span class="num">{mi + 1}</span>
        <div class="grow">
          <h3>{mod.title}</h3>
          {#if mod.goal}<p class="mute small">{mod.goal}</p>{/if}
        </div>
      </header>

      <ul class="items">
        {#each mod.items as item (item.id)}
          {@const open = openItemId === item.id}
          <li class:done={item.done} class:active={open}>
            <div class="line">
              <input
                type="checkbox"
                class="tick"
                checked={item.done}
                aria-label={item.done
                  ? `Снять отметку о выполнении: ${item.title}`
                  : `Отметить выполненным: ${item.title}`}
                onchange={() => onToggle(mod.id, item.id)}
              />
              <button
                type="button"
                class="item-btn"
                aria-expanded={open}
                aria-controls={open ? summaryId(item.id) : undefined}
                onclick={() => onOpenItem(item.id)}
              >
                <span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span class="title">{item.title}</span>
              </button>
              <span class="meta">
                {#if summaryIds?.has(item.id)}
                  <span class="chip tiny chip-accent">конспект</span>
                {/if}
                <span class="chip tiny kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
                <span class="mute tiny">{formatMinutes(item.estMin)}</span>
              </span>
            </div>

            {#if open}
              <ItemSummary
                id={summaryId(item.id)}
                title={item.title}
                md={itemText}
                citations={itemCitations}
                streaming={itemBusy}
                error={itemError}
                cached={itemCached}
                onRegenerate={onRegenerate}
                onStop={onStop}
                onClose={onClose}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .head p {
    margin: 0;
  }

  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-elev-2);
    overflow: hidden;
    margin-bottom: 18px;
  }

  .bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.25s ease;
  }

  .module {
    border-top: 1px solid var(--border-soft);
    padding: 14px 0 4px;
  }

  .mod-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-bottom: 8px;
  }

  .mod-head p {
    margin: 0;
  }

  .num {
    flex: 0 0 26px;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    display: grid;
    place-items: center;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .items {
    list-style: none;
    margin: 0;
    padding: 0 0 0 36px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .items li {
    padding: 6px 8px;
    border-radius: var(--radius-s);
  }

  .items li:hover {
    background: var(--bg-elev-2);
  }

  .items li.active {
    background: var(--bg-elev-2);
  }

  .line {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .tick {
    width: 18px;
    height: 18px;
    margin-top: 12px;
    flex: 0 0 auto;
    accent-color: var(--accent);
  }

  /* Название пункта — отдельная кнопка: чекбокс рядом, а не внутри. */
  .item-btn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    display: flex;
    gap: 8px;
    align-items: flex-start;
    background: none;
    border: 0;
    padding: 2px 0;
    text-align: left;
    color: inherit;
    font-size: 0.94rem;
  }

  .item-btn:hover .caret {
    color: var(--text);
  }

  .item-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-s);
  }

  .caret {
    flex: 0 0 14px;
    width: 14px;
    color: var(--text-mute);
    font-size: 0.85rem;
    line-height: 1.65;
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .done .title {
    text-decoration: line-through;
    color: var(--text-mute);
  }

  .meta {
    display: flex;
    gap: 6px;
    align-items: center;
    flex: 0 0 auto;
    margin-top: 11px;
  }

  @media (max-width: 640px) {
    .items {
      padding-left: 6px;
    }
    /* Тип и время на узком экране прячем, а метку «конспект» оставляем. */
    .meta .kind,
    .meta .mute {
      display: none;
    }
  }
</style>
