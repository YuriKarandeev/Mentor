<script lang="ts">
  import { getBalance, listModels, ApiError } from '../api/deepseek';
  import { connectionOf, type ConnMode } from '../api/conn';
  import { webToolsSupported } from '../api/agent';
  import { db, wipeAll, type Effort, type Level, type ThemeMode } from '../db/db';
  import {
    disableReminders,
    enableReminders,
    plannedReminders,
    readStatus,
    refreshReminders,
    sendTestReminder,
    serverHint,
    unsupportedReason,
    type ReminderStatus
  } from '../push/client';
  import { profile } from '../stores/profile.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';
  import { sync } from '../sync/state.svelte';
  import { firebaseConfig } from '../sync/config';
  import { describeSyncError, rulesConsoleUrl, type SyncStep } from '../sync/errors';
  import { importAssistantFileText } from '../sync/import-assistant';
  import { formatDate } from '../utils/format';
  import {
    REMINDER_LEADS,
    normalizeReminderSettings,
    reminderLabel,
    remindersSummary,
    type ReminderDraft,
    type ReminderSettings
  } from '../utils/reminders';
  import { onMount } from 'svelte';

  const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
  const EFFORTS: Effort[] = ['low', 'high', 'max'];
  const THEMES: Array<{ value: ThemeMode; label: string }> = [
    { value: 'auto', label: 'Как в системе' },
    { value: 'light', label: 'Светлая' },
    { value: 'dark', label: 'Тёмная' }
  ];

  let hydrated = false;
  let form = $state({
    mode: 'direct' as ConnMode,
    proxyUrl: '',
    appToken: '',
    deepseekKey: '',
    model: 'deepseek-flash',
    effort: 'high' as Effort,
    webSearch: true,
    theme: 'auto' as ThemeMode,
    reminders: { ...normalizeReminderSettings(undefined) }
  });

  /* --- напоминания --- */
  let reminderStatus = $state<ReminderStatus | null>(null);
  let reminderBusy = $state(false);
  let reminderMessage = $state('');
  let reminderFailed = $state(false);
  let reminderPreview = $state<ReminderDraft[]>([]);

  /** Свежие данные о поддержке, разрешении и подписке — для карточки. */
  async function loadReminderStatus(): Promise<void> {
    reminderStatus = await readStatus();
  }

  /** Ближайшие напоминания по локальным данным: показываем 3. */
  async function loadReminderPreview(): Promise<void> {
    try {
      reminderPreview = (await plannedReminders()).slice(0, 3);
    } catch {
      reminderPreview = [];
    }
  }

  async function toggleReminders(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const want = input.checked;
    reminderBusy = true;
    reminderMessage = '';
    reminderFailed = false;
    try {
      if (want) {
        const result = await enableReminders();
        form.reminders = normalizeReminderSettings(settings.data.reminders);
        reminderMessage =
          result.planned > 0
            ? `Напоминания включены. Запланировано уведомлений: ${result.planned}.`
            : 'Напоминания включены. Пока нечего напоминать — добавьте события или дела.';
      } else {
        await disableReminders();
        form.reminders = normalizeReminderSettings(settings.data.reminders);
        reminderMessage = 'Напоминания выключены на этом устройстве.';
      }
    } catch (err) {
      reminderFailed = true;
      reminderMessage = errorText(err);
      input.checked = !want;
    } finally {
      reminderBusy = false;
      await loadReminderStatus();
      await loadReminderPreview();
    }
  }

  /** Любая правка расписания сразу сохраняется и уходит в воркер. */
  async function patchReminders(patch: Partial<ReminderSettings>): Promise<void> {
    const next = normalizeReminderSettings({ ...form.reminders, ...patch });
    form.reminders = next;
    reminderBusy = true;
    reminderMessage = '';
    reminderFailed = false;
    try {
      await settings.patch({ reminders: next });
      if (next.enabled) {
        const result = await refreshReminders({ force: true });
        reminderMessage =
          result.planned > 0
            ? `Расписание обновлено: ${result.planned} уведомлений.`
            : 'Расписание пустое: в ближайшие часы напоминать не о чем.';
      }
    } catch (err) {
      reminderFailed = true;
      reminderMessage = errorText(err);
    } finally {
      reminderBusy = false;
      await loadReminderPreview();
    }
  }

  async function testReminder(): Promise<void> {
    reminderBusy = true;
    reminderMessage = '';
    reminderFailed = false;
    try {
      const result = await sendTestReminder();
      reminderFailed = result.sent === 0;
      reminderMessage =
        result.sent > 0
          ? 'Тестовое уведомление отправлено — проверьте телефон.'
          : 'Отправлять некуда: сначала включите напоминания и разрешите уведомления.';
    } catch (err) {
      reminderFailed = true;
      reminderMessage = errorText(err);
    } finally {
      reminderBusy = false;
      await loadReminderStatus();
    }
  }

  onMount(() => {
    void loadReminderStatus();
    void loadReminderPreview();
  });

  /**
   * Прокси-режим — запасной путь: ключ DeepSeek остаётся на сервере, в браузере
   * лежит только `APP_TOKEN`. Он прячется за `?advanced=1`, но если уже выбран
   * в сохранённых настройках, поля показываются и без флага — иначе из этого
   * режима было бы не выйти.
   */
  let advanced = $state(typeof location !== 'undefined' && new URLSearchParams(location.search).has('advanced'));
  const showModeSelect = $derived(advanced || form.mode === 'proxy');

  /** Включает запасной режим и запоминает флаг в адресе страницы. */
  function showAdvanced(): void {
    advanced = true;
    const url = new URL(location.href);
    url.searchParams.set('advanced', '1');
    history.replaceState(null, '', url);
  }

  const canCheck = $derived(
    form.mode === 'proxy' ? form.proxyUrl.trim().length > 0 : form.deepseekKey.trim().length > 0
  );

  let prof = $state({
    name: '',
    occupation: '',
    level: '' as '' | Level,
    goals: '',
    interests: '',
    preferredStyle: ''
  });

  let checking = $state(false);
  let connResult = $state('');
  let connOk = $state(false);

  let syncBusy = $state(false);
  let syncMessage = $state('');
  let syncHint = $state('');
  let syncFailed = $state(false);

  /** Импорт календаря из «Ассистента»: статус под кнопкой. */
  let assistantBusy = $state(false);
  let assistantMessage = $state('');
  let assistantFailed = $state(false);

  const loadEngine = () => import('../sync/engine');

  /** Ошибка Firebase → понятный текст; подсказку показываем под сообщением. */
  function failText(e: unknown, step: SyncStep): string {
    const info = describeSyncError(e, step);
    syncHint = info.hint;
    return info.message;
  }

  async function signIn(): Promise<void> {
    syncBusy = true;
    syncMessage = '';
    syncHint = '';
    syncFailed = false;
    try {
      const { signInWithGoogle } = await loadEngine();
      await signInWithGoogle();
    } catch (e) {
      syncFailed = true;
      syncMessage = failText(e, 'auth');
    } finally {
      syncBusy = false;
    }
  }

  async function signOut(): Promise<void> {
    syncBusy = true;
    syncMessage = '';
    syncHint = '';
    syncFailed = false;
    try {
      const { signOutSync } = await loadEngine();
      await signOutSync();
      syncMessage = 'Вы вышли из аккаунта. Данные остались на устройстве.';
    } catch (e) {
      syncFailed = true;
      syncMessage = failText(e, 'auth');
    } finally {
      syncBusy = false;
    }
  }

  async function runSync(): Promise<void> {
    syncBusy = true;
    syncFailed = false;
    syncMessage = '';
    syncHint = '';
    try {
      const { syncNow } = await loadEngine();
      await syncNow();
      if (sync.error) {
        syncFailed = true;
        syncMessage = sync.error;
        syncHint = sync.errorHint;
      } else {
        syncMessage = sync.pending > 0 ? `Осталось отправить: ${sync.pending}` : 'Готово, всё синхронизировано.';
      }
    } catch (e) {
      syncFailed = true;
      syncMessage = failText(e, 'unknown');
    } finally {
      syncBusy = false;
    }
  }

  async function toggleAuto(e: Event): Promise<void> {
    const value = (e.currentTarget as HTMLInputElement).checked;
    const { setAutoSync } = await loadEngine();
    await setAutoSync(value);
  }

  async function wipeCloudData(): Promise<void> {
    if (
      !confirm(
        'Удалить копию данных из облака? На этом устройстве всё останется, но другие устройства потеряют данные.'
      )
    ) {
      return;
    }
    syncBusy = true;
    syncFailed = false;
    syncMessage = '';
    syncHint = '';
    try {
      const { wipeCloud } = await loadEngine();
      await wipeCloud();
      syncFailed = Boolean(sync.error);
      syncMessage = sync.error || 'Облачная копия очищена.';
      syncHint = sync.error ? sync.errorHint : '';
    } catch (e) {
      syncFailed = true;
      syncMessage = failText(e, 'wipe');
    } finally {
      syncBusy = false;
    }
  }

  $effect(() => {
    if (!settings.loaded || hydrated) return;
    hydrated = true;
    form = { ...settings.data };
    prof = {
      name: profile.data.name ?? '',
      occupation: profile.data.occupation ?? '',
      level: profile.data.level ?? '',
      goals: profile.data.goals.join(', '),
      interests: profile.data.interests.join(', '),
      preferredStyle: profile.data.preferredStyle ?? ''
    };
  });

  /** Текст исключения для тоста: одинаково для сохранения и проверки связи. */
  function errorText(e: unknown): string {
    return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
  }

  async function saveSettings(): Promise<void> {
    try {
      await settings.patch({
        mode: form.mode,
        proxyUrl: form.proxyUrl.trim(),
        appToken: form.appToken.trim(),
        deepseekKey: form.deepseekKey.trim(),
        model: form.model,
        effort: form.effort,
        webSearch: form.webSearch,
        theme: form.theme
      });
      toasts.success('Настройки сохранены');
    } catch (e) {
      toasts.error(`Не удалось сохранить настройки: ${errorText(e)}`);
    }
  }

  async function check(): Promise<void> {
    checking = true;
    connResult = '';
    connOk = false;
    try {
      const conn = connectionOf(form);
      const models = await listModels(conn);
      let bal = '';
      try {
        const b = await getBalance(conn);
        bal = b.balance_infos?.length
          ? ` · баланс: ${b.balance_infos.map((i) => `${i.total_balance} ${i.currency}`).join(', ')}`
          : '';
      } catch {
        bal = '';
      }
      connResult = `Связь есть. Модели: ${models.join(', ') || '—'}${bal}`;
      if (form.webSearch && !webToolsSupported(form.model)) {
        connResult += ` · веб-поиск доступен только для deepseek-flash, для «${form.model}» отключён`;
      }
      connOk = true;
    } catch (e) {
      connResult = `Ошибка: ${errorText(e)}`;
    } finally {
      checking = false;
    }
  }

  function splitList(v: string): string[] {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function saveProfile(): Promise<void> {
    try {
      await profile.save({
        name: prof.name.trim() || undefined,
        occupation: prof.occupation.trim() || undefined,
        level: prof.level || undefined,
        goals: splitList(prof.goals),
        interests: splitList(prof.interests),
        preferredStyle: prof.preferredStyle.trim() || undefined
      });
      toasts.success('Профиль обновлён');
    } catch (e) {
      toasts.error(`Не удалось сохранить профиль: ${errorText(e)}`);
    }
  }

  async function exportData(): Promise<void> {
    const payload = {
      version: 4,
      exportedAt: new Date().toISOString(),
      topics: await db.topics.toArray(),
      plans: await db.plans.toArray(),
      messages: await db.messages.toArray(),
      notes: await db.notes.toArray(),
      memory: await db.memory.toArray(),
      events: await db.events.toArray(),
      tasks: await db.tasks.toArray(),
      kv: await db.kv.toArray()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nastavnik-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Импорт: записи помечаются к отправке, чтобы при синхронизации уйти в облако. */
  function normalizeRows(rows: unknown[]): never[] {
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        ...row,
        updatedAt: Number(row.updatedAt ?? row.createdAt ?? Date.now()) || Date.now(),
        dirty: 1
      } as never;
    });
  }

  async function importData(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as Record<string, unknown[]>;
      await db.transaction(
        'rw',
        [db.topics, db.plans, db.messages, db.notes, db.memory, db.events, db.tasks, db.kv],
        async () => {
          if (Array.isArray(json.topics)) await db.topics.bulkPut(normalizeRows(json.topics));
          if (Array.isArray(json.plans)) await db.plans.bulkPut(normalizeRows(json.plans));
          if (Array.isArray(json.messages)) await db.messages.bulkPut(normalizeRows(json.messages));
          if (Array.isArray(json.notes)) await db.notes.bulkPut(normalizeRows(json.notes));
          if (Array.isArray(json.memory)) await db.memory.bulkPut(json.memory as never[]);
          if (Array.isArray(json.events)) await db.events.bulkPut(normalizeRows(json.events));
          if (Array.isArray(json.tasks)) await db.tasks.bulkPut(normalizeRows(json.tasks));
          if (Array.isArray(json.kv)) {
            const rows = (json.kv as Array<Record<string, unknown>>).map((row) =>
              row.key === 'profile' ? { ...row, dirty: 1 } : row
            );
            await db.kv.bulkPut(rows as never[]);
          }
        }
      );
      toasts.success('Данные импортированы. Обновите страницу.');
    } catch {
      toasts.error('Не удалось прочитать файл резервной копии');
    } finally {
      input.value = '';
    }
  }

  /**
   * Импорт календаря из «Ассистента»: принимает файл копии (`{ app, state }`)
   * или «голое» состояние из localStorage. Повторный импорт не задваивает события.
   */
  async function importAssistant(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    assistantBusy = true;
    assistantFailed = false;
    assistantMessage = '';
    try {
      const result = await importAssistantFileText(await file.text());
      const parts = [`Добавлено событий: ${result.created}`];
      if (result.duplicates > 0) parts.push(`уже были: ${result.duplicates}`);
      if (result.invalid > 0) parts.push(`пропущено без даты или названия: ${result.invalid}`);
      assistantMessage = parts.join(' · ');
      toasts.success(result.created > 0 ? 'Календарь «Ассистента» импортирован' : 'Новых событий нет');
    } catch (err) {
      assistantFailed = true;
      assistantMessage = errorText(err);
      toasts.error('Импорт не удался');
    } finally {
      assistantBusy = false;
      input.value = '';
    }
  }

  async function wipe(): Promise<void> {
    const extra = sync.user ? ' Данные будут удалены и из облака.' : '';
    if (!confirm(`Удалить ВСЕ данные приложения на этом устройстве? Отменить будет нельзя.${extra}`)) return;
    await wipeAll();
    location.hash = '/';
    location.reload();
  }
</script>

<div class="page">
  <header class="page-head">
    <h1>Настройки</h1>
    <p class="muted small">
      {#if form.mode === 'proxy'}
        Ключ DeepSeek хранится в вашем прокси-воркере и в приложение не попадает.
      {:else}
        Ключ DeepSeek хранится только в этом браузере и уходит напрямую в api.deepseek.com.
      {/if}
    </p>
  </header>

  <section class="card col">
    <h2>Подключение</h2>

    {#if showModeSelect}
      <div>
        <label for="mode">Способ подключения</label>
        <select id="mode" bind:value={form.mode}>
          <option value="direct">Прямой доступ (ключ DeepSeek)</option>
          <option value="proxy">Свой прокси (Cloudflare Worker)</option>
        </select>
      </div>
    {/if}

    {#if form.mode === 'proxy'}
      <div>
        <label for="proxy">Адрес прокси (Cloudflare Worker)</label>
        <input id="proxy" bind:value={form.proxyUrl} placeholder="https://study-proxy.you.workers.dev" />
      </div>

      <div>
        <label for="token">Токен приложения (x-app-token)</label>
        <input id="token" type="password" bind:value={form.appToken} placeholder="длинная случайная строка" />
        <p class="mute tiny">Тот же токен, что задан командой wrangler secret put APP_TOKEN.</p>
      </div>
    {:else}
      <div>
        <label for="key">Ключ DeepSeek API</label>
        <input
          id="key"
          type="password"
          bind:value={form.deepseekKey}
          placeholder="sk-…"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="mute tiny">
          Ключ создаётся в консоли DeepSeek:
          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a>
          → API keys; там же баланс и лимиты. Запросы идут напрямую в api.deepseek.com.
        </p>
        <p class="mute tiny">
          Ключ лежит только в этом браузере (IndexedDB) и не синхронизируется. На общем компьютере
          сохранять его не стоит.
        </p>
      </div>
    {/if}

    <div class="row wrap">
      <div class="grow">
        <label for="model">Модель</label>
        <input id="model" list="models" bind:value={form.model} />
        <datalist id="models">
          {#each MODELS as m (m)}
            <option value={m}></option>
          {/each}
        </datalist>
      </div>
      <div class="grow">
        <label for="effort">Глубина размышлений</label>
        <select id="effort" bind:value={form.effort}>
          {#each EFFORTS as e (e)}
            <option value={e}>{e}</option>
          {/each}
        </select>
      </div>
    </div>

    <label class="switch">
      <input type="checkbox" bind:checked={form.webSearch} />
      <span>Разрешить веб-поиск (deepseek_web_search, deepseek_read_url)</span>
    </label>
    {#if form.webSearch && !webToolsSupported(form.model)}
      <p class="mute tiny">
        Для модели «{form.model}» веб-поиск отключится автоматически: серверные веб-инструменты DeepSeek
        работают с deepseek-flash.
      </p>
    {:else}
      <p class="mute tiny">Серверные веб-инструменты DeepSeek работают с моделью deepseek-flash.</p>
    {/if}

    <div class="row wrap">
      <button class="btn btn-primary" onclick={saveSettings}>Сохранить</button>
      <button class="btn" onclick={check} disabled={checking || !canCheck}>
        {checking ? 'Проверяю…' : 'Проверить связь'}
      </button>
    </div>

    {#if connResult}
      <div class={connOk ? 'ok' : 'err'}>{connResult}</div>
    {/if}

    {#if !advanced && form.mode === 'direct'}
      <p class="mute tiny">
        Нельзя держать ключ в браузере? Поднимите прокси-воркер и включите запасной режим:
        <button type="button" class="linkish" onclick={showAdvanced}>дополнительные настройки</button>
      </p>
    {/if}
  </section>

  <section class="card col">
    <h2>Оформление</h2>
    <div class="row wrap">
      {#each THEMES as t (t.value)}
        <button
          class="btn btn-sm"
          class:btn-primary={form.theme === t.value}
          onclick={() => {
            form.theme = t.value;
            void saveSettings();
          }}
        >
          {t.label}
        </button>
      {/each}
    </div>
  </section>

  <section class="card col">
    <h2>Профиль и память</h2>
    <p class="mute tiny">
      Наставник использует это в каждом диалоге. Без входа в аккаунт данные хранятся только на устройстве.
    </p>

    <div class="row wrap">
      <div class="grow">
        <label for="name">Как обращаться</label>
        <input id="name" bind:value={prof.name} placeholder="Имя" />
      </div>
      <div class="grow">
        <label for="occ">Профессия / занятость</label>
        <input id="occ" bind:value={prof.occupation} placeholder="например: аналитик данных" />
      </div>
    </div>

    <div>
      <label for="level">Общий уровень</label>
      <select id="level" bind:value={prof.level}>
        <option value="">не указан</option>
        <option value="новичок">новичок</option>
        <option value="средний">средний</option>
        <option value="продвинутый">продвинутый</option>
      </select>
    </div>

    <div>
      <label for="goals">Цели (через запятую)</label>
      <input id="goals" bind:value={prof.goals} placeholder="сменить профессию, сдать экзамен" />
    </div>

    <div>
      <label for="interests">Интересы (через запятую)</label>
      <input id="interests" bind:value={prof.interests} placeholder="фотография, шахматы" />
    </div>

    <div>
      <label for="style">Предпочтительный стиль объяснений</label>
      <input id="style" bind:value={prof.preferredStyle} placeholder="короче, больше примеров" />
    </div>

    <button class="btn btn-primary" onclick={saveProfile}>Сохранить профиль</button>
  </section>

  <section class="card col">
    <h2>Синхронизация</h2>

    {#if !sync.available}
      <p class="mute tiny">
        В этой сборке синхронизация выключена: приложение работает только с локальной базой.
      </p>
    {:else if sync.user}
      <div class="row-between wrap">
        <div>
          <strong>{sync.user.name || sync.user.email || 'Аккаунт Google'}</strong>
          <div class="mute tiny">{sync.user.email}</div>
        </div>
        <span class="chip">{sync.statusLabel}</span>
      </div>

      {#if sync.pending > 0}
        <p class="mute tiny">Ждут отправки: {sync.pending}</p>
      {:else if sync.lastSyncAt > 0}
        <p class="mute tiny">Последняя синхронизация: {formatDate(sync.lastSyncAt)}</p>
      {/if}
      {#if sync.error}
        <div class="err">
          <div>{sync.error}</div>
          {#if sync.errorHint}<div class="mute tiny">{sync.errorHint}</div>{/if}
          {#if sync.errorCode === 'permission-denied'}
            <div class="tiny">
              <a href={rulesConsoleUrl(firebaseConfig.projectId)} target="_blank" rel="noreferrer">
                Открыть правила Firestore
              </a>
            </div>
          {/if}
        </div>
      {/if}

      <label class="switch">
        <input type="checkbox" checked={sync.auto} onchange={toggleAuto} />
        <span>Синхронизировать автоматически, пока приложение открыто</span>
      </label>

      <div class="row wrap">
        <button class="btn btn-primary btn-sm" onclick={runSync} disabled={syncBusy}>
          {syncBusy ? 'Синхронизирую…' : 'Синхронизировать сейчас'}
        </button>
        <button class="btn btn-sm" onclick={signOut} disabled={syncBusy}>Выйти из аккаунта</button>
        <button class="btn btn-sm btn-danger" onclick={wipeCloudData} disabled={syncBusy}>
          Удалить из облака
        </button>
      </div>

      {#if syncMessage}
        <div class={syncFailed ? 'err' : 'ok'}>
          <div>{syncMessage}</div>
          {#if syncFailed && syncHint}<div class="mute tiny">{syncHint}</div>{/if}
        </div>
      {/if}

      <p class="mute tiny">
        В облако уходят темы, планы, чаты, конспекты, память, события календаря и профиль. Ключ
        DeepSeek, токен прокси и настройки устройства остаются только здесь. Конфликты решаются по
        времени изменения — при правке одного пункта на двух устройствах останется последняя версия.
      </p>
    {:else}
      <p class="mute tiny">
        Войдите через Google, чтобы продолжить занятия на другом устройстве. Без входа всё работает как
        раньше — данные хранятся только здесь.
      </p>
      <button class="btn btn-primary" onclick={signIn} disabled={syncBusy}>
        {syncBusy ? 'Открываю Google…' : 'Войти через Google'}
      </button>
      {#if syncMessage}
        <div class={syncFailed ? 'err' : 'ok'}>
          <div>{syncMessage}</div>
          {#if syncFailed && syncHint}<div class="mute tiny">{syncHint}</div>{/if}
        </div>
      {/if}
    {/if}
  </section>

  <section class="card col">
    <h2>Напоминания</h2>
    <p class="mute tiny">
      Push-уведомления о событиях календаря и делах. Расписание на 48 часов вперёд строит приложение,
      а отправляет ваш прокси-воркер; в облако уходят только тексты ближайших напоминаний.
    </p>

    {#if !reminderStatus}
      <p class="mute tiny">Проверяю поддержку…</p>
    {:else if !reminderStatus.supported}
      <div class="err">{unsupportedReason()}</div>
    {:else}
      {#if reminderStatus.ios && !reminderStatus.standalone}
        <p class="mute tiny">
          На iPhone добавьте приложение на домашний экран (Поделиться → «На экран “Домой”») и откройте
          его оттуда: в обычной вкладке Safari push-уведомления недоступны.
        </p>
      {/if}

      {#if !reminderStatus.serverReady}
        <div class="err">{serverHint()}</div>
      {/if}

      <label class="switch">
        <input
          type="checkbox"
          checked={reminderStatus.enabled}
          disabled={reminderBusy || !reminderStatus.serverReady}
          onchange={toggleReminders}
        />
        <span>Напоминать о событиях и делах</span>
      </label>

      {#if reminderStatus.permission === 'denied'}
        <div class="err">
          Уведомления запрещены в браузере. Разрешите их в настройках сайта и обновите страницу.
        </div>
      {/if}

      {#if reminderStatus.enabled}
        <div class="row wrap">
          <label class="switch">
            <input
              type="checkbox"
              checked={form.reminders.events}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ events: e.currentTarget.checked })}
            />
            <span>События</span>
          </label>
          <label class="switch">
            <input
              type="checkbox"
              checked={form.reminders.tasks}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ tasks: e.currentTarget.checked })}
            />
            <span>Дела</span>
          </label>
        </div>

        <div class="row wrap">
          <div class="grow">
            <label for="remind-lead">Напоминать о событии</label>
            <select
              id="remind-lead"
              value={form.reminders.leadMinutes}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ leadMinutes: Number(e.currentTarget.value) })}
            >
              {#each REMINDER_LEADS as lead (lead)}
                <option value={lead}>{lead === 0 ? 'в момент начала' : `за ${lead} мин`}</option>
              {/each}
            </select>
          </div>
          <div class="grow">
            <label for="remind-digest">Сводка на день</label>
            <input
              id="remind-digest"
              type="time"
              value={form.reminders.digestTime}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ digestTime: e.currentTarget.value })}
            />
          </div>
        </div>

        <div class="row wrap">
          <div class="grow">
            <label for="quiet-from">Тихие часы с</label>
            <input
              id="quiet-from"
              type="time"
              value={form.reminders.quietFrom}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ quietFrom: e.currentTarget.value })}
            />
          </div>
          <div class="grow">
            <label for="quiet-to">до</label>
            <input
              id="quiet-to"
              type="time"
              value={form.reminders.quietTo}
              disabled={reminderBusy}
              onchange={(e) => void patchReminders({ quietTo: e.currentTarget.value })}
            />
          </div>
        </div>
        <p class="mute tiny">
          Сводка собирает события «на весь день» и дела без времени. Пустое время отключает сводку или
          тихие часы; попавшие в тихие часы уведомления переносятся на их конец.
        </p>

        <div class="row wrap">
          <button class="btn btn-sm" onclick={testReminder} disabled={reminderBusy}>Тест уведомления</button>
          <button class="btn btn-sm" onclick={() => void patchReminders({})} disabled={reminderBusy}>
            Обновить расписание
          </button>
        </div>

        {#if reminderPreview.length}
          <div>
            <div class="mute tiny">Ближайшие:</div>
            <ul class="reminder-list">
              {#each reminderPreview as item (item.tag)}
                <li>{reminderLabel(item)}</li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="mute tiny">В ближайшее время напоминаний нет.</p>
        {/if}
      {:else}
        <p class="mute tiny">Сейчас: {remindersSummary(form.reminders)}.</p>
      {/if}

      {#if reminderMessage}
        <div class={reminderFailed ? 'err' : 'ok'}>{reminderMessage}</div>
      {/if}
    {/if}
  </section>

  <section class="card col">
    <h2>Переезд из «Ассистента»</h2>
    <p class="mute tiny">
      В «Ассистенте» откройте «Данные» → «Экспорт в JSON» и загрузите файл сюда: события календаря
      переедут в этот календарь. Повторная загрузка того же файла ничего не задвоит, а записи без
      настоящей даты будут пропущены.
    </p>
    <div class="row wrap">
      <label class="btn btn-sm" style="margin: 0">
        {assistantBusy ? 'Импортирую…' : 'Загрузить копию «Ассистента»'}
        <input
          type="file"
          accept="application/json,.json"
          onchange={importAssistant}
          disabled={assistantBusy}
          style="display: none"
        />
      </label>
    </div>
    {#if assistantMessage}
      <div class={assistantFailed ? 'err' : 'ok'}>{assistantMessage}</div>
    {/if}
  </section>

  <section class="card col">
    <h2>Данные</h2>
    <div class="row wrap">
      <button class="btn btn-sm" onclick={exportData}>Экспорт в JSON</button>
      <label class="btn btn-sm" style="margin: 0">
        Импорт
        <input type="file" accept="application/json" onchange={importData} style="display: none" />
      </label>
      <button class="btn btn-sm btn-danger" onclick={wipe}>Удалить всё</button>
    </div>
    <p class="mute tiny">
      Темы, планы, чаты и конспекты лежат в IndexedDB браузера. С включённой синхронизацией копия
      хранится в вашем аккаунте Firebase и подтягивается на другие устройства.
    </p>
  </section>
</div>

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 24px;
  }

  .page-head h1 {
    margin-bottom: 4px;
  }

  .page-head p {
    margin: 0;
  }

  h2 {
    font-size: 1.02rem;
    margin: 0;
  }

  .switch {
    display: flex;
    gap: 10px;
    align-items: center;
    color: var(--text);
    font-size: 0.9rem;
    margin: 0;
  }

  .switch input {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    accent-color: var(--accent);
  }

  .err,
  .ok {
    border-radius: var(--radius-s);
    padding: 8px 12px;
    font-size: 0.86rem;
    white-space: pre-wrap;
  }

  .err {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
  }

  .ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
    color: var(--ok);
  }

  /* Ближайшие напоминания: компактный список без маркеров. */
  .reminder-list {
    margin: 4px 0 0;
    padding-left: 18px;
    color: var(--text-dim);
    font-size: 0.86rem;
  }

  .reminder-list li {
    margin: 2px 0;
  }

  label.btn {
    cursor: pointer;
  }

  /* Кнопка-ссылка «дополнительные настройки»: выглядит как текст. */
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
</style>

