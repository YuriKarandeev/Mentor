/**
 * Минимальная шина «локальные данные изменились».
 * Живёт отдельно от движка синхронизации, чтобы `db.ts` не зависел от Firebase.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onLocalChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyLocalChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* подписчик не должен ломать запись в базу */
    }
  }
}
