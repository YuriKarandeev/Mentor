<script lang="ts">
  import Markdown from '../components/Markdown.svelte';
  import { bookMessages, streamTurn, webToolsSupported } from '../api/agent';
  import { describeStreamError } from '../api/stream-error';
  import { addNote, db, removeNote as deleteNote, type Citation, type Note } from '../db/db';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { sync } from '../sync/state.svelte';
  import { formatDate } from '../utils/format';

  let query = $state('');
  let busy = $state(false);
  let text = $state('');
  let citations = $state<Citation[]>([]);
  let error = $state('');
  let notes = $state<Note[]>([]);
  let savedDraft = $state(false);
  let abort: AbortController | null = null;

  async function load(): Promise<void> {
    const all = await db.notes.toArray();
    notes = all.filter((n) => n.source === 'book').sort((a, b) => b.createdAt - a.createdAt);
  }

  $effect(() => {
    sync.revision;
    void load();
  });

  async function storeNote(title: string, md: string, cites: Citation[]): Promise<void> {
    const n = await addNote({ title, md, source: 'book', tags: [], citations: cites });
    notes = [n, ...notes];
    savedDraft = true;
  }

  /** Сохраняет уже полученный текст, если стрим оборвался на середине. */
  async function keepPartial(title: string): Promise<boolean> {
    const draft = text.trim();
    if (!draft) return false;
    await storeNote(`${title} (черновик)`, draft, citations);
    return true;
  }

  async function generate(): Promise<void> {
    const q = query.trim();
    if (!q || busy) return;
    if (!settings.configured) {
      error = 'Сначала настройте подключение к DeepSeek в «Настройках».';
      return;
    }
    if (!settings.data.webSearch) {
      error = 'Включите веб-поиск в «Настройках» — без него конспект будет неточным.';
      return;
    }
    if (!webToolsSupported(settings.data.model)) {
      error = 'Веб-поиск DeepSeek работает с моделью deepseek-flash — выберите её в «Настройках».';
      return;
    }
    busy = true;
    text = '';
    citations = [];
    error = '';
    savedDraft = false;
    abort = new AbortController();

    try {
      const res = await streamTurn({
        settings: settings.data,
        messages: bookMessages(q),
        // Разбор книги — самый длинный запрос: с низкой глубиной размышлений
        // первый байт приходит раньше, а стрим реже упирается в таймауты.
        effort: 'low',
        signal: abort.signal,
        handlers: {
          onDelta: (d) => {
            text += d;
          },
          onCitations: (c) => {
            citations = c;
          }
        }
      });

      const finalText = (res.content || text).trim();
      if (finalText) {
        await storeNote(q, finalText, res.citations.length ? res.citations : citations);
        query = '';
        if (res.interrupted) {
          toasts.info('Ответ пришёл не до конца — конспект сохранён как черновик');
        } else {
          toasts.success('Конспект сохранён в библиотеку');
        }
      }
    } catch (e) {
      // Частичный текст не выбрасываем: разбор книги — дорогой запрос.
      const kept = await keepPartial(q);
      error = describeStreamError(e, {
        stage: text.trim() ? 'stream' : 'connect',
        suffix: kept ? 'Черновик сохранён в библиотеку.' : ''
      });
    } finally {
      busy = false;
      abort = null;
    }
  }

  async function remove(id: string): Promise<void> {
    await deleteNote(id);
    notes = notes.filter((n) => n.id !== id);
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Библиотека</h1>
      <p class="muted small">Конспекты книг: наставник ищет достоверные данные в вебе и собирает разбор.</p>
    </div>
  </header>

  <div class="card col">
    <label for="q">Название книги и автор</label>
    <input id="q" bind:value={query} placeholder="Например: «Думай медленно… решай быстро», Канеман" />
    <div class="row wrap">
      <button class="btn btn-primary" onclick={generate} disabled={busy || query.trim().length < 2}>
        {busy ? 'Собираю…' : 'Собрать конспект'}
      </button>
      {#if busy}
        <button class="btn btn-sm" onclick={() => abort?.abort()}>Стоп</button>
      {/if}
      {#if !settings.data.webSearch}
        <span class="chip">веб-поиск выключен</span>
      {:else if !webToolsSupported(settings.data.model)}
        <span class="chip">веб-поиск: нужен deepseek-flash</span>
      {/if}
    </div>
    {#if error}<div class="err">{error}</div>{/if}
  </div>

  {#if busy || text}
    <article class="card live">
      <div class="row-between" style="margin-bottom: 6px">
        <strong>{busy ? 'Готовлю конспект…' : 'Черновик конспекта'}</strong>
        {#if !busy && savedDraft}
          <span class="chip chip-accent">сохранено</span>
        {/if}
      </div>
      {#if text}
        <Markdown md={text} />
      {:else}
        <div class="muted small">Ищу источники…</div>
      {/if}
      {#if citations.length > 0}
        <ul class="cites">
          {#each citations as c (c.url)}
            <li><a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a></li>
          {/each}
        </ul>
      {/if}
    </article>
  {/if}

  <h2 class="sec">Сохранённые конспекты</h2>

  {#if notes.length === 0}
    <div class="empty">Здесь появятся разборы книг.</div>
  {/if}

  {#each notes as n (n.id)}
    <article class="card">
      <div class="row-between" style="margin-bottom: 8px">
        <div>
          <strong>{n.title}</strong>
          <div class="mute tiny">{formatDate(n.createdAt)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick={() => remove(n.id)}>Удалить</button>
      </div>
      <Markdown md={n.md} />
      {#if n.citations && n.citations.length > 0}
        <ul class="cites">
          {#each n.citations as c (c.url)}
            <li><a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a></li>
          {/each}
        </ul>
      {/if}
    </article>
  {/each}
</div>

<style>
  .page {
    max-width: 880px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 20px;
  }

  .page-head h1 {
    margin-bottom: 4px;
  }

  .page-head p {
    margin: 0;
  }

  .sec {
    margin: 8px 0 0;
    font-size: 1rem;
    color: var(--text-dim);
  }

  .live {
    border-color: var(--accent);
  }

  .cites {
    margin: 10px 0 0;
    padding-left: 18px;
    font-size: 0.8rem;
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
