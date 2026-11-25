<script lang="ts">
  let {
    onSend,
    onStop,
    disabled = false,
    busy = false,
    placeholder = 'Написать сообщение…'
  }: {
    onSend: (text: string) => void;
    onStop?: () => void;
    disabled?: boolean;
    busy?: boolean;
    placeholder?: string;
  } = $props();

  let value = $state('');
  let area = $state<HTMLTextAreaElement | null>(null);

  function submit(): void {
    const text = value.trim();
    if (!text || disabled) return;
    value = '';
    onSend(text);
    if (area) area.style.height = 'auto';
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function autosize(): void {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
  }
</script>

<form
  class="composer"
  onsubmit={(e) => {
    e.preventDefault();
    submit();
  }}
>
  <textarea
    bind:this={area}
    bind:value
    oninput={autosize}
    onkeydown={onKeydown}
    {placeholder}
    rows="1"
    disabled={disabled && !busy}
  ></textarea>

  {#if busy && onStop}
    <button type="button" class="btn btn-sm" onclick={onStop}>Стоп</button>
  {:else}
    <button type="submit" class="btn btn-primary" disabled={disabled || value.trim().length === 0}>
      Отправить
    </button>
  {/if}
</form>

<style>
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 8px 0 0;
  }

  textarea {
    min-height: 44px;
    max-height: 200px;
    padding: 11px 12px;
    line-height: 1.45;
    resize: none;
  }

  .btn {
    height: 44px;
    flex: 0 0 auto;
  }
</style>
