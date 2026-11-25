<script lang="ts">
  import { getBalance, listModels, ApiError } from '../api/deepseek';
  import { db, type Effort, type Level, type ThemeMode } from '../db/db';
  import { profile } from '../stores/profile.svelte';
  import { settings } from '../stores/settings.svelte';
  import { toasts } from '../stores/toast.svelte';

  const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
  const EFFORTS: Effort[] = ['low', 'high', 'max'];
  const THEMES: Array<{ value: ThemeMode; label: string }> = [
    { value: 'auto', label: 'Как в системе' },
    { value: 'light', label: 'Светлая' },
    { value: 'dark', label: 'Тёмная' }
  ];

  let hydrated = false;
  let form = $state({
    proxyUrl: '',
    appToken: '',
    model: 'deepseek-flash',
    effort: 'high' as Effort,
    webSearch: true,
    theme: 'auto' as ThemeMode
  });

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

  async function saveSettings(): Promise<void> {
    await settings.patch({
      proxyUrl: form.proxyUrl.trim(),
      appToken: form.appToken.trim(),
      model: form.model,
      effort: form.effort,
      webSearch: form.webSearch,
      theme: form.theme
    });
    toasts.success('Настройки сохранены');
  }

  async function check(): Promise<void> {
    checking = true;
    connResult = '';
    connOk = false;
    try {
      const conn = { baseUrl: form.proxyUrl.trim(), token: form.appToken.trim() };
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
      connOk = true;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      connResult = `Ошибка: ${msg}`;
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
    await profile.save({
      name: prof.name.trim() || undefined,
      occupation: prof.occupation.trim() || undefined,
      level: prof.level || undefined,
      goals: splitList(prof.goals),
      interests: splitList(prof.interests),
      preferredStyle: prof.preferredStyle.trim() || undefined
    });
    toasts.success('Профиль обновлён');
  }

  async function exportData(): Promise<void> {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      topics: await db.topics.toArray(),
      plans: await db.plans.toArray(),
      messages: await db.messages.toArray(),
      notes: await db.notes.toArray(),
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

  async function importData(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as Record<string, unknown[]>;
      await db.transaction('rw', db.topics, db.plans, db.messages, db.notes, db.kv, async () => {
        if (Array.isArray(json.topics)) await db.topics.bulkPut(json.topics as never[]);
        if (Array.isArray(json.plans)) await db.plans.bulkPut(json.plans as never[]);
        if (Array.isArray(json.messages)) await db.messages.bulkPut(json.messages as never[]);
        if (Array.isArray(json.notes)) await db.notes.bulkPut(json.notes as never[]);
        if (Array.isArray(json.kv)) await db.kv.bulkPut(json.kv as never[]);
      });
      toasts.success('Данные импортированы. Обновите страницу.');
    } catch {
      toasts.error('Не удалось прочитать файл резервной копии');
    } finally {
      input.value = '';
    }
  }

  async function wipe(): Promise<void> {
    if (!confirm('Удалить ВСЕ данные приложения на этом устройстве? Отменить будет нельзя.')) return;
    await db.delete();
    location.hash = '/';
    location.reload();
  }
</script>

<div class="page">
  <header class="page-head">
    <h1>Настройки</h1>
    <p class="muted small">Ключ API хранится только в Cloudflare и никогда не попадает в приложение.</p>
  </header>

  <section class="card col">
    <h2>Подключение</h2>

    <div>
      <label for="proxy">Адрес прокси (Cloudflare Worker)</label>
      <input id="proxy" bind:value={form.proxyUrl} placeholder="https://study-proxy.you.workers.dev" />
    </div>

    <div>
      <label for="token">Токен приложения (x-app-token)</label>
      <input id="token" type="password" bind:value={form.appToken} placeholder="длинная случайная строка" />
      <p class="mute tiny">Тот же токен, что задан командой wrangler secret put APP_TOKEN.</p>
    </div>

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

    <div class="row wrap">
      <button class="btn btn-primary" onclick={saveSettings}>Сохранить</button>
      <button class="btn" onclick={check} disabled={checking || !form.proxyUrl.trim()}>
        {checking ? 'Проверяю…' : 'Проверить связь'}
      </button>
    </div>

    {#if connResult}
      <div class={connOk ? 'ok' : 'err'}>{connResult}</div>
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
      Наставник использует это в каждом диалоге. Данные хранятся только на устройстве.
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
      Приложение полностью локальное: темы, планы, чаты и конспекты лежат в IndexedDB браузера.
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

  label.btn {
    cursor: pointer;
  }
</style>

