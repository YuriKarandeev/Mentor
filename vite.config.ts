import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH задаётся в CI (GitHub Pages: /<repo>/), локально остаётся '/'
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const base = env?.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        id: base,
        name: 'Наставник — ИИ-репетитор',
        short_name: 'Наставник',
        description: 'Личный ИИ-наставник: темы, планы обучения, чат с памятью, конспекты книг.',
        lang: 'ru',
        dir: 'ltr',
        theme_color: '#4f46e5',
        background_color: '#0b0d12',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait-primary',
        scope: base,
        start_url: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Firebase SDK (~500 КБ) грузится по требованию — не кладём его в precache,
        // чтобы установка PWA не тянула его тем, кто не включает синхронизацию.
        globIgnores: ['**/assets/index.esm-*.js'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // запросы к воркеру-прокси и DeepSeek никогда не кешируем
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: []
      },
      devOptions: { enabled: false }
    })
  ],
  server: { port: 5173, strictPort: false },
  build: {
    // Минификация CSS выключена: нативный lightningcss требует платформенный
    // бинарник и падает на части окружений (Node 26 / урезанные сборки).
    cssMinify: false
  }
});
