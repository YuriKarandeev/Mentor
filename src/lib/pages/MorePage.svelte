<script lang="ts">
  import { router } from '../router.svelte';

  const LINKS = [
    { path: '/projects', title: 'Проекты', icon: '📋', hint: 'Канбан-доски: карточки по колонкам и прогресс' },
    { path: '/library', title: 'Библиотека', icon: '📖', hint: 'Конспекты и материалы по темам' },
    { path: '/settings', title: 'Настройки', icon: '⚙️', hint: 'Ключ DeepSeek, напоминания, синхронизация, данные' }
  ];
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Ещё</h1>
      <p class="muted small">Разделы, которые нужны реже: библиотека и настройки.</p>
    </div>
  </header>

  <div class="card col" style="gap: 8px">
    {#each LINKS as link (link.path)}
      <button class="link" onclick={() => router.go(link.path)}>
        <span class="ico" aria-hidden="true">{link.icon}</span>
        <span class="text">
          <span class="title">{link.title}</span>
          <span class="tiny mute">{link.hint}</span>
        </span>
        <span class="arrow" aria-hidden="true">›</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .page-head h1 {
    margin: 0 0 4px;
    font-size: 1.3rem;
  }

  .page-head p {
    margin: 0;
  }

  .link {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px;
    border-radius: var(--radius-s);
    border: 1px solid var(--border-soft);
    background: var(--bg-elev-2);
    color: inherit;
    text-align: left;
  }

  .link:hover {
    filter: brightness(1.06);
  }

  .ico {
    font-size: 1.3rem;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .title {
    font-weight: 600;
  }

  .arrow {
    color: var(--text-mute);
    font-size: 1.2rem;
  }
</style>
