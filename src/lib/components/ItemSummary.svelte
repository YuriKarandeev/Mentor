<script lang="ts">
  import type { Citation } from '../db/db';
  import Markdown from './Markdown.svelte';

  /**
   * Читалка конспекта пункта плана: открывается по клику на задание.
   * Текст печатается по мере генерации, состояние держит TopicPage.
   */
  let {
    id,
    title,
    md,
    citations = [],
    streaming = false,
    error = '',
    cached = false,
    onRegenerate,
    onStop,
    onClose
  }: {
    id: string;
    title: string;
    md: string;
    citations?: Citation[];
    streaming?: boolean;
    error?: string;
    cached?: boolean;
    onRegenerate: () => void;
    onStop: () => void;
    onClose: () => void;
  } = $props();

  const status = $derived(streaming ? 'собираю…' : cached ? 'сохранён в конспектах' : '');

  let root = $state<HTMLDivElement | null>(null);

  /** Панель открывается под пунктом и может уйти за край — подкручиваем к ней. */
  $effect(() => {
    root?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="reader" {id} bind:this={root}>
  <div class="head">
    <div class="titles">
      <strong class="title">Конспект пункта</strong>
      <span class="mute tiny">{title}{status ? ` · ${status}` : ''}</span>
    </div>
    <div class="row wrap actions">
      {#if streaming}
        <button type="button" class="btn btn-sm btn-ghost" onclick={onStop}>Стоп</button>
      {:else}
        <button type="button" class="btn btn-sm btn-ghost" onclick={onRegenerate}>
          {md ? 'Пересобрать' : 'Собрать'}
        </button>
      {/if}
      <button type="button" class="btn btn-sm btn-ghost" onclick={onClose}>Свернуть</button>
    </div>
  </div>

  {#if error}
    <div class="err" role="status">{error}</div>
  {/if}

  {#if md}
    <div class="body"><Markdown {md} /></div>
  {:else if streaming}
    <p class="mute small">Собираю конспект… первые строки появятся через несколько секунд.</p>
  {/if}

  {#if citations.length > 0 && !streaming}
    <div class="cites">
      <div class="mute tiny">Источники</div>
      <ul>
        {#each citations as c (c.url)}
          <li>
            <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .reader {
    margin-top: 4px;
    border-top: 1px dashed var(--border-soft);
    padding: 10px 0 2px;
  }

  .head {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-weight: 650;
  }

  .titles span {
    overflow-wrap: anywhere;
  }

  .actions {
    flex: 0 0 auto;
  }

  .body {
    margin-top: 4px;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.88rem;
    margin-bottom: 8px;
    white-space: pre-wrap;
  }

  .cites {
    margin-top: 10px;
    border-top: 1px dashed var(--border-soft);
    padding-top: 8px;
    font-size: 0.8rem;
  }

  .cites ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
</style>
