/**
 * Конфигурация Firebase для клиентской синхронизации.
 *
 * Значения ниже — публичный идентификатор веб-приложения Firebase (не секрет:
 * доступ к данным ограничивают правила Firestore, см. firestore.rules).
 * Их можно переопределить переменными окружения VITE_FIREBASE_* при сборке.
 */

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
}

const DEFAULTS: FirebaseConfig = {
  apiKey: 'AIzaSyD4GYlO0aHRMXVHIeyOqaa_mz2SpomcMMM',
  authDomain: 'mentor-1c954.firebaseapp.com',
  projectId: 'mentor-1c954',
  messagingSenderId: '758957382062',
  appId: '1:758957382062:web:1f85ae7b35c6c54bd2103f'
};

function envValue(name: string): string {
  const raw = (import.meta.env as Record<string, unknown>)[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function pick(name: string, fallback: string): string {
  return envValue(name) || fallback;
}

export const firebaseConfig: FirebaseConfig = {
  apiKey: pick('VITE_FIREBASE_API_KEY', DEFAULTS.apiKey),
  authDomain: pick('VITE_FIREBASE_AUTH_DOMAIN', DEFAULTS.authDomain),
  projectId: pick('VITE_FIREBASE_PROJECT_ID', DEFAULTS.projectId),
  messagingSenderId: pick('VITE_FIREBASE_SENDER_ID', DEFAULTS.messagingSenderId),
  appId: pick('VITE_FIREBASE_APP_ID', DEFAULTS.appId)
};

/**
 * Синхронизация доступна, когда есть конфиг и её не выключили явно
 * (VITE_SYNC_ENABLED=0 — приложение работает только с локальной базой).
 */
export const SYNC_ENABLED: boolean =
  envValue('VITE_SYNC_ENABLED') !== '0' &&
  Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
