import { SYNC_ENABLED } from './config';

export type SyncStatus = 'off' | 'signed-out' | 'syncing' | 'idle' | 'error' | 'offline';

export interface SyncUser {
  uid: string;
  email: string;
  name: string;
  photo: string;
}

/**
 * Состояние синхронизации для интерфейса.
 * `revision` увеличивается после применения чужих изменений — страницы
 * перечитывают данные, когда он меняется.
 */
class SyncStore {
  readonly available = SYNC_ENABLED;
  status = $state<SyncStatus>(SYNC_ENABLED ? 'signed-out' : 'off');
  user = $state<SyncUser | null>(null);
  auto = $state(true);
  pending = $state(0);
  lastSyncAt = $state(0);
  error = $state('');
  /** Подсказка «что делать» к текущей ошибке. */
  errorHint = $state('');
  /** Код ошибки Firebase (`permission-denied`, …) для адресных подсказок в UI. */
  errorCode = $state('');
  revision = $state(0);

  get signedIn(): boolean {
    return this.user !== null;
  }

  get statusLabel(): string {
    switch (this.status) {
      case 'off':
        return 'Синхронизация отключена';
      case 'signed-out':
        return 'Вход не выполнен';
      case 'syncing':
        return 'Синхронизация…';
      case 'idle':
        return 'Синхронизировано';
      case 'offline':
        return 'Нет сети — данные сохранены локально';
      case 'error':
        return 'Ошибка синхронизации';
    }
  }
}

export const sync = new SyncStore();
