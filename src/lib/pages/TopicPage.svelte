<script lang="ts">
  import Composer from '../components/Composer.svelte';
  import Markdown from '../components/Markdown.svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import PlanView from '../components/PlanView.svelte';
  import {
    extractProfilePatch,
    mentorMessages,
    streamTurn,
    summarizeConversation
  } from '../api/agent';
  import { ApiError } from '../api/deepseek';
  import {
    addMessage,
    addNote,
    db,
    getMemory,
    getPlan,
    planProgress,
    removeNote as deleteNote,
    removeTopic as deleteTopic,
    setMemory,
    togglePlanItem,
    type Citation,
    type Note,
    type Plan,
    type StoredMessage,
    type Topic
  } from '../db/db';
  import { router, type TopicTab } from '../router.svelte';
  import { profile } from '../stores/profile.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { sync } from '../sync/state.svelte';
  import { formatDate } from '../utils/format';
  import { plainText } from '../utils/markdown';
  import { untrack } from 'svelte';

  let { id, tab }: { id: string; tab: TopicTab } = $props();

  let topic = $state<Topic | null>(null);
  let plan = $state<Plan | undefined>(undefined);
  let messages = $state<StoredMessage[]>([]);
  let notes = $state<Note[]>([]);
  let memory = $state('');
  let loading = $state(true);

  let streaming = $state(false);
  let streamText = $state('');
  let streamReasoning = $state('');
  let streamCitations = $state<Citation[]>([]);
  let streamError = $state('');
  let abort: AbortController | null = null;
  let thread = $state<HTMLDivElement | null>(null);

  let noteDraft = $state('');

  $effect(() => {
    const topicId = id;
    // Перечитываем данные, когда синхронизация принесла чужие изменения,
    // но не во время стриминга ответа, чтобы не сбить генерацию.
    const revision = sync.revision;
    if (revision > 0 && untrack(() => streaming)) return;
    void loadAll(topicId);
  });

  async function loadAll(topicId: string): Promise<void> {
    loading = true;
    const t = await db.topics.get(topicId);
    topic = t ?? null;
    if (!t) {
      loading = false;
      return;
    }
    plan = await getPlan(topicId);
    messages = await db.messages.where('topicId').equals(topicId).sortBy('createdAt');
    const rawNotes = await db.notes.where('topicId').equals(topicId).toArray();
    notes = rawNotes.sort((a, b) => b.createdAt - a.createdAt);
    memory = await getMemory(topicId);
    loading = false;
  }

  const progress = $derived(planProgress(plan));

  function scrollDown(): void {
    requestAnimationFrame(() => {
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
  }

  async function send(text: string): Promise<void> {
    if (!topic || streaming) return;
    const t = topic;
    const userMsg = await addMessage({ topicId: t.id, role: 'user', content: text });
    messages = [...messages, userMsg];
    streaming = true;
    streamText = '';
    streamReasoning = '';
    streamCitations = [];
    streamError = '';
    abort = new AbortController();
    scrollDown();

    try {
      const result = await streamTurn({
        settings: settings.data,
        messages: mentorMessages(t, plan, profile.data, messages, memory),
        signal: abort.signal,
        handlers: {
          onDelta: (d) => {
            streamText += d;
            scrollDown();
          },
          onReasoning: (d) => {
            streamReasoning += d;
          },
          onCitations: (c) => {
            streamCitations = c;
          }
        }
      });

      const saved = await addMessage({
        topicId: t.id,
        role: 'assistant',
        content: result.content || streamText,
        reasoning: result.reasoning || streamReasoning || undefined,
        citations: result.citations.length ? result.citations : streamCitations
      });
      messages = [...messages, saved];
      streamText = '';
      streamReasoning = '';
      void maybeUpdateMemory();
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        streamError = 'Генерация остановлена.';
      } else {
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        streamError = msg;
      }
    } finally {
      streaming = false;
      abort = null;
    }
  }

  function stop(): void {
    abort?.abort();
  }

  /** Раз в ~5 реплик сжимаем переписку в память и обновляем профиль. */
  async function maybeUpdateMemory(): Promise<void> {
    const t = topic;
    if (!t) return;
    const userTurns = messages.filter((m) => m.role === 'user').length;
    if (userTurns === 0 || userTurns % 5 !== 0) return;

    const transcript = messages
      .slice(-24)
      .map((m) => `${m.role === 'user' ? 'Ученик' : 'Наставник'}: ${plainText(m.content)}`)
      .join('\n');

    try {
      if (messages.length >= 18) {
        const summary = await summarizeConversation(settings.data, t, transcript);
        if (summary) {
          await setMemory(t.id, summary);
          memory = summary;
        }
      }
      const patch = await extractProfilePatch(settings.data, transcript);
      if (patch) await profile.merge(patch);
    } catch {
      /* память не критична для основного сценария */
    }
  }

  async function toggle(moduleId: string, itemId: string): Promise<void> {
    const current = plan;
    if (!current) return;
    const updated = await togglePlanItem(current.id, moduleId, itemId);
    if (updated) plan = { ...updated };
  }

  async function saveLastAnswer(): Promise<void> {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!last || !topic) {
      toasts.info('Нет ответов наставника для сохранения');
      return;
    }
    const n = await addNote({
      topicId: topic.id,
      title: plainText(last.content).slice(0, 70) || 'Ответ наставника',
      md: last.content,
      source: 'chat',
      tags: [],
      citations: last.citations
    });
    notes = [n, ...notes];
    toasts.success('Сохранено в конспекты');
  }

  async function addManualNote(): Promise<void> {
    const md = noteDraft.trim();
    if (!md || !topic) return;
    const n = await addNote({
      topicId: topic.id,
      title: md.split('\n')[0].slice(0, 70),
      md,
      source: 'manual',
      tags: []
    });
    notes = [n, ...notes];
    noteDraft = '';
  }

  async function removeNote(note: Note): Promise<void> {
    await deleteNote(note.id);
    notes = notes.filter((n) => n.id !== note.id);
  }

  async function removeTopic(): Promise<void> {
    if (!topic) return;
    if (!confirm(`Удалить тему «${topic.title}» вместе с планом, чатом и конспектами?`)) return;
    await deleteTopic(topic.id);
    router.go('/');
  }
</script>

{#if loading}
  <div class="empty">Загрузка темы…</div>
{:else if !topic}
  <div class="empty">
    <p>Тема не найдена.</p>
    <button class="btn btn-sm" onclick={() => router.go('/')}>К списку тем</button>
  </div>
{:else}
  <div class="page">
    <header class="head">
      <div class="row" style="gap: 8px">
        <button class="btn btn-sm btn-ghost" onclick={() => router.go('/')} aria-label="Назад">←</button>
        <div>
          <h1>{topic.title}</h1>
          <div class="row wrap">
            <span class="chip">{topic.level}</span>
            <span class="chip">{topic.hoursPerWeek} ч/нед</span>
            <span class="chip chip-accent">{progress.pct}% плана</span>
          </div>
        </div>
      </div>
      <button class="btn btn-sm btn-danger" onclick={removeTopic}>Удалить</button>
    </header>

    <nav class="tabs">
      <button class:active={tab === 'plan'} onclick={() => router.topic(id, 'plan')}>План</button>
      <button class:active={tab === 'chat'} onclick={() => router.topic(id, 'chat')}>Чат</button>
      <button class:active={tab === 'notes'} onclick={() => router.topic(id, 'notes')}>Конспекты</button>
    </nav>

    {#if tab === 'plan'}
      {#if plan}
        <div class="card">
          <PlanView {plan} onToggle={toggle} />
        </div>
      {:else}
        <div class="card empty">
          <p>Плана ещё нет — попросите наставника собрать его в чате.</p>
          <button class="btn btn-primary" onclick={() => router.topic(id, 'chat')}>
            Перейти в чат
          </button>
        </div>
      {/if}
    {:else if tab === 'chat'}
      <div class="chat card">
        <div class="thread" bind:this={thread}>
          {#if messages.length === 0 && !streaming}
            <div class="empty">
              <p>Спросите что угодно по теме «{topic.title}».</p>
              <div class="row wrap" style="justify-content: center">
                <button class="btn btn-sm" onclick={() => send('Объясни суть темы простыми словами')}>
                  Объясни суть
                </button>
                <button class="btn btn-sm" onclick={() => send('Дай первое упражнение по плану')}>
                  Дай упражнение
                </button>
                <button class="btn btn-sm" onclick={() => send('Проверь, что я уже понял: задай 3 вопроса')}>
                  Проверь меня
                </button>
              </div>
            </div>
          {/if}

          {#each messages as m (m.id)}
            <MessageBubble
              role={m.role}
              content={m.content}
              reasoning={m.reasoning ?? ''}
              citations={m.citations ?? []}
            />
          {/each}

          {#if streaming}
            <MessageBubble
              role="assistant"
              content={streamText}
              reasoning={streamReasoning}
              citations={streamCitations}
              streaming
            />
          {/if}

          {#if streamError}<div class="err">{streamError}</div>{/if}
        </div>

        <div class="chat-foot">
          <Composer
            onSend={send}
            onStop={stop}
            busy={streaming}
            disabled={streaming}
            placeholder="Спросить наставника…"
          />
          <div class="row-between tiny mute">
            <span>{memory ? 'Память о занятиях активна' : 'Память начнёт накапливаться по ходу занятий'}</span>
            <button class="btn btn-sm btn-ghost" onclick={saveLastAnswer}>Ответ → в конспекты</button>
          </div>
        </div>
      </div>
    {:else}
      <div class="col">
        <div class="card col">
          <label for="note">Новая заметка (Markdown)</label>
          <textarea id="note" bind:value={noteDraft} placeholder="Что запомнить по теме…"></textarea>
          <div class="row wrap">
            <button class="btn btn-primary btn-sm" onclick={addManualNote} disabled={!noteDraft.trim()}>
              Добавить
            </button>
            <button class="btn btn-sm" onclick={saveLastAnswer}>Сохранить последний ответ</button>
          </div>
        </div>

        {#if notes.length === 0}
          <div class="empty">Конспектов пока нет.</div>
        {/if}

        {#each notes as n (n.id)}
          <article class="card note">
            <div class="row-between" style="margin-bottom: 6px">
              <div class="mute tiny">{formatDate(n.createdAt)} · {n.source}</div>
              <button class="btn btn-sm btn-ghost" onclick={() => removeNote(n)}>Удалить</button>
            </div>
            <Markdown md={n.md} />
            {#if n.citations && n.citations.length > 0}
              <ul class="cites">
                {#each n.citations as c (c.url)}
                  <li>
                    <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title || c.url}</a>
                  </li>
                {/each}
              </ul>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .page {
    max-width: 920px;
    margin: 0 auto;
    padding-bottom: 12px;
  }

  .head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .head h1 {
    margin: 0 0 6px;
    font-size: 1.3rem;
  }

  .tabs {
    display: flex;
    gap: 4px;
    background: var(--bg-elev-2);
    padding: 4px;
    border-radius: var(--radius-s);
    margin-bottom: 14px;
    width: fit-content;
    max-width: 100%;
  }

  .tabs button {
    border: none;
    background: transparent;
    color: var(--text-dim);
    padding: 7px 14px;
    border-radius: 8px;
    font-weight: 550;
    font-size: 0.9rem;
  }

  .tabs button.active {
    background: var(--bg-elev);
    color: var(--text);
    box-shadow: var(--shadow);
  }

  .chat {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .thread {
    display: flex;
    flex-direction: column;
    min-height: 240px;
    max-height: min(58vh, 620px);
    overflow-y: auto;
    padding-right: 4px;
    scroll-behavior: smooth;
  }

  .chat-foot {
    border-top: 1px solid var(--border-soft);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
    margin-top: 8px;
    white-space: pre-wrap;
  }

  .note .cites {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 0.8rem;
  }

  @media (max-width: 640px) {
    .thread {
      max-height: none;
      min-height: 300px;
    }
  }
</style>


