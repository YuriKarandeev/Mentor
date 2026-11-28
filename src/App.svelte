<script lang="ts">
  import { onMount } from 'svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import AssistantPage from './lib/pages/AssistantPage.svelte';
  import BudgetPage from './lib/pages/BudgetPage.svelte';
  import CalendarPage from './lib/pages/CalendarPage.svelte';
  import LibraryPage from './lib/pages/LibraryPage.svelte';
  import MorePage from './lib/pages/MorePage.svelte';
  import NewTopicPage from './lib/pages/NewTopicPage.svelte';
  import SettingsPage from './lib/pages/SettingsPage.svelte';
  import TasksPage from './lib/pages/TasksPage.svelte';
  import TopicPage from './lib/pages/TopicPage.svelte';
  import TopicsPage from './lib/pages/TopicsPage.svelte';
  import { initReminders } from './lib/push/client';
  import { router } from './lib/router.svelte';
  import { profile } from './lib/stores/profile.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import { sync } from './lib/sync/state.svelte';
  import { applyTheme, watchSystemTheme } from './lib/theme';

  let booted = $state(false);

  // Боковая панель на широком экране — все разделы.
  const NAV = [
    { path: '/', key: 'topics', label: 'Темы', icon: '📚' },
    { path: '/calendar', key: 'calendar', label: 'Календарь', icon: '🗓' },
    { path: '/tasks', key: 'tasks', label: 'Дела', icon: '✅' },
    { path: '/budget', key: 'budget', label: 'Бюджет', icon: '💰' },
    { path: '/assistant', key: 'assistant', label: 'Помощник', icon: '🤖' },
    { path: '/library', key: 'library', label: 'Библиотека', icon: '📖' },
    { path: '/settings', key: 'settings', label: 'Настройки', icon: '⚙️' }
  ];

  // Нижняя панель — шесть пунктов: библиотека и настройки живут в «Ещё».
  const BOTTOM_NAV = [
    { path: '/', key: 'topics', label: 'Темы', icon: '📚' },
    { path: '/calendar', key: 'calendar', label: 'Календарь', icon: '🗓' },
    { path: '/tasks', key: 'tasks', label: 'Дела', icon: '✅' },
    { path: '/budget', key: 'budget', label: 'Бюджет', icon: '💰' },
    { path: '/assistant', key: 'assistant', label: 'Помощник', icon: '🤖' },
    { path: '/more', key: 'more', label: 'Ещё', icon: '⋯' }
  ];

  onMount(() => {
    void (async () => {
      await Promise.all([settings.load(), profile.load()]);
      applyTheme(settings.data.theme);
      booted = true;
      if (!settings.configured && router.route.name !== 'settings') {
        router.go('/settings');
      }
      // Firebase тянется отдельным чанком и только при включённой синхронизации.
      const { initSync } = await import('./lib/sync/engine');
      void initSync();
      // Напоминания: пересчёт расписания при правках и возврате в приложение.
      // Модуль ничего не делает, пока пользователь не включил их в «Настройках».
      initReminders();
    })();
  });

  $effect(() => {
    applyTheme(settings.data.theme);
  });

  $effect(() => {
    // Синхронизация могла принести новый профиль с другого устройства.
    sync.revision;
    if (!booted) return;
    void profile.load();
  });

  $effect(() => {
    const mode = settings.data.theme;
    if (!booted) return;
    return watchSystemTheme(mode, () => applyTheme(mode));
  });

  const route = $derived(router.route);
  const current = $derived(route.name === 'topic' ? 'topics' : route.name);
  /** В нижней панели «Библиотека» и «Настройки» подсвечивают «Ещё». */
  const bottomCurrent = $derived(
    current === 'library' || current === 'settings' ? 'more' : current
  );
  const topicId = $derived(route.name === 'topic' ? route.id : '');
  const topicTab = $derived(route.name === 'topic' ? route.tab : 'plan');
</script>

{#if !booted}
  <div class="boot">Загрузка…</div>
{:else}
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <span class="mark">Н</span>
        <div>
          <strong>Наставник</strong>
          <div class="tiny mute">ИИ-репетитор</div>
        </div>
      </div>

      <nav>
        {#each NAV as item (item.path)}
          <button class:active={current === item.key} onclick={() => router.go(item.path)}>
            <span class="ico">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        {/each}
      </nav>

      <div class="side-foot tiny mute">
        {#if sync.user}
          Данные синхронизируются с облаком
        {:else if sync.available}
          Локальные данные — вход в «Настройках»
        {:else}
          Данные хранятся только на этом устройстве
        {/if}
      </div>
    </aside>

    <main>
      {#if !settings.configured && route.name !== 'settings'}
        <div class="setup">
          Остался один шаг: настройте подключение к DeepSeek.
          <button class="btn btn-sm btn-primary" onclick={() => router.go('/settings')}>Настроить</button>
        </div>
      {/if}

      {#if route.name === 'topics'}
        <TopicsPage />
      {:else if route.name === 'new-topic'}
        <NewTopicPage />
      {:else if route.name === 'calendar'}
        <CalendarPage />
      {:else if route.name === 'tasks'}
        <TasksPage />
      {:else if route.name === 'budget'}
        <BudgetPage tab={route.tab} />
      {:else if route.name === 'assistant'}
        <AssistantPage />
      {:else if route.name === 'library'}
        <LibraryPage />
      {:else if route.name === 'more'}
        <MorePage />
      {:else if route.name === 'settings'}
        <SettingsPage />
      {:else}
        {#key topicId}
          <TopicPage id={topicId} tab={topicTab} />
        {/key}
      {/if}
    </main>

    <nav class="bottom">
      {#each BOTTOM_NAV as item (item.path)}
        <button class:active={bottomCurrent === item.key} onclick={() => router.go(item.path)}>
          <span class="ico">{item.icon}</span>
          <span class="lbl">{item.label}</span>
        </button>
      {/each}
    </nav>
  </div>
{/if}

<Toasts />

<style>
  .boot {
    display: grid;
    place-items: center;
    min-height: 100vh;
    min-height: 100dvh;
    padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
      calc(16px + var(--safe-bottom)) calc(16px + var(--safe-left));
    color: var(--text-mute);
  }

  .shell {
    display: flex;
    min-height: 100vh;
    min-height: 100dvh;
  }

  main {
    flex: 1;
    min-width: 0;
    /* Сверху — отступ под «челку»/динамический остров, снизу — под нижнюю панель и home-индикатор. */
    padding: calc(16px + var(--safe-top)) calc(14px + var(--safe-right))
      calc(var(--nav-h) + 24px + var(--safe-bottom)) calc(14px + var(--safe-left));
  }

  /* --- мобильная навигация --- */
  .bottom {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--nav-h) + var(--safe-bottom));
    padding-bottom: var(--safe-bottom);
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
    display: flex;
    background: var(--bg-elev);
    border-top: 1px solid var(--border-soft);
    z-index: 50;
  }

  .bottom button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: none;
    border: none;
    color: var(--text-mute);
    font-size: 0.68rem;
    padding: 6px 0;
  }

  .bottom button.active {
    color: var(--accent);
  }

  .bottom .ico {
    font-size: 1.1rem;
    line-height: 1;
  }

  .lbl {
    font-weight: 550;
  }

  .side {
    display: none;
  }

  .side nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .side nav button {
    display: flex;
    gap: 10px;
    align-items: center;
    background: none;
    border: none;
    padding: 10px 12px;
    border-radius: var(--radius-s);
    color: var(--text-dim);
    text-align: left;
    font-weight: 550;
  }

  .side nav button:hover {
    background: var(--bg-elev-2);
  }

  .side nav button.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .brand {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 0 6px;
  }

  .mark {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--accent);
    color: #fff;
    display: grid;
    place-items: center;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .side-foot {
    margin-top: auto;
    padding: 0 6px;
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
    margin-bottom: 16px;
    font-size: 0.9rem;
  }

  @media (min-width: 900px) {
    .side {
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 250px;
      flex: 0 0 250px;
      padding: calc(20px + var(--safe-top)) 14px 20px;
      border-right: 1px solid var(--border-soft);
      position: sticky;
      top: 0;
      height: 100vh;
      height: 100dvh;
      background: var(--bg-elev);
    }

    main {
      padding: calc(28px + var(--safe-top)) 32px 48px;
    }

    .bottom {
      display: none;
    }
  }
</style>

