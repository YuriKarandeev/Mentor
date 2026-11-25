<script lang="ts">
  import Composer from '../components/Composer.svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import { planStep } from '../api/agent';
  import { ApiError } from '../api/deepseek';
  import type { ApiMessage } from '../api/types';
  import { createTopic, savePlan, type Level, type Topic } from '../db/db';
  import { router } from '../router.svelte';
  import { profile } from '../stores/profile.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';

  type UiMessage = { role: 'user' | 'assistant'; content: string; error?: string };

  let stage = $state<'form' | 'dialog'>('form');
  let title = $state('');
  let goal = $state('');
  let level = $state<Level>('новичок');
  let hours = $state(5);
  let formError = $state('');

  let draft = $state<Topic | null>(null);
  let ui = $state<UiMessage[]>([]);
  let history = $state<ApiMessage[]>([]);
  let busy = $state(false);
  let planError = $state('');
  let abort: AbortController | null = null;

  const LEVELS: Level[] = ['новичок', 'средний', 'продвинутый'];

  function start(): void {
    formError = '';
    if (title.trim().length < 3) {
      formError = 'Название темы — минимум 3 символа';
      return;
    }
    if (!settings.configured) {
      formError = 'Сначала укажите адрес прокси в настройках';
      return;
    }
    draft = {
      id: 'draft',
      title: title.trim(),
      goal: goal.trim(),
      level,
      hoursPerWeek: hours,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dirty: 1
    };
    stage = 'dialog';
    const intro = `Хочу освоить: ${draft.title}. Цель: ${draft.goal || 'пока не сформулирована'}. Уровень: ${level}. Могу уделять ${hours} ч в неделю.`;
    void send(intro);
  }

  async function send(text: string): Promise<void> {
    if (!draft || busy) return;
    ui = [...ui, { role: 'user', content: text }];
    history = [...history, { role: 'user', content: text }];
    busy = true;
    planError = '';
    abort = new AbortController();

    try {
      const result = await planStep({
        settings: settings.data,
        topic: draft,
        profile: profile.data,
        history,
        signal: abort.signal
      });

      if (result.plan) {
        const topic = await createTopic({
          title: draft.title,
          goal: draft.goal,
          level: draft.level,
          hoursPerWeek: draft.hoursPerWeek
        });
        await savePlan(topic.id, result.plan);
        toasts.success('План готов — начинаем!');
        router.topic(topic.id, 'plan');
        return;
      }

      const reply = result.content.trim() || 'Не получил ответа. Попробуйте переформулировать.';
      ui = [...ui, { role: 'assistant', content: reply }];
      history = [...history, { role: 'assistant', content: reply }];
      if (result.error) planError = `Структура плана не прошла проверку: ${result.error}`;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      ui = [...ui, { role: 'assistant', content: '', error: `Ошибка: ${msg}` }];
    } finally {
      busy = false;
      abort = null;
    }
  }

  function cancel(): void {
    abort?.abort();
    busy = false;
  }
</script>

<div class="page">
  <header class="page-head">
    <button class="btn btn-sm btn-ghost" onclick={() => router.go('/')}>← Назад</button>
    <h1>Новая тема</h1>
  </header>

  {#if stage === 'form'}
    <div class="card col" style="max-width: 620px">
      <div>
        <label for="t">Что хотите освоить?</label>
        <input id="t" bind:value={title} placeholder="Например: SQL для аналитика" />
      </div>

      <div>
        <label for="g">Цель (что должно получиться)</label>
        <textarea
          id="g"
          bind:value={goal}
          placeholder="Например: писать запросы с JOIN и агрегатами для отчётов на работе"
        ></textarea>
      </div>

      <div class="row wrap">
        <div class="grow">
          <label for="l">Уровень</label>
          <select id="l" bind:value={level}>
            {#each LEVELS as l (l)}
              <option value={l}>{l}</option>
            {/each}
          </select>
        </div>
        <div class="grow">
          <label for="h">Часов в неделю</label>
          <input id="h" type="number" min="1" max="40" bind:value={hours} />
        </div>
      </div>

      {#if formError}<div class="err">{formError}</div>{/if}

      <button class="btn btn-primary" onclick={start}>Обсудить с наставником →</button>
      <p class="mute tiny">
        Дальше наставник задаст 1–3 уточняющих вопроса и соберёт структурированный план.
      </p>
    </div>
  {:else}
    <div class="card dialog">
      <div class="dialog-head row-between">
        <div>
          <strong>{draft?.title}</strong>
          <div class="mute tiny">{draft?.level} · {draft?.hoursPerWeek} ч/нед</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick={() => (stage = 'form')}>Изменить</button>
      </div>

      <div class="thread">
        {#each ui as m, i (i)}
          <MessageBubble role={m.role} content={m.content} error={m.error ?? ''} />
        {/each}
        {#if busy}<MessageBubble role="assistant" content="" streaming />{/if}
      </div>

      {#if planError}<div class="err">{planError}</div>{/if}

      <Composer
        onSend={send}
        onStop={cancel}
        {busy}
        disabled={busy}
        placeholder="Уточните цель, опыт, сроки…"
      />
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 860px;
    margin: 0 auto;
  }

  .page-head {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 16px;
  }

  .page-head h1 {
    margin: 0;
    font-size: 1.25rem;
  }

  .dialog {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .dialog-head {
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 10px;
  }

  .thread {
    display: flex;
    flex-direction: column;
    max-height: min(58vh, 560px);
    overflow-y: auto;
    padding-right: 4px;
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

