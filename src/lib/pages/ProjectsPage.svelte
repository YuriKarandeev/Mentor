<script lang="ts">
  import CardEditor from '../components/CardEditor.svelte';
  import ProjectEditor from '../components/ProjectEditor.svelte';
  import {
    addProject,
    addProjectCard,
    allProjectCards,
    allProjects,
    moveProjectCard,
    removeProject,
    removeProjectCard,
    shiftProjectCard,
    updateProject,
    updateProjectCard,
    type Project,
    type ProjectCard,
    type ProjectStatus
  } from '../db/db';
  import { router } from '../router.svelte';
  import { sync } from '../sync/state.svelte';
  import { toasts } from '../stores/toast.svelte';
  import {
    CARD_COLUMNS,
    COLUMN_HINTS,
    COLUMN_LABELS,
    PROJECT_STATUS_LABELS,
    boardOf,
    boardProgress,
    dueLabel,
    type CardColumn
  } from '../utils/projects';

  let { id = '' }: { id?: string } = $props();

  let projects = $state<Project[]>([]);
  let cards = $state<ProjectCard[]>([]);
  let loading = $state(true);

  let projectOpen = $state(false);
  let editingProject = $state<Project | null>(null);
  let cardOpen = $state(false);
  let editingCard = $state<ProjectCard | null>(null);
  let cardColumn = $state<CardColumn>('todo');

  const EMPTY_BOARD: Record<CardColumn, ProjectCard[]> = { todo: [], doing: [], done: [] };

  /** Проект из адреса; если id пуст или устарел — первый в списке. */
  const current = $derived(projects.find((project) => project.id === id) ?? projects[0] ?? null);
  const currentCards = $derived(current ? cards.filter((card) => card.projectId === current.id) : []);
  const board = $derived(current ? boardOf(cards, current.id) : EMPTY_BOARD);
  const progress = $derived(boardProgress(currentCards));

  async function load(): Promise<void> {
    const [list, own] = await Promise.all([allProjects(), allProjectCards()]);
    projects = list;
    cards = own;
    loading = false;
  }

  $effect(() => {
    // revision — синхронизация принесла чужие изменения.
    sync.revision;
    void load();
  });

  function select(project: Project): void {
    router.go(`/projects/${encodeURIComponent(project.id)}`);
  }

  function openNewProject(): void {
    editingProject = null;
    projectOpen = true;
  }

  function openProject(project: Project | null): void {
    if (!project) return;
    editingProject = project;
    projectOpen = true;
  }

  function closeProject(): void {
    projectOpen = false;
    editingProject = null;
  }

  async function saveProject(value: {
    title: string;
    goal: string;
    notes: string;
    status: ProjectStatus;
    dueDate: string;
  }): Promise<void> {
    const isEdit = Boolean(editingProject);
    try {
      if (editingProject) {
        await updateProject(editingProject.id, value);
      } else {
        const created = await addProject(value);
        router.go(`/projects/${encodeURIComponent(created.id)}`);
      }
      projectOpen = false;
      editingProject = null;
      await load();
      toasts.success(isEdit ? 'Проект обновлён' : 'Проект создан');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeCurrentProject(): Promise<void> {
    if (!editingProject) return;
    if (!confirm(`Удалить проект «${editingProject.title}» вместе с карточками?`)) return;
    try {
      const gone = editingProject.id;
      await removeProject(gone);
      projectOpen = false;
      editingProject = null;
      await load();
      // Удалённый проект больше не открыть — уводим на общий список.
      if (gone === id) router.go('/projects');
      toasts.success('Проект удалён');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  function openNewCard(column: CardColumn): void {
    editingCard = null;
    cardColumn = column;
    cardOpen = true;
  }

  function openCard(card: ProjectCard): void {
    editingCard = card;
    cardColumn = card.column;
    cardOpen = true;
  }

  function closeCard(): void {
    cardOpen = false;
    editingCard = null;
  }

  async function saveCard(value: {
    title: string;
    notes: string;
    column: CardColumn;
    dueDate: string;
  }): Promise<void> {
    if (!current) return;
    const isEdit = Boolean(editingCard);
    try {
      if (editingCard) {
        await updateProjectCard(editingCard.id, value);
      } else {
        await addProjectCard({ ...value, projectId: current.id });
      }
      cardOpen = false;
      editingCard = null;
      await load();
      toasts.success(isEdit ? 'Карточка обновлена' : 'Карточка добавлена');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeCard(): Promise<void> {
    if (!editingCard) return;
    if (!confirm(`Удалить карточку «${editingCard.title}»?`)) return;
    try {
      await removeProjectCard(editingCard.id);
      cardOpen = false;
      editingCard = null;
      await load();
      toasts.success('Карточка удалена');
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Перенос в соседнюю колонку: ← в предыдущую, → в следующую. */
  async function move(card: ProjectCard, delta: number): Promise<void> {
    const index = CARD_COLUMNS.indexOf(card.column);
    const next = CARD_COLUMNS[index + delta];
    if (!next) return;
    try {
      await moveProjectCard(card.id, next);
      await load();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function shift(card: ProjectCard, delta: number): Promise<void> {
    try {
      await shiftProjectCard(card.id, delta);
      await load();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : String(e));
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Проекты</h1>
      <p class="muted small">
        Канбан-доски: карточки по колонкам, порядок, сроки и прогресс. Раздел синхронизируется
        вместе с остальными данными.
      </p>
    </div>
    <div class="row wrap" style="gap: 8px">
      <button class="btn btn-primary" onclick={openNewProject}>+ Проект</button>
    </div>
  </header>

  {#if loading}
    <p class="mute small">Загрузка…</p>
  {:else if projects.length === 0}
    <div class="card empty-card">
      <strong>Пока нет ни одного проекта</strong>
      <p class="mute small">
        Создайте проект — и получите доску с колонками «Надо», «В работе» и «Готово».
      </p>
      <button class="btn btn-primary" onclick={openNewProject}>Создать проект</button>
    </div>
  {:else}
    <div class="layout">
      <aside class="card list-card">
        <div class="row-between">
          <strong>Проекты</strong>
          <span class="mute tiny">{projects.length}</span>
        </div>
        <ul class="projects">
          {#each projects as project (project.id)}
            {@const own = cards.filter((card) => card.projectId === project.id)}
            {@const stats = boardProgress(own)}
            <li>
              <button
                class="project"
                class:on={project.id === current?.id}
                onclick={() => select(project)}
              >
                <span class="ptitle">{project.title}</span>
                <span class="pmeta">
                  {PROJECT_STATUS_LABELS[project.status]}{project.dueDate
                    ? ` · ${dueLabel(project.dueDate)}`
                    : ''} · {stats.done}/{stats.total}
                </span>
                <span class="bar"><span class="fill" style={`width:${stats.pct}%`}></span></span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      {#if current}
        <section class="board-wrap">
          <div class="card board-head">
            <div class="row-between wrap">
              <div class="grow">
                <h2 class="project-title">{current.title}</h2>
                <p class="mute small">
                  {PROJECT_STATUS_LABELS[current.status]}{current.dueDate
                    ? ` · ${dueLabel(current.dueDate)}`
                    : ''}{current.goal ? ` · ${current.goal}` : ''}
                </p>
              </div>
              <div class="row" style="gap: 6px">
                <button class="btn btn-sm" onclick={() => openProject(current)}>Изменить</button>
                <button class="btn btn-sm btn-primary" onclick={() => openNewCard('todo')}>
                  + Карточка
                </button>
              </div>
            </div>
            {#if current.notes}<p class="small muted">{current.notes}</p>{/if}
            <div class="progress-row">
              <span class="bar grow"><span class="fill" style={`width:${progress.pct}%`}></span></span>
              <span class="mute tiny">{progress.done} из {progress.total} готово</span>
            </div>
          </div>

          <div class="board">
            {#each CARD_COLUMNS as column (column)}
              <div class="card column">
                <div class="row-between">
                  <strong class="col-title">
                    {COLUMN_LABELS[column]}
                    <span class="mute tiny">{board[column].length}</span>
                  </strong>
                  <button
                    class="btn btn-sm btn-ghost"
                    onclick={() => openNewCard(column)}
                    aria-label={`Добавить карточку в «${COLUMN_LABELS[column]}»`}
                  >
                    +
                  </button>
                </div>
                <p class="mute tiny hint">{COLUMN_HINTS[column]}</p>

                {#if board[column].length === 0}
                  <p class="mute tiny empty">Пусто</p>
                {:else}
                  <ul class="cards">
                    {#each board[column] as card, index (card.id)}
                      <li class="card-item">
                        <button class="card-main" onclick={() => openCard(card)}>
                          <span class="ctitle">{card.title}</span>
                          {#if card.notes}<span class="cmeta">{card.notes}</span>{/if}
                          {#if card.dueDate}<span class="cdue">{dueLabel(card.dueDate)}</span>{/if}
                        </button>
                        <div class="moves">
                          <button
                            class="mv"
                            disabled={index === 0}
                            onclick={() => shift(card, -1)}
                            aria-label="Выше"
                            title="Выше"
                          >
                            ↑
                          </button>
                          <button
                            class="mv"
                            disabled={index === board[column].length - 1}
                            onclick={() => shift(card, 1)}
                            aria-label="Ниже"
                            title="Ниже"
                          >
                            ↓
                          </button>
                          <button
                            class="mv"
                            disabled={column === 'todo'}
                            onclick={() => move(card, -1)}
                            aria-label="В предыдущую колонку"
                            title="В предыдущую колонку"
                          >
                            ←
                          </button>
                          <button
                            class="mv"
                            disabled={column === 'done'}
                            onclick={() => move(card, 1)}
                            aria-label="В следующую колонку"
                            title="В следующую колонку"
                          >
                            →
                          </button>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}
</div>

<ProjectEditor
  open={projectOpen}
  project={editingProject}
  onSave={saveProject}
  onClose={closeProject}
  onDelete={removeCurrentProject}
/>

<CardEditor
  open={cardOpen}
  card={editingCard}
  defaultColumn={cardColumn}
  onSave={saveCard}
  onClose={closeCard}
  onDelete={removeCard}
/>

<style>
  .page {
    max-width: 1100px;
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

  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .empty-card p {
    margin: 0;
  }

  .layout {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }

  .list-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
  }

  .projects {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .project {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    padding: 8px 10px;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
    color: inherit;
  }

  .project.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  .ptitle {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .pmeta {
    font-size: 0.75rem;
    color: var(--text-mute);
  }

  .project.on .pmeta {
    color: color-mix(in srgb, var(--accent) 75%, var(--text-mute));
  }

  .bar {
    display: block;
    height: 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 60%, transparent);
    overflow: hidden;
  }

  .bar.grow {
    flex: 1;
    min-width: 60px;
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }

  .board-wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .board-head {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .board-head p {
    margin: 0;
  }

  .project-title {
    margin: 0 0 2px;
    font-size: 1.15rem;
    overflow-wrap: anywhere;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .progress-row .tiny {
    white-space: nowrap;
  }

  .board {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    min-width: 0;
  }

  .col-title {
    font-size: 0.95rem;
  }

  .hint {
    margin: 0;
  }

  .empty {
    margin: 4px 0 0;
  }

  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .card-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
  }

  .card-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: inherit;
  }

  .ctitle {
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .cmeta {
    font-size: 0.78rem;
    color: var(--text-mute);
    overflow-wrap: anywhere;
  }

  .cdue {
    font-size: 0.75rem;
    color: var(--warn);
  }

  .moves {
    display: flex;
    gap: 4px;
  }

  .mv {
    width: 28px;
    height: 26px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--bg-elev);
    color: var(--text-dim);
    line-height: 1;
    padding: 0;
  }

  .mv:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .mv:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .projects {
      flex-direction: row;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .projects li {
      flex: 0 0 auto;
    }

    .project {
      min-width: 210px;
    }

    .board {
      grid-template-columns: 1fr;
    }
  }
</style>
