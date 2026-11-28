<script lang="ts">
  import type { Project, ProjectStatus } from '../db/db';
  import { PROJECT_STATUS_LABELS } from '../utils/projects';

  interface ProjectFormValue {
    title: string;
    goal: string;
    notes: string;
    status: ProjectStatus;
    dueDate: string;
  }

  let {
    open,
    project = null,
    onSave,
    onClose,
    onDelete
  }: {
    open: boolean;
    project?: Project | null;
    onSave: (value: ProjectFormValue) => void;
    onClose: () => void;
    onDelete?: () => void;
  } = $props();

  const STATUSES: ProjectStatus[] = ['active', 'paused', 'done'];

  let form = $state<ProjectFormValue>({
    title: '',
    goal: '',
    notes: '',
    status: 'active',
    dueDate: ''
  });
  let error = $state('');
  let hydratedFor = '';

  // Перезаполняем форму при открытии на другой проект, но не на каждый клик.
  $effect(() => {
    if (!open) {
      hydratedFor = '';
      return;
    }
    const key = project?.id ?? 'new';
    if (key === hydratedFor) return;
    hydratedFor = key;
    error = '';
    form = project
      ? {
          title: project.title,
          goal: project.goal,
          notes: project.notes,
          status: project.status,
          dueDate: project.dueDate
        }
      : { title: '', goal: '', notes: '', status: 'active', dueDate: '' };
  });

  function submit(): void {
    const title = form.title.trim();
    if (!title) {
      error = 'Введите название проекта';
      return;
    }
    error = '';
    onSave({
      title,
      goal: form.goal.trim(),
      notes: form.notes.trim(),
      status: form.status,
      dueDate: form.dueDate
    });
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
    <div class="sheet card" role="dialog" aria-modal="true" aria-label="Проект">
      <header class="row-between">
        <h2>{project ? 'Проект' : 'Новый проект'}</h2>
        <button class="btn btn-sm btn-ghost" onclick={onClose} aria-label="Закрыть">✕</button>
      </header>

      <form
        class="col"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label for="project-title">Название</label>
        <input
          id="project-title"
          bind:value={form.title}
          maxlength="120"
          placeholder="Например, переезд или ремонт"
        />

        <label for="project-goal">Цель (необязательно)</label>
        <input
          id="project-goal"
          bind:value={form.goal}
          maxlength="120"
          placeholder="Что должно получиться в итоге"
        />

        <div class="grid2">
          <div class="col">
            <label for="project-due">Срок</label>
            <input id="project-due" type="date" bind:value={form.dueDate} />
          </div>
          <div class="col">
            <label for="project-status">Статус</label>
            <select id="project-status" bind:value={form.status}>
              {#each STATUSES as status (status)}
                <option value={status}>{PROJECT_STATUS_LABELS[status]}</option>
              {/each}
            </select>
          </div>
        </div>

        <label for="project-notes">Заметка</label>
        <textarea
          id="project-notes"
          bind:value={form.notes}
          maxlength="1000"
          rows="3"
          placeholder="О чём проект, где материалы, чего ждём…"
        ></textarea>

        {#if error}<div class="err">{error}</div>{/if}

        <div class="row-between">
          <div class="row" style="gap: 6px">
            <button type="submit" class="btn btn-primary">Сохранить</button>
            <button type="button" class="btn" onclick={onClose}>Отмена</button>
          </div>
          {#if project && onDelete}
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
    padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
      calc(16px + var(--safe-bottom)) calc(16px + var(--safe-left));
    z-index: 100;
  }

  .sheet {
    width: min(560px, 100%);
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px - var(--safe-top) - var(--safe-bottom));
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
