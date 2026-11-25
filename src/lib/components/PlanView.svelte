<script lang="ts">
  import type { Plan } from '../db/db';
  import { planProgress } from '../db/db';
  import { formatMinutes } from '../utils/format';

  let {
    plan,
    onToggle
  }: {
    plan: Plan;
    onToggle: (moduleId: string, itemId: string) => void;
  } = $props();

  const stats = $derived(planProgress(plan));
  const totalMin = $derived(
    plan.modules.reduce((acc, m) => acc + m.items.reduce((s, i) => s + i.estMin, 0), 0)
  );

  const KIND_LABEL: Record<string, string> = {
    theory: 'теория',
    practice: 'практика',
    check: 'проверка'
  };
</script>

<div class="plan">
  <div class="head">
    <div>
      <h2>{plan.title}</h2>
      {#if plan.summary}<p class="muted small">{plan.summary}</p>{/if}
    </div>
    <div class="row wrap">
      <span class="chip">{stats.done} / {stats.total}</span>
      <span class="chip">{formatMinutes(totalMin)}</span>
      <span class="chip chip-accent">{stats.pct}%</span>
    </div>
  </div>

  <div class="bar"><div class="bar-fill" style="width: {stats.pct}%"></div></div>

  {#each plan.modules as mod, mi (mod.id)}
    <section class="module">
      <header class="mod-head">
        <span class="num">{mi + 1}</span>
        <div class="grow">
          <h3>{mod.title}</h3>
          {#if mod.goal}<p class="mute small">{mod.goal}</p>{/if}
        </div>
      </header>

      <ul class="items">
        {#each mod.items as item (item.id)}
          <li class:done={item.done}>
            <label class="check">
              <input
                type="checkbox"
                checked={item.done}
                onchange={() => onToggle(mod.id, item.id)}
              />
              <span class="title">{item.title}</span>
            </label>
            <span class="meta">
              <span class="chip tiny">{KIND_LABEL[item.kind] ?? item.kind}</span>
              <span class="mute tiny">{formatMinutes(item.estMin)}</span>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .head p {
    margin: 0;
  }

  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-elev-2);
    overflow: hidden;
    margin-bottom: 18px;
  }

  .bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.25s ease;
  }

  .module {
    border-top: 1px solid var(--border-soft);
    padding: 14px 0 4px;
  }

  .mod-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-bottom: 8px;
  }

  .mod-head p {
    margin: 0;
  }

  .num {
    flex: 0 0 26px;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    display: grid;
    place-items: center;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .items {
    list-style: none;
    margin: 0;
    padding: 0 0 0 36px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .items li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 6px 8px;
    border-radius: var(--radius-s);
  }

  .items li:hover {
    background: var(--bg-elev-2);
  }

  .check {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    margin: 0;
    cursor: pointer;
    font-size: 0.94rem;
    color: var(--text);
    flex: 1;
    min-width: 0;
  }

  .check input {
    width: 18px;
    height: 18px;
    margin-top: 2px;
    flex: 0 0 auto;
    accent-color: var(--accent);
  }

  .done .title {
    text-decoration: line-through;
    color: var(--text-mute);
  }

  .meta {
    display: flex;
    gap: 6px;
    align-items: center;
    flex: 0 0 auto;
  }

  @media (max-width: 640px) {
    .items {
      padding-left: 6px;
    }
    .meta .chip {
      display: none;
    }
  }
</style>
