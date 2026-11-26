/**
 * Куда и с каким заголовком уходит запрос к DeepSeek.
 *
 * Два режима:
 *  - `direct` — браузер обращается к api.deepseek.com сам, ключ пользователя
 *    лежит в IndexedDB этого браузера (BYOK);
 *  - `proxy`  — запрос идёт в собственный воркер (worker/deepseek-proxy.js),
 *    ключ DeepSeek остаётся на сервере, клиент знает только `x-app-token`.
 *
 * Модуль без импортов: его используют стор настроек, агент, страница настроек
 * и тесты (`npm run test:conn`) — без Svelte, Dexie и браузера.
 */

export type ConnMode = 'proxy' | 'direct';

/** Адрес DeepSeek API для прямого режима (без слэша на конце). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export interface Connection {
  baseUrl: string;
  token: string;
  /**
   * Необязательно: соединение без режима считается прокси — так воркер и
   * старые вызовы продолжают работать без изменений.
   */
  mode?: ConnMode;
}

/** Всё, что нужно, чтобы собрать соединение из настроек устройства. */
export interface ConnectionSource {
  mode?: ConnMode | string;
  proxyUrl: string;
  appToken: string;
  deepseekKey: string;
}

/** Неизвестное значение режима (старые сохранённые настройки) → `direct`. */
export function normalizeMode(mode: string | undefined): ConnMode {
  return mode === 'proxy' ? 'proxy' : 'direct';
}

export function isProxy(conn: Connection): boolean {
  return conn.mode !== 'direct';
}

export function connectionOf(source: ConnectionSource): Connection {
  if (normalizeMode(source.mode) === 'proxy') {
    return { baseUrl: source.proxyUrl, token: source.appToken, mode: 'proxy' };
  }
  return { baseUrl: DEEPSEEK_BASE_URL, token: source.deepseekKey, mode: 'direct' };
}

/** Настроено ли подключение — для гардов интерфейса. */
export function isConfigured(source: ConnectionSource): boolean {
  return normalizeMode(source.mode) === 'proxy'
    ? source.proxyUrl.trim().length > 0
    : source.deepseekKey.trim().length > 0;
}
