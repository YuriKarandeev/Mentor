/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_PROXY_URL?: string;
  /** '0' — полностью выключает облачную синхронизацию. */
  readonly VITE_SYNC_ENABLED?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
