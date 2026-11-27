<script lang="ts">
  import type { Note } from '../db/db';
  import { formatDate } from '../utils/format';
  import { PLAN_ITEM_TAG_PREFIX } from '../utils/plan-note';
  import Markdown from './Markdown.svelte';

  /**
   * Карточка конспекта: в свёрнутом виде видно только название и мету, текст
   * разбора монтируется при раскрытии. Состояние держит страница — так его
   * можно сбросить при смене темы и открыть только что созданный конспект.
   */
  let {
    note,
    open = false,
    onToggle,
    onRemove
  }: {
    note: Note;
    open?: boolean;
    onToggle: () => void;
    onRemove?: () => void;
  } = $props();

  const SOURCE_LABEL: Record<Note['source'], string> = {
    book: 'книга',
    chat: 'из чата',
    manual: 'заметка',
    web: 'веб'
  };

  const bodyId = $derived(`note-body-${note.id}`);
  /** Заголовок может оказаться пустым (заметку начали с пустой строки). */
  const title = $derived(note.title.trim() || 'Без названия');
  /** Конспект, собранный по заданию плана, помечаем отдельно от «из чата». */
  const sourceLabel = $derived(
    (note.tags ?? []).some((tag) => tag.startsWith(PLAN_ITEM_TAG_PREFIX))
      ? 'по заданию плана'
      : (SOURCE_LABEL[note.source] ?? note.source)
  );
  const meta = $derived(
    `${formatDate(note.createdAt)} · ${sourceLabel} · ${note.md.length.toLocaleString('ru-RU')} симв.`
  );
</script>

<article class="card note" class:open>
  <div class="head">
    <button
      type="button"
      class="toggle"
      aria-expanded={open}
      aria-controls={open ? bodyId : undefined}
      onclick={onToggle}
    >
      <span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span class="titles">
        <strong class="title">{title}</strong>
        <span class="mute tiny">{meta}</span>
      </span>
    </button>
    {#if onRemove}
      <button type="button" class="btn btn-sm btn-ghost" onclick={onRemove}>Удалить</button>
    {/if}
  </div>

  {#if open}
    <div class="body" id={bodyId}>
      <Markdown md={note.md} />
      {#if note.citations && note.citations.length > 0}
        <ul class="cites">
          {#each note.citations as c (c.url)}
            <li>
              <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</article>

<style>
  .head {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
  }

  /* Кликабельная шапка: высота не меньше 44px — удобно попасть пальцем. */
  .toggle {
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
  }

  .toggle:hover .caret {
    color: var(--text);
  }

  .toggle:focus-visible {
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

  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .open .title {
    color: var(--text-dim);
  }

  .body {
    margin-top: 10px;
    border-top: 1px dashed var(--border-soft);
    padding-top: 10px;
  }

  .cites {
    margin: 10px 0 0;
    padding-left: 18px;
    font-size: 0.8rem;
  }
</style>
