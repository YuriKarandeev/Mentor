import { DEFAULT_SETTINGS, getKv, setKv, type AppSettings } from '../db/db';

const KEY = 'settings';

class SettingsStore {
  data = $state<AppSettings>({ ...DEFAULT_SETTINGS });
  loaded = $state(false);

  async load(): Promise<void> {
    const stored = await getKv<Partial<AppSettings>>(KEY, {});
    this.data = { ...DEFAULT_SETTINGS, ...stored };
    this.loaded = true;
  }

  async patch(patch: Partial<AppSettings>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await setKv(KEY, this.data);
  }

  get configured(): boolean {
    return this.data.proxyUrl.trim().length > 0;
  }

  get connection() {
    return { baseUrl: this.data.proxyUrl, token: this.data.appToken };
  }
}

export const settings = new SettingsStore();
