/**
 * Человеческие тексты ошибок синхронизации.
 *
 * Firebase отвечает служебными кодами (`permission-denied`, `unavailable`, …)
 * и английскими сообщениями. Пользователю нужно другое: что случилось и
 * что сделать. Модуль намеренно чистый — без Firebase, Dexie и Svelte,
 * поэтому проверяется в `npm run test:sync`.
 */

/** Этап синхронизации, на котором произошла ошибка. */
export type SyncStep = 'auth' | 'init' | 'pull' | 'push' | 'wipe' | 'unknown';

export interface SyncErrorInfo {
  /** Нормализованный код (`permission-denied`) или пустая строка. */
  code: string;
  step: SyncStep;
  /** Готовый текст для интерфейса, уже с указанием этапа. */
  message: string;
  /** Что сделать пользователю. */
  hint: string;
  /** Повторять автоматически бессмысленно — ждём действий пользователя. */
  fatal: boolean;
  /** Исходный текст ошибки: только для console.warn и отладки. */
  raw: string;
}

interface KnownProblem {
  text: string;
  hint: string;
  fatal: boolean;
}

const STEP_PREFIX: Record<SyncStep, string> = {
  auth: 'Вход: ',
  init: 'Запуск синхронизации: ',
  pull: 'Чтение из облака: ',
  push: 'Отправка в облако: ',
  wipe: 'Очистка облака: ',
  unknown: ''
};

const KNOWN: Record<string, KnownProblem> = {
  'permission-denied': {
    text: 'Firestore отклонил доступ',
    hint:
      'Опубликуйте правила из firestore.rules: Firebase Console → Firestore Database → Rules → Publish, ' +
      'затем нажмите «Синхронизировать сейчас». Если правила уже опубликованы, проверьте, что для ' +
      'Cloud Firestore не включён App Check в режиме Enforce.',
    fatal: true
  },
  unauthenticated: {
    text: 'Firebase не принял вход (сессия истекла)',
    hint: 'Выйдите из аккаунта и войдите через Google заново.',
    fatal: true
  },
  'not-found': {
    text: 'в проекте нет базы Firestore',
    hint: 'Создайте базу: Firebase Console → Firestore Database → Create database, регион eur3.',
    fatal: true
  },
  unavailable: {
    text: 'Firestore недоступен',
    hint: 'Похоже, пропала сеть. Синхронизация повторится автоматически.',
    fatal: false
  },
  'deadline-exceeded': {
    text: 'Firestore не ответил вовремя',
    hint: 'Повторим автоматически. Если ошибка повторяется — проверьте интернет.',
    fatal: false
  },
  aborted: {
    text: 'запрос к Firestore прерван',
    hint: 'Повторим автоматически.',
    fatal: false
  },
  internal: {
    text: 'внутренняя ошибка Firestore',
    hint: 'Повторим автоматически. Если не проходит — попробуйте позже.',
    fatal: false
  },
  'failed-precondition': {
    text: 'Firestore отклонил запрос из-за настроек проекта',
    hint:
      'Чаще всего нужен индекс по srvUpdatedAt (ссылка на создание есть в консоли браузера). ' +
      'Реже — база создана в режиме Datastore вместо Firestore.',
    fatal: true
  },
  'resource-exhausted': {
    text: 'исчерпана квота Firebase',
    hint:
      'Бесплатный тариф Spark ограничивает чтения и записи в сутки. Данные остаются на устройстве, ' +
      'синхронизация продолжится после восстановления квоты.',
    fatal: true
  },
  'invalid-argument': {
    text: 'Firestore отклонил данные документа',
    hint: 'В записи оказалось недопустимое значение. Сообщите об ошибке, если она повторяется.',
    fatal: true
  },
  'auth/unauthorized-domain': {
    text: 'этот домен не разрешён в Firebase Authentication',
    hint: 'Authentication → Settings → Authorized domains: добавьте yurikarandeev.github.io и localhost.',
    fatal: true
  },
  'auth/operation-not-allowed': {
    text: 'вход через Google выключен',
    hint: 'Authentication → Sign-in method → Google → Enable.',
    fatal: true
  },
  'auth/configuration-not-found': {
    text: 'Firebase Authentication не настроен для проекта',
    hint: 'Откройте Authentication → Get started и включите провайдер Google.',
    fatal: true
  },
  'auth/invalid-api-key': {
    text: 'неверный apiKey Firebase',
    hint: 'Проверьте конфигурацию проекта в src/lib/sync/config.ts.',
    fatal: true
  },
  'auth/user-disabled': {
    text: 'аккаунт отключён в Firebase',
    hint: 'Проверьте пользователя в Authentication → Users.',
    fatal: true
  },
  'auth/popup-closed-by-user': {
    text: 'окно входа закрыто до завершения',
    hint: 'Попробуйте войти снова и не закрывайте окно Google.',
    fatal: false
  },
  'auth/cancelled-popup-request': {
    text: 'предыдущая попытка входа была отменена',
    hint: 'Попробуйте ещё раз: одновременно можно открыть только одно окно входа.',
    fatal: false
  },
  'auth/popup-blocked': {
    text: 'браузер заблокировал окно входа',
    hint: 'Разрешите всплывающие окна для сайта — приложение попробует перенаправление.',
    fatal: false
  },
  'auth/network-request-failed': {
    text: 'нет связи с Firebase Authentication',
    hint: 'Проверьте интернет и попробуйте войти снова.',
    fatal: false
  }
};

interface RawError {
  code?: unknown;
  message?: unknown;
}

function readError(e: unknown): { code: string; message: string } {
  if (typeof e === 'string') return { code: '', message: e };
  const raw = (e ?? {}) as RawError;
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  const message =
    typeof raw.message === 'string' ? raw.message : e === null || e === undefined ? '' : String(e);
  return { code, message };
}

/**
 * Код Firebase → ключ в KNOWN. Учитывает коды Auth (`auth/...`) и
 * ситуации, когда код потерялся, а остался только английский текст.
 */
function resolveKey(code: string, message: string): string {
  if (code && KNOWN[code]) return code;
  const short = code.includes('/') ? code.slice(code.lastIndexOf('/') + 1) : code;
  if (short && KNOWN[short]) return short;
  if (/missing or insufficient permissions|permission[\s_-]?denied/i.test(message)) {
    return 'permission-denied';
  }
  if (/the database .*does not exist|database .*not found/i.test(message)) return 'not-found';
  if (/deadline exceeded|timed out/i.test(message)) return 'deadline-exceeded';
  if (/network|offline|failed to get document/i.test(message)) return 'unavailable';
  return short || code;
}

/**
 * Переводит ошибку Firebase в понятное сообщение.
 * `step` нужен, чтобы по тексту было видно, что именно не получилось.
 */
export function describeSyncError(e: unknown, step: SyncStep = 'unknown'): SyncErrorInfo {
  const { code: rawCode, message } = readError(e);
  const code = resolveKey(rawCode, message);
  const prefix = STEP_PREFIX[step];
  const known = KNOWN[code];

  if (!known) {
    const text = message.trim() || 'неизвестная ошибка';
    return {
      code,
      step,
      message: `${prefix}${text}`,
      hint: 'Подробности есть в консоли браузера. Если ошибка повторяется — выйдите из аккаунта и войдите снова.',
      fatal: false,
      raw: message
    };
  }

  return {
    code,
    step,
    message: `${prefix}${known.text}`,
    hint: known.hint,
    fatal: known.fatal,
    raw: message
  };
}

/** Ссылка на правила Firestore конкретного проекта. */
export function rulesConsoleUrl(projectId: string): string {
  const id = projectId.trim();
  if (!id) return 'https://console.firebase.google.com/';
  return `https://console.firebase.google.com/project/${id}/firestore/rules`;
}
