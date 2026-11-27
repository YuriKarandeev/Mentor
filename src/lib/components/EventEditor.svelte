<script lang="ts">
  import type { PlannerEvent } from '../db/db';
  import { eventTimeLabel, localDate, todayIso, validDate, validTime } from '../utils/planner';

  interface EventFormValue {
    title: string;
    date: string;
    time: string;
    endTime: string;
    allDay: boolean;
    notes: string;
  }

  let {
    open,
    event = null,
    defaultDate = '',
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    event?: PlannerEvent | null;
    defaultDate?: string;
    onSave: (value: EventFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  let form = $state<EventFormValue>({
    title: '',
    date: todayIso(),
    time: '',
    endTime: '',
    allDay: true,
    notes: ''
  });
  let error = $state('');
  let hydratedFor = '';

  // Перезаполняем форму при открытии на другое событие/день, но не на каждый клик.
  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = `${event?.id ?? 'new'}:${defaultDate}`;
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = event
      ? {
          title: event.title,
          date: event.date,
          time: event.time,
          endTime: event.endTime,
          allDay: event.allDay,
          notes: event.notes
        }
      : {
          title: '',
          date: validDate(defaultDate) || todayIso(),
          time: '',
          endTime: '',
          allDay: true,
          notes: ''
        };
  });

  const preview = $derived(eventTimeLabel({ time: form.time, endTime: form.endTime, allDay: form.allDay }));

  function submit(): void {
    const title = form.title.trim();
    const time = validTime(form.time);
    const end = validTime(form.endTime);
    if (!title) {
      error = 'Введите название события';
      return;
    }
    if (!validDate(form.date)) {
      error = 'Дата должна быть настоящей: формат ГГГГ-ММ-ДД';
      return;
    }
    if (!form.allDay && !time) {
      error = 'Время в формате ЧЧ:ММ или включите «весь день»';
      return;
    }
    if (!form.allDay && form.endTime && (!end || end <= time)) {
      error = 'Окончание должно быть позже начала';
      return;
    }
    error = '';
    onSave({
      title,
      date: form.date,
      time: form.allDay ? '' : time,
      endTime: form.allDay ? '' : end,
      allDay: form.allDay,
      notes: form.notes.trim()
    });
  }

  function toggleAllDay(): void {
    form.allDay = !form.allDay;
    if (form.allDay) {
      form.time = '';
      form.endTime = '';
    } else if (!form.time) {
      form.time = '09:00';
    }
  }

  function setToday(): void {
    form.date = localDate();
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Событие календаря">
      <header class="row-between">
        <h2>{event ? 'Событие' : 'Новое событие'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label for="ev-title">Название</label>
        <input
          id="ev-title"
          bind:value={form.title}
          maxlength="120"
          placeholder="Например, занятие по SQL"
        />

        <div class="grid2">
          <div class="col">
            <label for="ev-date">Дата</label>
            <div class="row" style="gap: 6px">
              <input id="ev-date" type="date" bind:value={form.date} />
              <button type="button" class="btn btn-sm" onclick={setToday} title="Сегодня">Сегодня</button>
            </div>
          </div>

          <div class="col">
            <span class="label-text">Время</span>
            <label class="check">
              <input type="checkbox" checked={form.allDay} onchange={toggleAllDay} />
              весь день
            </label>
            {#if !form.allDay}
              <div class="row" style="gap: 6px">
                <input type="time" bind:value={form.time} aria-label="Начало" />
                <span class="mute">—</span>
                <input type="time" bind:value={form.endTime} aria-label="Окончание" />
              </div>
            {:else}
              <p class="mute tiny hint">{preview}</p>
            {/if}
          </div>
        </div>

        <label for="ev-notes">Заметка</label>
        <textarea
          id="ev-notes"
          bind:value={form.notes}
          maxlength="400"
          rows="3"
          placeholder="Детали, ссылка, что взять с собой…"
        ></textarea>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if event && onDelete}
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

