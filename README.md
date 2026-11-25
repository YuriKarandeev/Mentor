# Наставник — локальный ИИ-репетитор (PWA)

Личное учебное приложение: вы заводите тему, ИИ составляет план, ведёт диалог как наставник,
помнит ваши прошлые обсуждения и складывает конспекты в библиотеку.
Работает офлайн-первым: все данные лежат в браузере (IndexedDB), а сеть нужна только для ответов модели.

**Стек:** Svelte 5 (runes) · Vite 8 · TypeScript · Dexie (IndexedDB) · vite-plugin-pwa · DeepSeek API через Cloudflare Worker.
Ключ DeepSeek хранится в воркере и никогда не попадает в браузер.

## Возможности

- **Темы и планы.** Форма «новая тема» → вопросы онбординга → инструмент `save_plan` собирает 3–6 модулей с пунктами и оценкой времени.
- **Чат с наставником.** Ответы стримятся, отдельно показываются рассуждения модели, цитаты из веб-поиска и кнопка «в заметки».
- **Память.** Каждые ~5 реплик диалог сжимается в выжимку, которая подмешивается в системный промпт; профиль ученика обновляется через `update_profile`.
- **Прогресс.** Отметки пунктов плана сохраняются, показывается пройденное время и доля выполнения.
- **Библиотека.** По названию книги приложение делает разбор: ключевые идеи, применение, вопросы самопроверки, источники.
- **Настройки.** Адрес прокси, токен приложения, модель, глубина рассуждений (`low`/`high`/`max`), веб-поиск (только для `deepseek-flash`), тема оформления, профиль, экспорт/импорт JSON, полная очистка.
- **PWA.** Установка на телефон и десктоп, офлайн-кеш оболочки, обновление в фоне.

## Быстрый старт

Нужен Node 20+ (в проекте использовался локальный Node в `%LOCALAPPDATA%\tools\node`).

```powershell
npm install
npm run icons      # генерация PWA-иконок в public/icons (без внешних зависимостей)
npm run dev        # http://localhost:5173
```

Сборка и проверки:

```powershell
npm run check      # svelte-check (TS + Svelte)
npm run build      # dist/
npm run smoke      # проверка собранного dist без запуска сервера
npm run preview    # локальный просмотр сборки
```

## Подключение DeepSeek

1. Разверните воркер-прокси — инструкция в [`worker/README.md`](worker/README.md).
   Ключ DeepSeek и `APP_TOKEN` хранятся в секретах Cloudflare.
2. Откройте **Настройки**, укажите:
   - **Адрес прокси** — `https://<worker>.workers.dev` (только схема + хост, без пути и слэша на конце)
   - **Токен приложения** — то же значение, что в `APP_TOKEN`
   - **Модель** — `deepseek-flash` или `deepseek-v4-pro` (актуальные id отдаёт `/api/models`)
3. Нажмите **Проверить связь** — приложение запросит `/api/models` и `/api/user/balance`;
   зелёный результат показывает список моделей и баланс. После проверки нажмите **Сохранить**
   (проверка сама настройки не сохраняет).

Без прокси приложение работает локально (темы, планы, заметки), но не может получать ответы модели.

Если связь не устанавливается — разбор типовых ошибок (`Failed to fetch`, `404 not_found_error`,
`401`, блокировка `npm`/`npx` в PowerShell) в [`docs/SETUP.md`](docs/SETUP.md).

## Публикация на GitHub Pages

Живой адрес: **https://yurikarandeev.github.io/Mentor/**

Workflow `.github/workflows/deploy.yml` собирает проект и публикует `dist` при пуше в `main`
(шаги: `npm ci` → проверка нативного биндинга rolldown → `npm run check` → иконки → `npm run build` → `npm run smoke`).
`BASE_PATH` подставляется автоматически: `/<repo>/`. Роутинг — hash-based, поэтому deep links
работают без серверных rewrite-правил.

> **Важно про `package-lock.json`.** Vite 8 работает на rolldown с нативными бинарниками под каждую ОС.
> В npm есть баг ([npm/cli#4828](https://github.com/npm/cli/issues/4828)): lock, созданный на одной платформе,
> может не содержать optional-зависимостей для другой, и тогда CI на Ubuntu падает с
> `Cannot find native binding`. Поэтому lock в репозитории содержит все платформы
> (`@rolldown/binding-*`, `lightningcss-*`) — не удаляйте эти записи и не правьте lock вручную.
> Если нужно пересобрать lock: удалите `node_modules` и `package-lock.json`, выполните `npm install`,
> затем проверьте, что `grep "binding-linux-x64-gnu" package-lock.json` что-то находит.
> Дополнительная страховка в CI: шаг `Ensure native rolldown binding` доставляет биндинг под Linux,
> если его вдруг не окажется.

Для сборки под свой домен:

```powershell
$env:BASE_PATH = '/repo/'
npm run build
```

## Структура

```
src/
  main.ts                  точка входа
  App.svelte               каркас: сайдбар (≥900px) и нижняя навигация
  app.css                  токены темы, кнопки, карточки, стили markdown
  lib/
    router.svelte.ts       hash-роутер (#/topics, #/topic/<id>/<tab>, #/library, #/settings)
    theme.ts               применение темы (dark/light/system)
    api/
      deepseek.ts          chatOnce / chatStream / listModels / getBalance, разбор SSE
      agent.ts             сценарии: план, ход диалога, память, профиль, разбор книги
      prompts.ts           системные промпты наставника, методиста, памяти
      tools.ts             схемы инструментов (zod): save_plan, update_profile + веб-инструменты
      types.ts             типы ответов API
    db/db.ts               Dexie: topics, plans, messages, notes, kv
    stores/                settings, profile, toast (runes + localStorage)
    components/            Markdown, MessageBubble, Composer, PlanView, Toasts
    pages/                 Topics, NewTopic, Topic, Library, Settings
worker/                    Cloudflare Worker — прокси DeepSeek
scripts/gen-icons.mjs      генератор PNG-иконок (zlib, без зависимостей)
```

## Данные и приватность

- Всё содержимое (темы, планы, сообщения, заметки) хранится в IndexedDB браузера и никуда не отправляется, кроме запросов к модели.
- В `localStorage` лежат только настройки и профиль; секретов там нет — только адрес прокси и ваш `APP_TOKEN`.
- Экспорт/импорт в JSON — в **Настройках**; полная очистка удаляет IndexedDB и настройки.

## Ограничения

- Модель работает только через прокси: прямые запросы к `api.deepseek.com` из браузера блокируются CORS и раскрывают ключ.
- Память диалога — текстовая выжимка (не векторный поиск), поэтому очень длинные обсуждения сжимаются.
- Веб-поиск работает на модели `deepseek-flash`: серверные инструменты `deepseek_web_search` и
  `deepseek_read_url` для других моделей не объявляются, а при `HTTP 400` клиент повторяет запрос
  без них и без режима размышлений (подробности — в [`docs/SETUP.md`](docs/SETUP.md)).
