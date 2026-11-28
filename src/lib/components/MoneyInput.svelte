<script lang="ts">
  import { untrack } from 'svelte';
  import { isMoneyInput, moneyInputValue, parseMoney } from '../utils/money';

  let {
    value = 0,
    label = '',
    id = '',
    placeholder = '0',
    ariaLabel = '',
    disabled = false,
    onInput
  }: {
    /** Значение в копейках: компонент только форматирует рубли для ввода. */
    value?: number;
    label?: string;
    id?: string;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onInput: (kopecks: number) => void;
  } = $props();

  let text = $state(untrack(() => moneyInputValue(value)));
  let focused = $state(false);
  let invalid = $state(false);
  let last = $state(untrack(() => value));

  // Внешнее значение (сброс формы, загрузка) обновляет поле, но не затирает набор.
  $effect(() => {
    if (value === last) return;
    last = value;
    if (!focused) text = moneyInputValue(value);
  });

  function handleInput(event: Event): void {
    const raw = (event.currentTarget as HTMLInputElement).value;
    text = raw;
    if (!isMoneyInput(raw)) {
      invalid = true;
      return;
    }
    invalid = false;
    const parsed = parseMoney(raw);
    last = parsed ?? 0;
    onInput(parsed ?? 0);
  }

  function handleBlur(): void {
    focused = false;
    invalid = false;
    text = moneyInputValue(value);
  }
</script>

{#if label}
  <label for={id || undefined}>{label}</label>
{/if}
<div class="money" class:invalid>
  <input
    id={id || undefined}
    type="text"
    inputmode="decimal"
    autocomplete="off"
    {placeholder}
    {disabled}
    aria-label={ariaLabel || label || undefined}
    value={text}
    oninput={handleInput}
    onfocus={() => (focused = true)}
    onblur={handleBlur}
  />
  <span class="unit" aria-hidden="true">₽</span>
</div>

<style>
  .money {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    padding-right: 10px;
  }

  .money input {
    border: none;
    background: transparent;
    padding: 10px 12px;
    font-variant-numeric: tabular-nums;
  }

  .money input:focus {
    outline: none;
  }

  .money:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .money.invalid {
    outline: 2px solid var(--danger);
  }

  .unit {
    color: var(--text-mute);
  }
</style>
