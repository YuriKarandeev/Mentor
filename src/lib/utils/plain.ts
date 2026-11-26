/**
 * IndexedDB клонирует значения структурным клонированием, а оно не умеет
 * работать с Proxy. Поля Svelte 5 (`$state`) — это глубокие прокси, поэтому
 * писать их в базу напрямую нельзя: `db.kv.put` падает с
 * `DataCloneError: #<Object> could not be cloned`, и настройки молча
 * остаются только в памяти до перезагрузки.
 *
 * Модуль намеренно не зависит ни от Dexie, ни от Svelte: его проверяет
 * `npm run test:sync` обычным импортом из Node.
 */

/** Значения, которые IndexedDB умеет клонировать без изменений. */
function keepAsIs(value: object): boolean {
  if (value instanceof Date) return true;
  if (typeof Blob === 'function' && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return value instanceof Map || value instanceof Set;
}

/**
 * Снимает реактивные обёртки и возвращает обычные объекты/массивы.
 * `undefined` внутри объектов сохраняется — IDB такие значения принимает.
 */
export function toPlainValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => toPlainValue(item)) as unknown as T;
  if (keepAsIs(value)) return value;

  const source = value as Record<string, unknown>;
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(source)) plain[key] = toPlainValue(source[key]);
  return plain as T;
}
