<script lang="ts">
  export interface BarItem {
    key: string;
    label: string;
    /** Готовая подпись значения, например «12 400 ₽». */
    valueLabel: string;
    /** Заполнение полосы в процентах: может быть больше 100. */
    percent: number;
    /** Подпись справа от названия: остаток, доля и т. п. */
    note?: string;
    tone?: 'neutral' | 'good' | 'bad' | 'warn';
    onClick?: () => void;
  }

  let { items, empty = 'Пока нечего показать' }: { items: BarItem[]; empty?: string } = $props();
</script>

{#if items.length === 0}
  <p class="mute small empty-line">{empty}</p>
{:else}
  <ul class="bars">
    {#each items as item (item.key)}
      <li class="bar" class:good={item.tone === 'good'} class:bad={item.tone === 'bad'} class:warn={item.tone === 'warn'}>
        <div class="head">
          {#if item.onClick}
            <button class="name link" onclick={item.onClick}>{item.label}</button>
          {:else}
            <span class="name">{item.label}</span>
          {/if}
          <span class="value">{item.valueLabel}</span>
        </div>
        <div
          class="track"
          role="progressbar"
          aria-label={item.label}
          aria-valuenow={Math.round(item.percent)}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="fill" style={`width:${Math.min(100, Math.max(0, item.percent))}%`}></span>
        </div>
        {#if item.note}<span class="note tiny mute">{item.note}</span>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  .name {
    font-size: 0.9rem;
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: inherit;
  }

  .link:hover {
    color: var(--accent);
  }

  .value {
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .track {
    height: 8px;
    border-radius: 999px;
    background: var(--bg-elev-2);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: inherit;
    transition: width 0.2s ease;
  }

  .good .fill {
    background: var(--ok);
  }

  .warn .fill {
    background: var(--warn);
  }

  .bad .fill {
    background: var(--danger);
  }

  .note {
    overflow-wrap: anywhere;
  }

  .empty-line {
    margin: 0;
  }
</style>
