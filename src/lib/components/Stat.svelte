<script lang="ts">
  let {
    label,
    value,
    hint = '',
    tone = 'neutral'
  }: {
    label: string;
    /** Готовая подпись суммы: форматирование остаётся на вызывающей стороне. */
    value: string;
    hint?: string;
    tone?: 'neutral' | 'good' | 'bad' | 'warn';
  } = $props();
</script>

<div class="stat card-tight" class:good={tone === 'good'} class:bad={tone === 'bad'} class:warn={tone === 'warn'}>
  <span class="label">{label}</span>
  <strong class="value">{value}</strong>
  {#if hint}<span class="hint tiny mute">{hint}</span>{/if}
</div>

<style>
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-m);
    padding: 12px;
    min-width: 0;
  }

  .label {
    font-size: 0.75rem;
    color: var(--text-mute);
    text-transform: lowercase;
  }

  .value {
    font-size: 1.05rem;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .hint {
    overflow-wrap: anywhere;
  }

  .good .value {
    color: var(--ok);
  }

  .bad .value {
    color: var(--danger);
  }

  .warn .value {
    color: var(--warn);
  }
</style>
