/**
 * Обработчик Web Push для сгенерированного service worker.
 *
 * Файл лежит в public/ и подключается строкой `importScripts('push-sw.js')`
 * (опция `workbox.importScripts` в vite.config.ts). Так не нужно переводить
 * сборку на injectManifest: precache и автообновление остаются прежними.
 *
 * Данные приходят от `worker/push.js` в поле `data` JSON-ом:
 *   { title, body, tag, url }
 */
/* global self, clients */

const FALLBACK_TITLE = 'Наставник';
const FALLBACK_BODY = 'Пора заняться делами.';

function notificationIcon() {
  return new URL('icons/icon-192.png', self.registration.scope).href;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = String(payload.title || FALLBACK_TITLE).slice(0, 120);
  const body = String(payload.body || FALLBACK_BODY).slice(0, 240);
  const tag = payload.tag ? String(payload.tag).slice(0, 120) : undefined;
  const url = payload.url ? String(payload.url).slice(0, 200) : '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: Boolean(tag),
      lang: 'ru',
      icon: notificationIcon(),
      badge: notificationIcon(),
      data: { url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;

  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      // Уже открытое приложение на другом маршруте — переиспользуем его.
      for (const client of windows) {
        if ('navigate' in client) {
          await client.navigate(target).catch(() => undefined);
          if ('focus' in client) return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : undefined;
    })()
  );
});

// Подписка не пережила обновление iOS/браузера: приложение пересоздаст её
// при следующем открытии (см. src/lib/push/client.ts → ensureSubscription).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(Promise.resolve());
});
