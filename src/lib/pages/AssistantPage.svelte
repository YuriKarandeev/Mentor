<script lang="ts">
  import { onMount } from 'svelte';
  import { plannerTurn } from '../api/agent';
  import { ApiError } from '../api/deepseek';
  import {
    applyPlannerActions,
    describePlannerActions,
    type EventChangeSet,
    type TaskChangeSet
  } from '../api/planner-actions';
  import {
    applyBudgetActions,
    describeBudgetActions,
    type AssetChangeSet,
    type TransactionChangeSet
  } from '../api/budget-actions';
  import { buildBudgetPrompt, buildPlannerContext } from '../api/prompts';
  import {
    allAccounts,
    allAssets,
    allCategories,
    allEvents,
    allObligations,
    allTasks,
    allTransactions,
    applyBudgetChanges,
    applyPlannerChanges,
    ensureBudgetDefaults
  } from '../db/db';
  import { router } from '../router.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';
  import Markdown from '../components/Markdown.svelte';
  import Composer from '../components/Composer.svelte';

  interface ChatNote {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    /** Подписи применённых действий, например «Добавить событие «…»». */
    actions?: string[];
    /** Что пропущено: несуществующий id, битая дата, лимит действий. */
    skipped?: string[];
    /** Обратные операции для кнопки «Отменить» — календарь и деньги вместе. */
    undo?: {
      events: EventChangeSet;
      tasks: TaskChangeSet;
      transactions: TransactionChangeSet;
      assets: AssetChangeSet;
    };
    undone?: boolean;
    error?: string;
  }

  const SUGGESTIONS = [
    'Что у меня на этой неделе?',
    'Поставь на завтра в 18:00 занятие по SQL',
    'Добавь дело «зарядка» каждый день в 8:00',
    'Запиши расход 500 ₽ на продукты',
    'Сколько у меня на карте?'
  ];

  let messages = $state<ChatNote[]>([]);
  let busy = $state(false);
  let thread = $state<HTMLDivElement | null>(null);
  let abort: AbortController | null = null;
  let seq = 0;

  /** Счетов нет — записывать траты некуда: подскажем до первого запроса. */
  let noAccounts = $state(false);

  onMount(async () => {
    await ensureBudgetDefaults();
    noAccounts = (await allAccounts()).every((account) => account.archived);
  });

  const nextId = (): string => `m${++seq}`;

  const configured = $derived(settings.configured);

  function scrollDown(): void {
    requestAnimationFrame(() => {
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
  }

  $effect(() => {
    messages.length;
    scrollDown();
  });

  async function send(text: string): Promise<void> {
    if (busy || !text.trim()) return;
    const user: ChatNote = { id: nextId(), role: 'user', text: text.trim() };
    // В модель уходит только текст реплик: подписи действий — это UI-слой.
    const history = [...messages.filter((m) => !m.error), user].map((m) => ({
      role: m.role,
      content: m.text
    }));
    messages = [...messages, user];
    busy = true;
    abort = new AbortController();

    try {
      const [events, tasks, accounts, categories, obligations, transactions, assets] =
        await Promise.all([
          allEvents(),
          allTasks(),
          allAccounts(),
          allCategories(),
          allObligations(),
          allTransactions(),
          allAssets()
        ]);
      const result = await plannerTurn({
        settings: settings.data,
        context: {
          ...buildPlannerContext({ events, tasks }),
          budget: buildBudgetPrompt({ accounts, categories, obligations, transactions })
        },
        history,
        signal: abort.signal
      });

      const plan = applyPlannerActions(result.actions, { events, tasks });
      const money = applyBudgetActions(result.moneyActions, {
        accounts,
        categories,
        obligations,
        assets
      });

      const plannerChanges = plan.changes;
      const moneyChanges = money.changes;
      const touched =
        plannerChanges.events.put.length +
        plannerChanges.events.remove.length +
        plannerChanges.tasks.put.length +
        plannerChanges.tasks.remove.length +
        moneyChanges.transactions.put.length +
        moneyChanges.transactions.remove.length +
        moneyChanges.assets.put.length;
      if (plan.applied.length > 0) await applyPlannerChanges(plannerChanges);
      if (money.applied.length > 0) await applyBudgetChanges(moneyChanges);

      const applied = plan.applied.length + money.applied.length;
      const skipped = [...plan.skipped, ...money.skipped];
      const labels = [
        ...describePlannerActions(result.actions, { events, tasks }),
        ...describeBudgetActions(result.moneyActions, { accounts, categories, obligations, assets })
      ];

      const note: ChatNote = {
        id: nextId(),
        role: 'assistant',
        text: result.reply,
        actions: applied > 0 ? labels : undefined,
        skipped: skipped.length > 0 ? skipped : undefined,
        undo:
          applied > 0
            ? {
                events: plan.undo.events,
                tasks: plan.undo.tasks,
                transactions: money.undo.transactions,
                assets: money.undo.assets
              }
            : undefined,
        error: result.error
      };
      messages = [...messages, note];

      if (applied > 0) toasts.success(`Записано изменений: ${touched}`);
    } catch (e) {
      const message =
        (e as Error)?.name === 'AbortError'
          ? 'Запрос остановлен.'
          : e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
      messages = [
        ...messages,
        { id: nextId(), role: 'assistant', text: '', error: message }
      ];
    } finally {
      busy = false;
      abort = null;
    }
  }

  function stop(): void {
    abort?.abort();
  }

  async function undo(note: ChatNote): Promise<void> {
    if (!note.undo || note.undone) return;
    try {
      await applyPlannerChanges({ events: note.undo.events, tasks: note.undo.tasks });
      await applyBudgetChanges({
        transactions: note.undo.transactions,
        assets: note.undo.assets
      });
      messages = messages.map((m) => (m.id === note.id ? { ...m, undone: true } : m));
      toasts.success('Изменения отменены');
    } catch (e) {
      toasts.error(`Не удалось отменить: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Помощник календаря, дел и бюджета</h1>
      <p class="muted small">
        Спросите словами — события, дела и траты появятся в приложении. Любую пачку изменений можно отменить.
      </p>
    </div>
    <div class="row wrap">
      <button class="btn btn-sm" onclick={() => router.go('/calendar')}>Календарь</button>
      <button class="btn btn-sm" onclick={() => router.go('/budget')}>Бюджет</button>
    </div>
  </header>

  {#if !configured}
    <div class="card setup">
      Подключение к DeepSeek не настроено — помощник не сможет ответить.
      <button class="btn btn-sm btn-primary" onclick={() => router.go('/settings')}>Настроить</button>
    </div>
  {/if}

  {#if noAccounts}
    <div class="card setup">
      Записывать траты некуда: в бюджете нет ни одного счёта.
      <button class="btn btn-sm" onclick={() => router.go('/budget')}>Открыть бюджет</button>
    </div>
  {/if}

  <div class="chat card">
    <div class="thread" bind:this={thread}>
      {#if messages.length === 0}
        <div class="empty">
          <p>Например:</p>
          <div class="row wrap">
            {#each SUGGESTIONS as s (s)}
              <button class="btn btn-sm" onclick={() => send(s)} disabled={busy || !configured}>{s}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as m (m.id)}
        <div class="msg {m.role}">
          <div class="avatar">{m.role === 'user' ? 'Я' : '🗓'}</div>
          <div class="body">
            {#if m.text}
              {#if m.role === 'assistant'}
                <Markdown md={m.text} />
              {:else}
                <p class="plain">{m.text}</p>
              {/if}
            {/if}

            {#if m.actions && m.actions.length > 0}
              <ul class="acts">
                {#each m.actions as a, i (i)}<li>{a}</li>{/each}
              </ul>
            {/if}

            {#if m.skipped && m.skipped.length > 0}
              <ul class="skips">
                {#each m.skipped as s, i (i)}<li>{s}</li>{/each}
              </ul>
            {/if}

            {#if m.error}<div class="err">{m.error}</div>{/if}

            {#if m.undo && !m.undone}
              <button class="btn btn-sm btn-ghost undo" onclick={() => undo(m)}>Отменить изменения</button>
            {:else if m.undone}
              <span class="mute tiny">Изменения отменены</span>
            {/if}
          </div>
        </div>
      {/each}

      {#if busy}
        <div class="msg assistant">
          <div class="avatar">🗓</div>
          <div class="body">
            <div class="typing"><span></span><span></span><span></span></div>
          </div>
        </div>
      {/if}
    </div>

    <div class="chat-foot">
      <Composer
        onSend={send}
        onStop={stop}
        busy={busy}
        disabled={busy || !configured}
        placeholder="Например: поставь на завтра созвон в 10:00"
      />
      <p class="mute tiny hint">
        Помощник видит ближайшие 14 дней, события, дела с повтором, счета и платежи — и меняет только их.
      </p>
    </div>
  </div>
</div>

<style>
  .page {
    max-width: 920px;
    margin: 0 auto;
    padding-bottom: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page-head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .page-head h1 {
    margin: 0 0 4px;
    font-size: 1.3rem;
  }

  .page-head p {
    margin: 0;
  }

  .setup {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-s);
    padding: 10px 14px;
    font-size: 0.9rem;
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
    min-height: 260px;
    max-height: min(62vh, 660px);
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

  .hint {
    margin: 0;
  }

  .empty {
    padding: 12px 0;
  }

  .empty p {
    margin: 0 0 8px;
    color: var(--text-mute);
  }

  .msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 0;
  }

  .avatar {
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 0.78rem;
    font-weight: 700;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
  }

  .assistant .avatar {
    background: var(--accent-soft);
    border-color: transparent;
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .user .body {
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-m);
    padding: 10px 14px;
    gap: 0;
  }

  .plain {
    margin: 0;
    white-space: pre-wrap;
  }

  .acts,
  .skips {
    margin: 0;
    padding-left: 18px;
    font-size: 0.86rem;
  }

  .acts li::marker {
    color: var(--accent);
  }

  .skips {
    color: var(--text-mute);
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
    white-space: pre-wrap;
  }

  .undo {
    align-self: flex-start;
  }

  .typing {
    display: inline-flex;
    gap: 4px;
    padding: 6px 0;
  }

  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.2s infinite ease-in-out;
  }

  .typing span:nth-child(2) {
    animation-delay: 0.18s;
  }

  .typing span:nth-child(3) {
    animation-delay: 0.36s;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 0.25;
      transform: translateY(0);
    }
    50% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }

  @media (max-width: 640px) {
    .thread {
      max-height: none;
      min-height: 300px;
    }
  }
</style>

