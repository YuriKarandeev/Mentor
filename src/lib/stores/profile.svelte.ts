import { DEFAULT_PROFILE, getKv, setKv, type Profile } from '../db/db';

const KEY = 'profile';

class ProfileStore {
  data = $state<Profile>({ ...DEFAULT_PROFILE });
  loaded = $state(false);

  async load(): Promise<void> {
    const stored = await getKv<Profile>(KEY, { ...DEFAULT_PROFILE });
    this.data = { ...DEFAULT_PROFILE, ...stored };
    this.loaded = true;
  }

  async save(patch: Partial<Profile>): Promise<void> {
    this.data = { ...this.data, ...patch, updatedAt: Date.now() };
    await setKv(KEY, this.data);
  }

  /** Слияние патча от модели: цели/интересы объединяем без дублей. */
  async merge(patch: Partial<Profile>): Promise<void> {
    const merged: Profile = { ...this.data };
    if (patch.name) merged.name = patch.name;
    if (patch.occupation) merged.occupation = patch.occupation;
    if (patch.level) merged.level = patch.level;
    if (patch.preferredStyle) merged.preferredStyle = patch.preferredStyle;
    if (patch.goals?.length) merged.goals = unique([...merged.goals, ...patch.goals]);
    if (patch.interests?.length) merged.interests = unique([...merged.interests, ...patch.interests]);
    await this.save(merged);
  }
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.slice(0, 20);
}

export const profile = new ProfileStore();
