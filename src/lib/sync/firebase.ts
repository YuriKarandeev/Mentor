/**
 * Ленивая загрузка Firebase SDK: код авторизации и Firestore попадает
 * в отдельный чанк и не утяжеляет первую загрузку приложения.
 */
import { firebaseConfig, SYNC_ENABLED } from './config';

export type AuthModule = typeof import('firebase/auth');
export type FirestoreModule = typeof import('firebase/firestore');

export interface Firebase {
  auth: import('firebase/auth').Auth;
  db: import('firebase/firestore').Firestore;
  authMod: AuthModule;
  fsMod: FirestoreModule;
}

let loading: Promise<Firebase> | null = null;

export function syncConfigured(): boolean {
  return SYNC_ENABLED;
}

export async function loadFirebase(): Promise<Firebase> {
  if (!SYNC_ENABLED) {
    throw new Error('Синхронизация не настроена: нет конфигурации Firebase');
  }
  loading ??= (async () => {
    const [appMod, authMod, fsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore')
    ]);
    const app = appMod.getApps().length > 0 ? appMod.getApp() : appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    auth.languageCode = 'ru';
    // Сессия переживает перезагрузку страницы (в т.ч. возврат после Google-редиректа).
    await authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(() => undefined);
    // Собственный кеш Firestore не нужен: офлайн-хранилищем остаётся Dexie.
    const db = fsMod.initializeFirestore(app, { localCache: fsMod.memoryLocalCache() });
    return { auth, db, authMod, fsMod };
  })();
  return loading;
}
