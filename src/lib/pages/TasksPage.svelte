<script lang="ts">
  import TaskEditor from '../components/TaskEditor.svelte';
  import {
    addTask,
    allTasks,
    removeTask,
    toggleTaskDone,
    updateTask,
    type PlannerTask
  } from '../db/db';
  import { router } from '../router.svelte';
  import { sync } from '../sync/state.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { addDaysIso, formatDateHuman, todayIso } from '../utils/planner';
  import {
    WEEKDAY_LABELS,
    dayProgress,
    isTaskDone,
    nextTaskDate,
    repeatLabel,
    taskOccursOn,
    tasksForDay,
    weekdayIndex
  } from '../utils/tasks';

  let tasks = $state<PlannerTask[]>([]);
  let loading = $state(true);
  let selected = $state(todayIso());
  let editorOpen = $state(false);
  let editing = $state<PlannerTask | null>(null);

  const today = $derived(todayIso());
  /** Понедельник выбранной недели: неделя всегда начинается с пн. */
  const weekStart = $derived(addDaysIso(selected, -weekdayIndex(selected)));
  const week = $derived(Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)));
  const dayTasks = $derived(tasksForDay(tasks, selected));
  const progress = $derived(dayProgress(tasks, selected));
  const todayProgress = $derived(dayProgress(tasks, today));

  async function load(): Promise<void> {
    tasks = await allTasks();
    loading = false;
  }

  $effect(() => {
    // revision — синхронизация принесла чужие изменения.
    sync.revision;
    void load();
  });

  function pick(iso: string): void {
    selected = iso;
  }

  function shiftWeek(delta: number): void {
    selected = addDaysIso(selected, delta * 7);
  }

  function goToday(): void {
    selected = todayIso();
  }

  function openNew(): void {
    editing = null;
    editorOpen = true;
  }

  function openTask(task: PlannerTask): void {
    editing = task;
    editorOpen = true;
  }

  function closeEditor(): void {
    editorOpen = false;
    editing = null;
  }

  async function save(value: {
    title: string;
    notes: string;
    days: number[];
    onceDate: string;
    time: string;
  }): Promise<void> {
    const isEdit = Boolean(editing);
    try {
      if (editing) {
        await updateTask(editing.id, value);
      } else {
        const created = await addTask(value);
        // Дело на другой день не должно «пропасть» из виду сразу после создания.
        if (!taskOccursOn(created, selected)) {
          const next = nextTaskDate(created, selected);
          if (next) selected = next;
        }
      }
      editorOpen = false;
      editing = null;
      await load();
      toasts.success(isEdit ? 'Дело обновлено' : 'Дело добавлено');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(): Promise<void> {
    if (!editing) return;
    if (!confirm(`Удалить дело «${editing.title}»?`)) return;
    try {
      await removeTask(editing.id);
      editorOpen = false;
      editing = null;
      await load();
      toasts.success('Дело удалено');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggle(task: PlannerTask): Promise<void> {
    try {
      await toggleTaskDone(task.id, selected);
      await load();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Дела</h1>
      <p class="muted small">
        {#if loading}
          Загрузка…
        {:else}
          Сегодня сделано {todayProgress.done} из {todayProgress.total} — повторяющиеся дела
          отмечаются по дням.
        {/if}
      </p>
    </div>
    <div class="row wrap" style="gap: 8px">
      <button class="btn btn-sm" onclick={() => router.go('/assistant')}>Попросить помощника</button>
      <button class="btn btn-primary" onclick={openNew}>+ Дело</button>
    </div>
  </header>

  <div class="card week-card">
    <div class="row-between">
      <button class="btn btn-sm" onclick={() => shiftWeek(-1)} aria-label="Предыдущая неделя">←</button>
      <strong>{formatDateHuman(week[0])} — {formatDateHuman(week[6])}</strong>
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm" onclick={goToday}>Сегодня</button>
        <button class="btn btn-sm" onclick={() => shiftWeek(1)} aria-label="Следующая неделя">→</button>
      </div>
    </div>

    <div class="week">
      {#each week as iso, i (iso)}
        {@const list = tasks.filter((task) => taskOccursOn(task, iso))}
        {@const done = list.filter((task) => isTaskDone(task, iso)).length}
        <button
          class="day"
          class:today={iso === today}
          class:picked={iso === selected}
          onclick={() => pick(iso)}
          aria-label={`${iso}: дел ${list.length}, сделано ${done}`}
        >
          <span class="wd">{WEEKDAY_LABELS[i]}</span>
          <span class="num">{Number(iso.slice(8, 10))}</span>
          <span class="dot" class:full={list.length > 0 && done === list.length} class:some={done > 0 && done < list.length}></span>
        </button>
      {/each}
    </div>
  </div>

  <div class="card day-card">
    <div class="row-between">
      <strong>{selected === today ? 'Сегодня' : formatDateHuman(selected)}</strong>
      <span class="mute tiny">{progress.done} из {progress.total}</span>
    </div>

    {#if dayTasks.length === 0}
      <p class="mute small empty">На этот день дел нет. Добавьте дело или выберите другой день.</p>
    {:else}
      <ul class="list">
        {#each dayTasks as task (task.id)}
          {@const done = isTaskDone(task, selected)}
          <li class="item" class:done>
            <button
              class="tick"
              class:on={done}
              aria-pressed={done}
              aria-label={done ? 'Снять отметку' : 'Отметить выполненным'}
              onclick={() => toggle(task)}
            >
              {done ? '✓' : ''}
            </button>
            <button class="main" onclick={() => openTask(task)}>
              <span class="title">{task.title}</span>
              <span class="meta">
                {#if task.time}{task.time} · {/if}{repeatLabel(task.days, task.onceDate)}
                {#if task.notes} · {task.notes}{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Все дела</strong>
      <span class="mute tiny">{tasks.length}</span>
    </div>
    {#if tasks.length === 0}
      <p class="mute small empty">Пока пусто. Например: «зарядка каждый день в 8:00».</p>
    {:else}
      <ul class="list">
        {#each tasks as task (task.id)}
          <li class="item">
            <button class="main" onclick={() => openTask(task)}>
              <span class="title">{task.title}</span>
              <span class="meta">
                {repeatLabel(task.days, task.onceDate)}{task.time ? ` в ${task.time}` : ''} · отмечено {task.done.length} дн.
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<TaskEditor
  open={editorOpen}
  task={editing}
  defaultDate={selected}
  onSave={save}
  onClose={closeEditor}
  onDelete={remove}
/>

<style>
  .page {
    max-width: 920px;
    margin: 0 auto;
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

  .week-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
  }

  .week {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
  }

  .day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 2px 6px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-s);
    color: var(--text-dim);
  }

  .day.today {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border-soft));
  }

  .day.picked {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  .wd {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .num {
    font-size: 1rem;
    font-weight: 650;
  }

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: transparent;
  }

  .dot.some {
    background: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .dot.full {
    background: var(--accent);
  }

  .day-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-soft);
  }

  .item:last-child {
    border-bottom: none;
  }

  .tick {
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    margin-top: 2px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--bg-elev-2);
    color: #fff;
    font-size: 0.8rem;
    line-height: 1;
    display: grid;
    place-items: center;
  }

  .tick.on {
    background: var(--accent);
    border-color: transparent;
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: inherit;
  }

  .title {
    font-weight: 550;
  }

  .done .title {
    text-decoration: line-through;
    color: var(--text-mute);
  }

  .meta {
    font-size: 0.78rem;
    color: var(--text-mute);
    overflow-wrap: anywhere;
  }

  .empty {
    margin: 4px 0 0;
  }

  @media (max-width: 560px) {
    .num {
      font-size: 0.92rem;
    }

    .week {
      gap: 4px;
    }
  }
</style>
