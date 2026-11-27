/**
 * Публичный VAPID-ключ и параметры доставки напоминаний.
 *
 * Сами уведомления отправляет GitHub Actions (`.github/workflows/notify.yml`),
 * а приложение только кладёт план и подписку в Firestore. Поэтому в браузере
 * нужен лишь публичный ключ — приватный живёт в секретах репозитория
 * (`VAPID_PRIVATE_KEY`) и в код не попадает.
 *
 * Ключ печатает `npm run vapid:keys`; его же надо положить в секрет
 * `VAPID_PUBLIC_KEY`. Переопределить можно переменной `VITE_VAPID_PUBLIC_KEY`
 * при сборке — удобно для форка без правки кода.
 */

const DEFAULTS = {
  /**
   * Публичный VAPID-ключ (base64url, без padding).
   * Пустая строка = доставка не настроена: карточка напоминаний честно об этом
   * скажет, а само приложение продолжит работать как обычно.
   */
  publicKey: ''
};

function envValue(name: string): string {
  const raw = (import.meta.env as Record<string, unknown>)[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

export const VAPID_PUBLIC_KEY = envValue('VITE_VAPID_PUBLIC_KEY') || DEFAULTS.publicKey;

/** Настроена ли доставка: без ключа подписка браузера невозможна. */
export function pushConfigured(): boolean {
  return VAPID_PUBLIC_KEY.length > 0;
}

/** Сколько живёт запрос «проверить доставку» в плане (см. `_push/lib.mjs`). */
export const TEST_TTL_MS = 15 * 60_000;

/** Ожидаемая задержка рассылки: cron GitHub Actions + очередь. */
export const DELIVERY_DELAY = 'обычно в течение 1–10 минут';
