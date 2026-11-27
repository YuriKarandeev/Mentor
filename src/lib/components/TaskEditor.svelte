<script lang="ts">
  import type { PlannerTask } from '../db/db';
  import { todayIso, validDate, validTime } from '../utils/planner';
  import { WEEKDAY_LABELS, normalizeDays, weekdayIndex } from '../utils/tasks';

  interface TaskFormValue {
    title: string;
    notes: string;
    days: number[];
    onceDate: string;
    time: string;
  }

  let {
    open,
    task = null,
    defaultDate = '',
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    task?: PlannerTask | null;
    defaultDate?: string;
    onSave: (value: TaskFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<TaskFormValue>({
    title: '',
    notes: '',
    days: [],
    onceDate: '',
    time: ''
  });
  let once = $state(false);
  let error = $state('');
  let hydratedFor = '';

  // Перезаполняем форму при открытии на другое дело, но не на каждый клик.
  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = `${task?.id ?? 'new'}:${defaultDate}`;
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    if (task) {
      once = Boolean(task.onceDate);
      form = {
        title: task.title,
        notes: task.notes,
        days: normalizeDays(task.days),
        onceDate: task.onceDate,
        time: task.time
      };
      return;
    }
    once = false;
    // Новое дело по умолчанию — на день недели выбранной даты.
    const day = weekdayIndex(validDate(defaultDate) || todayIso());
    form = {
      title: '',
      notes: '',
      days: day >= 0 ? [day] : [],
      onceDate: '',
      time: ''
    };
  });

  const summary = $derived.by(() => {
    if (once) return form.onceDate ? 'разово' : 'выберите дату';
    if (form.days.length === 0) return 'выберите дни';
    if (form.days.length === 7) return 'каждый день';
    return form.days.map((d) => WEEKDAY_LABELS[d]).join(', ');
  });

  function toggleDay(day: number): void {
    form.days = form.days.includes(day)
      ? form.days.filter((d) => d !== day)
      : normalizeDays([...form.days, day]);
  }

  function quick(days: number[]): void {
    once = false;
    form.days = days;
  }

  /** Переключение «разово»: подставляем дату или день недели, чтобы форма не осталась пустой. */
  function toggleOnce(): void {
    if (once && !form.onceDate) form.onceDate = todayIso();
    if (!once && form.days.length === 0) {
      const day = weekdayIndex(todayIso());
      if (day >= 0) form.days = [day];
    }
  }

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название дела';
      return;
    }
    const time = validTime(form.time);
    if (once) {
      const date = validDate(form.onceDate);
      if (!date) {
        error = 'Выберите настоящую дату: формат ГГГГ-ММ-ДД';
        return;
      }
      error = '';
      onSave({ title, notes: form.notes.trim(), days: [], onceDate: date, time });
      return;
    }
    const days = normalizeDays(form.days);
    if (days.length === 0) {
      error = 'Выберите хотя бы один день недели или включите «разово»';
      return;
    }
    error = '';
    onSave({ title, notes: form.notes.trim(), days, onceDate: '', time });
  }
</script>

{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Дело">
      <header class="row-between">
        <h2>{task ? 'Дело' : 'Новое дело'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label for="task-title">Название</label>
        <input
          id="task-title"
          bind:value={form.title}
          maxlength="120"
          placeholder="Например, зарядка или повторение SQL"
        />

        <div class="row-between">
          <span class="label-text">Когда</span>
          <label class="check">
            <input type="checkbox" bind:checked={once} onchange={toggleOnce} />
            разово на дату
          </label>
        </div>

        {#if once}
          <input id="task-date" type="date" bind:value={form.onceDate} aria-label="Дата" />
        {:else}
          <div class="days">
            {#each WEEKDAY_LABELS as label, day (label)}
              <button
                type="button"
                class="day"
                class:on={form.days.includes(day)}
                aria-pressed={form.days.includes(day)}
                onclick={() => toggleDay(day)}
              >
                {label}
              </button>
            {/each}
          </div>
          <div class="row wrap" style="gap: 6px">
            <button type="button" class="btn btn-sm" onclick={() => quick([0, 1, 2, 3, 4, 5, 6])}>
              Каждый день
            </button>
            <button type="button" class="btn btn-sm" onclick={() => quick([0, 1, 2, 3, 4])}>Будни</button>
            <button type="button" class="btn btn-sm" onclick={() => quick([5, 6])}>Выходные</button>
          </div>
        {/if}

        <div class="grid2">
          <div class="col">
            <label for="task-time">Время (необязательно)</label>
            <input id="task-time" type="time" bind:value={form.time} />
          </div>
          <div class="col">
            <span class="label-text">Расписание</span>
            <p class="mute tiny hint">{summary}{form.time ? ` в ${form.time}` : ''}</p>
          </div>
        </div>

        <label for="task-notes">Заметка</label>
        <textarea
          id="task-notes"
          bind:value={form.notes}
          maxlength="400"
          rows="3"
          placeholder="Сколько минут, что именно делать, ссылка…"
        ></textarea>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if task && onDelete}
            <button type="button" class="btn btn-danger btn-sm" onclick={onDelete}>Удалить</button>
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    padding: 16px;
    z-index: 100;
  }

  .sheet {
    width: min(560px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--bg-elev);
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .days {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .day {
    min-width: 44px;
    padding: 8px 6px;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
    color: var(--text-dim);
    font-weight: 600;
    text-transform: capitalize;
  }

  .day.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    color: var(--text-dim);
  }

  .label-text {
    font-size: 0.86rem;
    color: var(--text-dim);
  }

  .check input {
    width: auto;
  }

  .hint {
    margin: 0;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
  }

  @media (max-width: 560px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
  }
</style>
