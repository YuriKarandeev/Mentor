<script lang="ts">
  import EventEditor from '../components/EventEditor.svelte';
  import { addEvent, eventsBetween, removeEvent, updateEvent, type PlannerEvent } from '../db/db';
  import { toasts } from '../stores/toast.svelte';
  import { sync } from '../sync/state.svelte';
  import {
    addDaysIso,
    compareEvents,
    eventTimeLabel,
    formatDateHuman,
    todayIso
  } from '../utils/planner';

  const MONTHS = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь'
  ];
  const WEEK_HEAD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  interface Cell {
    iso: string;
    day: number;
    inMonth: boolean;
  }

  function firstOfMonth(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  let cursor = $state(firstOfMonth(new Date()));
  let selected = $state(todayIso());
  let events = $state<PlannerEvent[]>([]);
  let loading = $state(true);

  let editorOpen = $state(false);
  let editing = $state<PlannerEvent | null>(null);
  let editorDate = $state('');

  const monthTitle = $derived.by(() => {
    const [year, month] = cursor.split('-');
    return `${MONTHS[Number(month) - 1]} ${year}`;
  });

  const cells = $derived.by<Cell[]>(() => {
    const first = new Date(`${cursor}T12:00:00`);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    // Понедельник — первый столбец: у Date воскресенье = 0.
    const offset = (first.getDay() + 6) % 7;
    const total = Math.ceil((offset + daysInMonth) / 7) * 7;
    const out: Cell[] = [];
    for (let i = 0; i < total; i += 1) {
      const iso = addDaysIso(cursor, i - offset);
      out.push({ iso, day: Number(iso.slice(8, 10)), inMonth: iso.slice(0, 7) === cursor.slice(0, 7) });
    }
    return out;
  });

  const byDate = $derived.by<Record<string, PlannerEvent[]>>(() => {
    const map: Record<string, PlannerEvent[]> = {};
    for (const ev of events) (map[ev.date] ??= []).push(ev);
    for (const key of Object.keys(map)) map[key].sort(compareEvents);
    return map;
  });

  const dayEvents = $derived(byDate[selected] ?? []);
  const today = $derived(todayIso());

  async function load(): Promise<void> {
    const from = addDaysIso(cursor, -7);
    const to = addDaysIso(cursor, 45);
    events = await eventsBetween(from, to);
    loading = false;
  }

  $effect(() => {
    // revision — синхронизация принесла чужие изменения; cursor — листаем месяц.
    sync.revision;
    cursor;
    void load();
  });

  function shiftMonth(delta: number): void {
    const d = new Date(`${cursor}T12:00:00`);
    d.setMonth(d.getMonth() + delta);
    cursor = firstOfMonth(d);
    selected = todayIso().slice(0, 7) === cursor.slice(0, 7) ? todayIso() : cursor;
  }

  function goToday(): void {
    const t = todayIso();
    cursor = firstOfMonth(new Date());
    selected = t;
  }

  function pickDay(iso: string): void {
    selected = iso;
    if (iso.slice(0, 7) !== cursor.slice(0, 7)) cursor = `${iso.slice(0, 7)}-01`;
  }

  function openNew(date = selected): void {
    editing = null;
    editorDate = date;
    editorOpen = true;
  }

  function openEvent(ev: PlannerEvent): void {
    editing = ev;
    editorDate = ev.date;
    editorOpen = true;
  }

  function closeEditor(): void {
    editorOpen = false;
    editing = null;
  }

  async function save(value: {
    title: string;
    date: string;
    time: string;
    endTime: string;
    allDay: boolean;
    notes: string;
  }): Promise<void> {
    const isEdit = Boolean(editing);
    try {
      if (editing) await updateEvent(editing.id, value);
      else await addEvent(value);
      editorOpen = false;
      editing = null;
      if (value.date.slice(0, 7) !== cursor.slice(0, 7)) cursor = `${value.date.slice(0, 7)}-01`;
      selected = value.date;
      await load();
      toasts.success(isEdit ? 'Событие обновлено' : 'Событие добавлено');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(): Promise<void> {
    if (!editing) return;
    if (!confirm(`Удалить событие «${editing.title}»?`)) return;
    try {
      await removeEvent(editing.id);
      editorOpen = false;
      editing = null;
      await load();
      toasts.success('Событие удалено');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Календарь</h1>
      <p class="muted small">
        {loading ? 'Загрузка…' : `${events.length} событий в поле зрения`}
      </p>
    </div>
    <button class="btn btn-primary" onclick={() => openNew()}>+ Событие</button>
  </header>

  <div class="card month">
    <div class="row-between month-head">
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm" onclick={() => shiftMonth(-1)} aria-label="Предыдущий месяц">←</button>
        <button class="btn btn-sm" onclick={goToday}>Сегодня</button>
        <button class="btn btn-sm" onclick={() => shiftMonth(1)} aria-label="Следующий месяц">→</button>
      </div>
      <strong>{monthTitle}</strong>
      <span class="mute tiny">{selected === today ? 'выбран сегодняшний день' : formatDateHuman(selected)}</span>
    </div>

    <div class="week-head">
      {#each WEEK_HEAD as w (w)}<span>{w}</span>{/each}
    </div>

    <div class="grid">
      {#each cells as c (c.iso)}
        {@const list = byDate[c.iso] ?? []}
        <button
          class="cell"
          class:dim={!c.inMonth}
          class:today={c.iso === today}
          class:picked={c.iso === selected}
          onclick={() => pickDay(c.iso)}
          aria-label={`${c.iso}: событий ${list.length}`}
        >
          <span class="num">{c.day}</span>
          {#if list.length > 0}
            <span class="dots">
              {#each list.slice(0, 3) as ev (ev.id)}
                <i class:timed={!ev.allDay}></i>
              {/each}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <section class="card day">
    <div class="row-between">
      <h2>{formatDateHuman(selected)}</h2>
      <button class="btn btn-sm" onclick={() => openNew(selected)}>+ В этот день</button>
    </div>

    {#if dayEvents.length === 0}
      <p class="mute small empty">Событий нет — свободный день.</p>
    {:else}
      <ul class="events">
        {#each dayEvents as ev (ev.id)}
          <li>
            <button class="event" onclick={() => openEvent(ev)}>
              <span class="time">{eventTimeLabel(ev)}</span>
              <span class="body">
                <strong>{ev.title}</strong>
                {#if ev.notes}<span class="mute tiny notes">{ev.notes}</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<EventEditor
  open={editorOpen}
  event={editing}
  defaultDate={editorDate}
  onSave={save}
  onClose={closeEditor}
  onDelete={editing ? remove : undefined}
/>

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

  .month {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .month-head {
    gap: 8px;
    flex-wrap: wrap;
  }

  .week-head {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    text-align: center;
    font-size: 0.72rem;
    color: var(--text-mute);
    text-transform: lowercase;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }

  .cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 46px;
    padding: 4px 2px;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: var(--bg-elev-2);
    color: var(--text);
    font-weight: 550;
  }

  .cell:hover {
    border-color: var(--accent);
  }

  .cell.dim {
    opacity: 0.42;
  }

  .cell.today .num {
    color: var(--accent);
  }

  .cell.picked {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .num {
    font-size: 0.86rem;
    line-height: 1;
  }

  .dots {
    display: flex;
    gap: 2px;
    align-items: center;
    min-height: 5px;
  }

  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-mute);
    display: block;
  }

  .dots i.timed {
    background: var(--accent);
  }

  .day {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .day h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .empty {
    margin: 0;
  }

  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .event {
    width: 100%;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    text-align: left;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-s);
    padding: 10px 12px;
  }

  .event:hover {
    border-color: var(--accent);
  }

  .time {
    flex: 0 0 86px;
    font-size: 0.78rem;
    color: var(--text-mute);
    font-variant-numeric: tabular-nums;
    padding-top: 2px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .notes {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  @media (max-width: 560px) {
    .time {
      flex-basis: 70px;
    }

    .cell {
      min-height: 42px;
    }
  }
</style>

