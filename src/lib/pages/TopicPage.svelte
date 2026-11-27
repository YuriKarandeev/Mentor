<script lang="ts">
  import Composer from '../components/Composer.svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import NoteCard from '../components/NoteCard.svelte';
  import PlanView from '../components/PlanView.svelte';
  import {
    extractProfilePatch,
    itemSummaryMessages,
    mentorMessages,
    streamTurn,
    summarizeConversation
  } from '../api/agent';
  import { describeStreamError } from '../api/stream-error';
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
    updateNote,
    type Citation,
    type Note,
    type Plan,
    type PlanItem,
    type StoredMessage,
    type Topic
  } from '../db/db';
  import { router, type TopicTab } from '../router.svelte';
  import { profile } from '../stores/profile.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { sync } from '../sync/state.svelte';
  import { plainText } from '../utils/markdown';
  import { findItemNote, findPlanItem, itemTag, summarisedItemIds } from '../utils/plan-note';
  import { untrack } from 'svelte';

  let { id, tab }: { id: string; tab: TopicTab } = $props();

  let topic = $state<Topic | null>(null);
  let plan = $state<Plan | undefined>(undefined);
  let messages = $state<StoredMessage[]>([]);
  let notes = $state<Note[]>([]);
  let memory = $state('');
  let loading = $state(true);
  /** Раскрытые конспекты (по id): по умолчанию все свёрнуты до названия. */
  let expandedIds = $state<Record<string, boolean>>({});

  let streaming = $state(false);
  let streamText = $state('');
  let streamReasoning = $state('');
  let streamCitations = $state<Citation[]>([]);
  let streamError = $state('');
  let abort: AbortController | null = null;
  let thread = $state<HTMLDivElement | null>(null);

  let noteDraft = $state('');
  /** Тема, для которой сейчас показан список конспектов. */
  let lastTopicId = '';

  /** Открытый пункт плана: под ним показывается конспект по заданию. */
  let openItemId = $state<string | null>(null);
  let itemText = $state('');
  let itemCached = $state(false);
  let itemBusy = $state(false);
  let itemError = $state('');
  let itemCitations = $state<Citation[]>([]);
  /** Номер генерации: ответ отменённого запроса не должен трогать состояние. */
  let itemRun = 0;
  let itemAbort: AbortController | null = null;
  /** Пункты, для которых конспект уже сохранён — в плане показываем метку. */
  const summarised = $derived(summarisedItemIds(notes));

  $effect(() => {
    const topicId = id;
    // При переходе в другую тему список конспектов начинается свёрнутым:
    // компонент не перемонтируется, поэтому состояние чистим руками.
    if (topicId !== lastTopicId) {
      lastTopicId = topicId;
      expandedIds = {};
      closeItem();
    }
    // Перечитываем данные, когда синхронизация принесла чужие изменения,
    // но не во время стриминга ответа, чтобы не сбить генерацию.
    const revision = sync.revision;
    if (revision > 0 && untrack(() => streaming || itemBusy)) return;
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
      if (result.interrupted) {
        toasts.info('Ответ пришёл не до конца — сохранил то, что успело прийти');
      }
      void maybeUpdateMemory();
    } catch (e) {
      const partial = streamText.trim();
      if ((e as Error)?.name === 'AbortError') {
        streamError = partial ? 'Генерация остановлена. Полученный текст сохранён.' : 'Генерация остановлена.';
      } else {
        streamError = describeStreamError(e, {
          stage: partial ? 'stream' : 'connect',
          suffix: partial ? 'Полученный текст сохранён.' : ''
        });
      }
      // Частичный ответ уже оплачен токенами — сохраняем его как сообщение.
      if (partial) {
        const saved = await addMessage({
          topicId: t.id,
          role: 'assistant',
          content: partial,
          reasoning: streamReasoning || undefined,
          citations: streamCitations
        });
        messages = [...messages, saved];
        streamText = '';
        streamReasoning = '';
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

  /** Клик по заданию: раскрыть его конспект из кэша или собрать заново. */
  async function openItem(itemId: string): Promise<void> {
    if (openItemId === itemId) {
      closeItem();
      return;
    }
    if (!findPlanItem(plan, itemId)) return;
    // Переключение на другой пункт останавливает текущую генерацию:
    // иначе её текст дописывался бы в чужую карточку.
    cancelItemRun();
    openItemId = itemId;
    itemError = '';
    const cached = findItemNote(notes, itemId);
    if (cached) {
      itemText = cached.md;
      itemCitations = cached.citations ?? [];
      itemCached = true;
      return;
    }
    itemText = '';
    itemCitations = [];
    itemCached = false;
    await generateItem(itemId);
  }

  /** Генерация конспекта пункта: текст печатается по мере ответа модели. */
  async function generateItem(itemId: string): Promise<void> {
    const t = topic;
    const p = plan;
    if (!t || !p) return;
    const target = findPlanItem(p, itemId);
    if (!target) return;

    cancelItemRun();
    const run = ++itemRun;
    itemBusy = true;
    itemError = '';
    itemText = '';
    itemCached = false;
    const controller = new AbortController();
    itemAbort = controller;

    try {
      const result = await streamTurn({
        settings: settings.data,
        messages: itemSummaryMessages(t, p, target.module, target.item, profile.data),
        signal: controller.signal,
        handlers: {
          onDelta: (d) => {
            if (run === itemRun) itemText += d;
          },
          onCitations: (c) => {
            if (run === itemRun) itemCitations = c;
          }
        }
      });
      if (run !== itemRun) return;

      const md = (result.content || itemText).trim();
      if (!md) {
        itemError = 'Модель вернула пустой конспект. Попробуйте пересобрать.';
        return;
      }
      const cites = result.citations.length ? result.citations : itemCitations;
      itemText = md;
      itemCitations = cites;
      await saveItemNote(target.item, md, cites);
      itemCached = true;
      if (result.interrupted) toasts.info('Конспект пришёл не до конца — сохранил как есть');
    } catch (e) {
      if (run !== itemRun) return;
      if ((e as Error)?.name === 'AbortError') {
        itemError = itemText.trim()
          ? 'Генерация остановлена. Текст не сохранён — «Пересобрать» начнёт заново.'
          : 'Генерация остановлена.';
      } else {
        itemError = describeStreamError(e, { stage: itemText ? 'stream' : 'connect' });
      }
    } finally {
      if (run === itemRun) {
        itemBusy = false;
        itemAbort = null;
      }
    }
  }

  /** Конспект пункта живёт как заметка темы: повторная сборка её перезаписывает. */
  async function saveItemNote(item: PlanItem, md: string, cites: Citation[]): Promise<void> {
    const t = topic;
    if (!t) return;
    const existing = findItemNote(notes, item.id);
    if (existing) {
      const updated = await updateNote(existing.id, {
        title: item.title,
        md,
        citations: cites.length ? cites : existing.citations
      });
      if (updated) {
        notes = notes.map((n) => (n.id === updated.id ? updated : n));
        expandedIds[updated.id] = true;
      }
      return;
    }
    const created = await addNote({
      topicId: t.id,
      title: item.title,
      md,
      source: 'chat',
      tags: [itemTag(item.id)],
      citations: cites.length ? cites : undefined
    });
    notes = [created, ...notes];
    expandedIds[created.id] = true;
  }

  function regenerateItem(): void {
    if (openItemId) void generateItem(openItemId);
  }

  function stopItem(): void {
    itemAbort?.abort();
  }

  /** Гасим текущую генерацию: старые колбэки больше не меняют состояние. */
  function cancelItemRun(): void {
    itemAbort?.abort();
    itemAbort = null;
    itemRun += 1;
    itemBusy = false;
  }

  function closeItem(): void {
    cancelItemRun();
    openItemId = null;
    itemText = '';
    itemCitations = [];
    itemError = '';
    itemCached = false;
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
    expandedIds[n.id] = true;
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
    expandedIds[n.id] = true;
    noteDraft = '';
  }

  function toggleNote(noteId: string): void {
    expandedIds[noteId] = !expandedIds[noteId];
  }

  async function removeNote(note: Note): Promise<void> {
    await deleteNote(note.id);
    notes = notes.filter((n) => n.id !== note.id);
    delete expandedIds[note.id];
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
          <PlanView
            {plan}
            onToggle={toggle}
            {openItemId}
            summaryIds={summarised}
            onOpenItem={openItem}
            {itemText}
            {itemBusy}
            {itemError}
            {itemCached}
            itemCitations={itemCitations}
            onRegenerate={regenerateItem}
            onStop={stopItem}
            onClose={closeItem}
          />
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
        {:else}
          <p class="mute tiny hint">Нажмите на название, чтобы раскрыть конспект.</p>
        {/if}

        {#each notes as n (n.id)}
          <NoteCard
            note={n}
            open={!!expandedIds[n.id]}
            onToggle={() => toggleNote(n.id)}
            onRemove={() => removeNote(n)}
          />
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

  .hint {
    margin: 0;
  }

  @media (max-width: 640px) {
    .thread {
      max-height: none;
      min-height: 300px;
    }
  }
</style>


