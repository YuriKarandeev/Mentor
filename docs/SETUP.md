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
5. **Проверить связь** → зелёный отчёт → **Сохранить**.
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
| Простой соединения: сон экрана, мобильный Safari, переключение сети | ошибка через 1–3 минуты, в `wrangler tail` — `стрим отменён клиентом` | не гасить экран, повторить запрос (воркер шлёт heartbeat-пинги каждые 10 с простоя) |
| Service worker или установленная PWA | в обычной вкладке браузера тот же запрос проходит | пользоваться вкладкой, переустановить PWA (сбросить кэш) |

### Что уже защищено

Обрыв больше не выглядит как «Load failed» без объяснений:

| Место | Поведение | Предел |
| --- | --- | --- |
| Клиент, ожидание заголовков | `FirstByteTimeoutError` → совет проверить прокси/веб-поиск | 90 с |
| Клиент, чтение потока | обрыв сети → русский текст с подсказкой про Safari/Chrome | — |
| Воркер, ожидание DeepSeek | `504`, текст «DeepSeek не ответил заголовками за … мс» | 60 с |
| Воркер, простой стрима | SSE-пинг `: ping` каждые 10 с — прокси и Safari не считают соединение мёртвым | 10 с |
| Воркер, общий лимит стрима | кадр `event: error` и закрытие потока | 240 с |

Незавершённый ответ не теряется: разбор книги сохраняется в библиотеку как «… (черновик)»,
частичный ответ ментора — как сообщение в теме, а в интерфейсе появляется подсказка,
что текст неполный.

### Логи воркера

```powershell
cd worker
npm.cmd run proxy:tail
```

Каждый запрос печатает строки (формат `[proxy] …`):

```
[proxy] → POST /chat/completions · stream
[proxy] ← 200 за 1840 мс (заголовки upstream, стрим)
[proxy] ✔ стрим завершён: 51240 Б за 71230 мс
```

`←` — DeepSeek ответил заголовками (это время до первого байта), `✔` — поток дошёл до конца,
`✖ стрим отменён клиентом: N Б` — обрыв на стороне устройства или сети (или кнопка «Стоп»),
`✖ стрим дольше 240 с` — сработал защитный лимит воркера,
`✖ DeepSeek не ответил заголовками за 60000 мс` — DeepSeek молчал дольше минуты (клиент получит `504`),
`✖ upstream недоступен` — воркер не смог связаться с DeepSeek.

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
