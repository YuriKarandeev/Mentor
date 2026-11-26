# Настройка прокси DeepSeek и типовые ошибки

Короткая шпаргалка: что делать, если приложение не может связаться с моделью.
Подробности по самому воркеру — в [`../worker/README.md`](../worker/README.md).

## Порядок настройки

1. `cd worker` → `npx.cmd -y wrangler@latest login` (один раз).
2. Секреты: `npx.cmd -y wrangler@latest secret put DEEPSEEK_API_KEY` и `... secret put APP_TOKEN`.
3. Деплой: `npx.cmd -y wrangler@latest deploy` — в выводе будет адрес
   `https://nastavnik-deepseek-proxy.<workers-subdomain>.workers.dev`.
4. В приложении: **Настройки → Адрес прокси** = этот адрес, **Токен приложения** = `APP_TOKEN`,
   **Модель** = `deepseek-flash` или `deepseek-v4-pro`.
5. Открыть `https://<worker>.workers.dev/health`: ответ должен содержать `"ok": true`,
   `"version"` (id версии — сравните с `Current Version ID` из вывода `wrangler deploy`)
   и блок `"stream"` с лимитами (`limitMs: 240000`, `idlePingMs: 10000`).
6. **Проверить связь** → зелёный отчёт → **Сохранить**.
## Синхронизация и Firebase

Синхронизация — отдельный, необязательный слой: без входа приложение работает как локальное.
Если вход через Google не работает или в облаке не появляются данные:

| Симптом в приложении | Причина | Что делать |
| --- | --- | --- |
| `Вход: Firebase Authentication не настроен…` | Firebase Authentication не инициализирован | Authentication → **Get started**, затем включить провайдер Google |
| `Вход: вход через Google выключен` | провайдер Google выключен | Authentication → Sign-in method → Google → **Enable** |
| `Вход: этот домен не разрешён…` | домена нет в списке разрешённых | Authentication → Settings → **Authorized domains** → добавить `yurikarandeev.github.io` и `localhost` |
| `Чтение из облака: Firestore отклонил доступ` (`permission-denied`) | не опубликованы правила Firestore | Firestore Database → **Rules** → вставить [`../firestore.rules`](../firestore.rules) → **Publish** → «Синхронизировать сейчас» |
| `Чтение из облака: в проекте нет базы Firestore` (`not-found`) | база не создана | Firestore Database → **Create database** → регион `eur3` |
| `исчерпана квота Firebase` (`resource-exhausted`) | дневной лимит тарифа Spark | дождаться сброса квоты; данные остаются на устройстве |
| «Ошибка синхронизации» без кода | нет сети или истёк вход | проверить сеть; выйти из аккаунта и войти снова |
| Данные есть на одном устройстве и нет на другом | синхронизация ещё не сработала | нажать «Синхронизировать сейчас» или вернуться на вкладку |

### Если `permission-denied` остаётся после публикации правил

1. **Правила для нужного продукта.** Нужен раздел *Firestore Database → Rules* (не Realtime Database
   и не Storage). Вверху страницы должны быть база `(default)` и проект `mentor-1c954`
   (он же в [`.firebaserc`](../.firebaserc)).
2. **Правила действительно применились.** После **Publish** вкладка Rules показывает текст из
   [`../firestore.rules`](../firestore.rules) с `match /users/{uid}/{document=**}`. Если внизу остался
   `allow read, write: if false;`, публикация не прошла.
3. **App Check не в режиме Enforce.** App Check → *Cloud Firestore*: при включённом **Enforce** запросы
   отвергаются даже с верными правилами. Для PWA на GitHub Pages снимите Enforce или добавьте
   debug-токен.
4. **Вход выполнен под тем же пользователем**, что указан в правилах: приложение пишет в
   `users/{uid}/…`, где `uid` берётся из токена Firebase.
5. **База именно `(default)`.** Engine не передаёт `databaseId`, значит используется база по умолчанию.

Текст ошибки в интерфейсе показывает этап и подсказку; исходное сообщение Firebase
(`Missing or insufficient permissions.`) печатается в консоль браузера с префиксом `[sync:pull]`.

Полное описание схемы, алгоритма и квот — в [`SYNC.md`](SYNC.md).


## Ошибка «Failed to fetch»

Запрос вообще не дошёл до воркера. Проверяйте по порядку:

| Причина | Как отличить | Что делать |
| --- | --- | --- |
| Неверное имя workers.dev-поддомена | в браузере `DNS_PROBE_FINISHED_NXDOMAIN` | взять точный адрес из вывода `wrangler deploy` или из дашборда (`Workers & Pages` → **Your subdomain**) |
| Поддомен не зарегистрирован | при деплое wrangler спрашивает `What would you like your workers.dev subdomain to be?` | зарегистрировать поддомен в дашборде / подтвердить e-mail аккаунта Cloudflare |
| Маршрут воркера выключен | дашборд → воркер → **Settings → Domains & Routes** → workers.dev **Disabled** | включить |
| В поле адреса лишний путь или слэш | адрес вида `...workers.dev/api` | оставить только схему + хост |

Проверка имени без браузера:

```powershell
curl.exe -s -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=<worker>.workers.dev&type=A"
```

`"Status":0` + блок `"Answer"` — имя существует; `"Status":3` — имени нет (NXDOMAIN).

> CORS тут не при чём: при `Failed to fetch` в консоли будет `net::ERR_NAME_NOT_RESOLVED`
> или `net::ERR_CONNECTION_*`, а не сообщение про `Access-Control-Allow-Origin`.

## Запрос обрывается: «Load failed»

`Load failed` — сетевой текст ошибки Safari/iOS (в Chrome — `Failed to fetch`). HTTP-ответа
нет вообще: отклонились сам `fetch` или чтение потока. Разбор книги — один длинный SSE-стрим
(DeepSeek думает, ищет в вебе и только потом печатает), поэтому обрыв почти всегда означает,
что соединение закрыли раньше времени.

| Причина | Как проверить | Что делать |
| --- | --- | --- |
| DeepSeek долго молчит до первого байта (`reasoning_effort: high` + веб-поиск) | `npm run probe:book` → строка «Первый чанк» больше 60 с | **Настройки → Глубина размышлений → `low`** и повторить запрос |
| Простой соединения: сон экрана, мобильный Safari, переключение сети | ошибка через 1–3 минуты, в логах воркера — `✖ стрим отменён клиентом` | не гасить экран, повторить запрос (воркер шлёт heartbeat-пинги каждые 10 с простоя) |
| Service worker или установленная PWA | в обычной вкладке браузера тот же запрос проходит | пользоваться вкладкой, переустановить PWA (сбросить кэш) |

### Что уже защищено

Обрыв больше не выглядит как «Load failed» без объяснений:

| Место | Поведение | Предел |
| --- | --- | --- |
| Клиент, ожидание заголовков | `FirstByteTimeoutError` → совет проверить прокси/веб-поиск | 90 с |
| Клиент, чтение потока | обрыв сети → русский текст с подсказкой про Safari/Chrome | — |
| Воркер, ожидание DeepSeek | `504`, текст «DeepSeek не ответил заголовками за … мс» | 60 с |
| Воркер, простой стрима | SSE-пинг `: ping` каждые 10 с из awaited-цикла (`Promise.race` с чтением upstream) — прокси и Safari не считают соединение мёртвым | 10 с |
| Воркер, обрыв чтения upstream | кадр `event: error` с причиной и `[DONE]` — вместо сетевой ошибки у клиента | — |
| Воркер, общий лимит стрима | кадр `event: error` и закрытие потока | 240 с |
| Воркер, проверка канала | `GET /api/diag/stream?seconds=60` — пинги без участия DeepSeek | — |

Незавершённый ответ не теряется: разбор книги сохраняется в библиотеку как «… (черновик)»,
частичный ответ ментора — как сообщение в теме, а в интерфейсе появляется подсказка,
что текст неполный.

### После обновления: фронт сам, воркер руками

GitHub Actions собирает и публикует только приложение (GitHub Pages). Воркер Cloudflare
обновляется отдельно — после изменений в `worker/` его нужно задеплоить, иначе новых
heartbeat-пингов, лимита 240 с и ответа `504` на проде не будет:

```powershell
cd worker
npm.cmd run deploy            # = proxy:deploy, то же что npx.cmd -y wrangler@latest deploy
Invoke-RestMethod https://<worker>.workers.dev/health | ConvertTo-Json
```

Если wrangler ещё не авторизован — сначала `npm.cmd run proxy:login`. Адрес воркера
после деплоя не меняется, поэтому в «Настройках» приложения ничего править не нужно.

### Как убедиться, что на проде новая версия

В `/health` воркер отдаёт id своей версии (binding `CF_VERSION_METADATA` в
[`../worker/wrangler.toml`](../worker/wrangler.toml)) и текущие лимиты стрима:

```json
{
  "ok": true,
  "service": "nastavnik-deepseek-proxy",
  "version": "880e833c-58a8-4c79-bb8f-5e21d3c5a283",
  "tag": null,
  "deployedAt": "2026-11-26T14:33:00.000Z",
  "stream": { "headersTimeoutMs": 60000, "idlePingMs": 10000, "limitMs": 240000 }
}
```

`version` должен совпадать с `Current Version ID` из вывода `npm.cmd run deploy`.
Если совпадает, а `stream.limitMs` = `240000` — на проде именно свежий код, и
`wrangler tail` для этого не нужен.

### Проверить heartbeat-пинги (без DeepSeek)

`GET /api/diag/stream` отдаёт SSE-стрим с пингами и не обращается к модели — так видно,
доходят ли пинги через Cloudflare и вашу сеть:

```powershell
curl.exe -N -H "x-app-token: <APP_TOKEN>" "https://<worker>.workers.dev/api/diag/stream?seconds=60&ping=10"
```

Ожидаемо: кадр `{"ok":true,"event":"start",…}`, затем `: ping` каждые 10 с, в конце
`{"ok":true,"event":"end","elapsedMs":…,"pings":…}` и `data: [DONE]`. Поле `pings` в кадре `end`
показывает, сколько пингов реально ушло: если оно нулевое, а стрим длился минуту — heartbeat
не сработал, ищите в логах воркера строки `[proxy] · ping …`. Если пинги идут, а ответ DeepSeek
всё равно обрывается — виноват upstream (DeepSeek/веб-поиск), а не канал.

Та же логика проверяется офлайн, без деплоя и без ключей DeepSeek:

```powershell
npm.cmd run test:worker     # scripts/test-worker.mjs: health, 401, diag, пинги в простое, обрыв upstream
```

Тест идёт около 15 с: ждёт пинг на 10-й секунде молчащего upstream и проверяет, что обрыв
чтения превращается в кадр `event: error` с русским текстом.

### Логи воркера

```powershell
cd worker
npm.cmd run proxy:tail
```

Каждый запрос печатает строки (формат `[proxy] …`):

```
[proxy] → POST /chat/completions · stream
[proxy] ← 200 за 1840 мс (заголовки upstream, стрим)
[proxy] · ping 1 @ 10250 мс (от DeepSeek 4557 Б)
[proxy] ✔ стрим завершён: 51240 Б за 71230 мс (пингов 6)
```

`←` — DeepSeek ответил заголовками (это время до первого байта), `· ping` — в простое ушёл
heartbeat (пишется первый и каждый шестой пинг), `✔` — поток дошёл до конца,
`✖ стрим отменён клиентом: N Б, пингов K` — обрыв на стороне устройства или сети (или кнопка «Стоп»),
`✖ чтение upstream прервано через N мс (M Б, пингов K): terminated` — DeepSeek/Cloudflare закрыл поток
(клиент при этом получает кадр `event: error` с русским текстом, а не «Load failed»),
`✖ стрим дольше 240 с` — сработал защитный лимит воркера,
`✖ DeepSeek не ответил заголовками за 60000 мс` — DeepSeek молчал дольше минуты (клиент получит `504`),
`✖ upstream недоступен` — воркер не смог связаться с DeepSeek.

Если `wrangler tail` циклически пишет `Tail connection lost: the Worker did not respond to a
keep-alive ping within 10000ms` — это обрыв служебного соединения CLI (VPN, мобильный NAT,
антивирус с проверкой HTTPS), а не зависание воркера: `/health` в это время отвечает `200`.
Опции увеличить keep-alive у `tail` нет. Те же строки `[proxy] …` смотрите в дашборде:
**Workers & Pages → `nastavnik-deepseek-proxy` → Logs → Live** (до 10 клиентов одновременно —
закройте лишние окна `tail`) либо в **Workers Logs** (наблюдаемость включена в
[`../worker/wrangler.toml`](../worker/wrangler.toml), логи хранятся несколько дней — удобно
разбирать обрыв уже после того, как он случился).

### Повтор запроса с компьютера

`npm run probe:book` отправляет тот же запрос, что и страница «Библиотека» (тот же системный
промпт, `thinking`, веб-поиск) и печатает тайминги — так видно, кто именно рвёт соединение:

```powershell
$env:PROXY_URL = "https://nastavnik-deepseek-proxy.<subdomain>.workers.dev"
$env:APP_TOKEN = "<APP_TOKEN>"
npm.cmd run probe:book                      # как в приложении (effort=low)
npm.cmd run probe:book -- --effort high      # тяжёлый режим: дольше ждать первый байт
npm.cmd run probe:book -- --help            # все ключи
```

Чтобы отделить DeepSeek от Cloudflare, повторите тот же запрос **напрямую** в API, минуя
воркер, — понадобится ключ DeepSeek:

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
npm.cmd run probe:book -- --direct
```

Если `--direct` обрывается на тех же ~70 с, значит стрим рвёт сам DeepSeek (чаще всего на
`reasoning_effort` + веб-поиске) — понижайте глубину размышлений и убирайте веб-инструменты.
Если напрямую стрим доходит, а через воркер нет — смотрите логи воркера (`· ping`,
`✖ чтение upstream прервано`) и обновите деплой.

Токен не печатается и никуда не сохраняется. Если с компьютера стрим доходит целиком,
а на телефоне рвётся — причина в клиенте (сеть, сон, PWA), а не в DeepSeek.

## Ошибка `404 not_found_error` от DeepSeek

Значит воркер работает, но запрос ушёл на несуществующий путь. У DeepSeek маршруты **без**
префикса `/api`: `/models`, `/user/balance`, `/chat/completions`. Клиент «Наставника» ходит
в воркер по `/api/*`, и воркер обязан срезать префикс:

```js
const upstreamPath = path.slice('/api'.length) || '/';
const target = `${DEEPSEEK_BASE}${upstreamPath}${url.search}`;
```

Если в ответе есть `request_id` — ответ точно от DeepSeek, то есть проблема в пути, а не в токене.

## Ошибка `401`

Токен в поле **Токен приложения** не совпадает с секретом `APP_TOKEN` на воркере
(либо секрет не задан — тогда воркер отвечает `500` с явным текстом).

## Ошибка `400` от DeepSeek

Запрос дошёл до модели, но она не приняла часть параметров. Клиент «Наставника» страхуется сам:
при `400` он повторяет запрос **без серверных веб-инструментов** (`deepseek_web_search`,
`deepseek_read_url`), а если это не помогло — **без режима размышлений**
(`thinking` / `reasoning_effort`). Успешный фолбэк виден в консоли браузера как
`[agent] ответ получен в упрощённом режиме (…)`.

| Причина | Признак в тексте ошибки | Что делать |
| --- | --- | --- |
| веб-инструменты объявлены для модели, которая их не поддерживает | `tools`, `deepseek_web_search`, `unknown tool` | держать веб-поиск включённым только для `deepseek-flash` (клиент и сам не отправляет их другим моделям) |
| модель не принимает `thinking` / `reasoning_effort` | `thinking`, `reasoning_effort` | фолбэк снимает их автоматически; если `400` остаётся — сменить модель на `deepseek-flash` |
| слишком большой `max_tokens` | `max_tokens` | лимит задан в коде (`src/lib/api/agent.ts`), уменьшите значение |
| модель вернула невалидные аргументы `save_plan` | `Структура плана не прошла проверку: …` — это **не** HTTP-ошибка, а проверка zod | ответить на уточняющие вопросы ещё раз |

Если в тексте ошибки несколько фрагментов через `→`, значит не сработал ни один вариант:
`полный запрос: … → без веб-инструментов: … → без веб-инструментов и размышлений: …`.

## PowerShell блокирует `npm` / `npx`

`npm.ps1 cannot be loaded because running scripts is disabled on this system`
(`ExecutionPolicy = Restricted`). Варианты:

```powershell
npx.cmd -y wrangler@latest deploy               # обёртка .cmd — работает всегда
# либо разово разрешить локальные скрипты:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## Проверка воркера по шагам

```powershell
$w = "https://nastavnik-deepseek-proxy.<workers-subdomain>.workers.dev"
curl.exe -i "$w/health"                                            # 200 {"ok":true,...}
curl.exe -i "$w/api/models"                                        # 401 — защита токеном работает
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/models"           # 200, список моделей
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/user/balance"     # 200, is_available
```

Preflight браузера: `curl.exe -i -X OPTIONS -H "Origin: https://yurikarandeev.github.io" <адрес>/api/models`
должен вернуть `204` и `access-control-allow-origin`.

## `git` не найден в PATH

Если PowerShell отвечает `The term 'git' is not recognized`, а GitHub Desktop установлен,
рабочий бинарник лежит внутри него:

```powershell
$git = Join-Path $env:LOCALAPPDATA 'GitHubDesktop\app-3.6.7\resources\app\git\cmd\git.exe'
& $git status
```

Номер версии в пути меняется после обновления GitHub Desktop — подставьте актуальный
(`Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop"`).

## Локальная отладка без деплоя

```powershell
cd worker
# .dev.vars: DEEPSEEK_API_KEY=sk-... и APP_TOKEN=dev-token
npx.cmd -y wrangler@latest dev
```

В приложении адрес прокси `http://127.0.0.1:8787`, токен `dev-token`. `ALLOWED_ORIGINS`
в `wrangler.toml` уже содержит `http://localhost:5173`; со страницы GitHub Pages
`http://127.0.0.1` тоже разрешён (loopback не считается mixed content).
