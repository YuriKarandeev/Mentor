import { connectionOf, isConfigured, type Connection } from '../api/conn';
import { DEFAULT_SETTINGS, getKv, setKv, type AppSettings } from '../db/db';
import { normalizeReminderSettings } from '../utils/reminders';

const KEY = 'settings';

class SettingsStore {
  data = $state<AppSettings>({ ...DEFAULT_SETTINGS });
  loaded = $state(false);

  async load(): Promise<void> {
    const stored = await getKv<Partial<AppSettings>>(KEY, {});
    this.data = {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Старые настройки не знают о напоминаниях: недостающие поля берём
      // из значений по умолчанию, битые — приводим к безопасному виду.
      reminders: normalizeReminderSettings(stored.reminders)
    };
    this.loaded = true;
  }

  async patch(patch: Partial<AppSettings>): Promise<void> {
    this.data = { ...this.data, ...patch };
    // $state.snapshot снимает прокси Svelte: IndexedDB такие объекты не клонирует.
    await setKv(KEY, $state.snapshot(this.data));
  }

  /** Готово ли подключение: ключ DeepSeek (direct) или адрес воркера (proxy). */
  get configured(): boolean {
    return isConfigured(this.data);
  }

  get connection(): Connection {
    return connectionOf(this.data);
  }
}

export const settings = new SettingsStore();
