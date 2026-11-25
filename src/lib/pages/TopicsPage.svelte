<script lang="ts">
  import { db, planProgress, type Plan, type Topic } from '../db/db';
  import { router } from '../router.svelte';
  import { sync } from '../sync/state.svelte';
  import { relativeTime } from '../utils/format';

  let topics = $state<Topic[]>([]);
  let plans = $state<Record<string, Plan>>({});
  let loading = $state(true);

  async function load(): Promise<void> {
    const [t, p] = await Promise.all([db.topics.toArray(), db.plans.toArray()]);
    topics = t.sort((a, b) => b.updatedAt - a.updatedAt);
    const map: Record<string, Plan> = {};
    for (const plan of p) map[plan.topicId] = plan;
    plans = map;
    loading = false;
  }

  $effect(() => {
    // revision меняется, когда синхронизация принесла чужие изменения.
    sync.revision;
    void load();
  });

  const active = $derived(topics.filter((t) => t.status === 'active'));
  const avg = $derived(
    topics.length === 0
      ? 0
      : Math.round(
          topics.reduce((acc, t) => acc + planProgress(plans[t.id]).pct, 0) / topics.length
        )
  );

  function open(t: Topic): void {
    router.topic(t.id, plans[t.id] ? 'plan' : 'chat');
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Мои темы</h1>
      <p class="muted small">
        {#if topics.length === 0}
          Пока пусто — создайте первую тему и наставник соберёт план.
        {:else}
          {active.length} активных · средний прогресс {avg}%
        {/if}
      </p>
    </div>
    <button class="btn btn-primary" onclick={() => router.go('/new')}>+ Новая тема</button>
  </header>

  {#if loading}
    <div class="empty">Загрузка…</div>
  {:else if topics.length === 0}
    <div class="card empty">
      <p>Тема — это то, что вы хотите освоить: «SQL для аналитика», «Основы фотографии», «Английский до B2».</p>
      <button class="btn btn-primary" onclick={() => router.go('/new')}>Создать тему</button>
    </div>
  {:else}
    <div class="grid">
      {#each topics as t (t.id)}
        {@const prog = planProgress(plans[t.id])}
        <button class="topic" onclick={() => open(t)}>
          <div class="row-between">
            <span class="chip">{t.level}</span>
            <span class="mute tiny">{relativeTime(t.updatedAt)}</span>
          </div>
          <h3>{t.title}</h3>
          <p class="muted small goal">{t.goal}</p>
          <div class="bar"><div class="bar-fill" style="width: {prog.pct}%"></div></div>
          <div class="row-between small mute">
            <span>{prog.done} / {prog.total} пунктов</span>
            <span>{prog.pct}%</span>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    padding-bottom: 24px;
  }

  .page-head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }

  .page-head p {
    margin: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }

  .topic {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-m);
    padding: 14px;
    transition: border-color 0.15s ease, transform 0.1s ease;
  }

  .topic:hover {
    border-color: var(--accent);
  }

  .topic h3 {
    margin: 0;
    font-size: 1.05rem;
  }

  .goal {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 2.6em;
  }

  .bar {
    height: 5px;
    border-radius: 999px;
    background: var(--bg-elev-2);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--accent);
  }
</style>
