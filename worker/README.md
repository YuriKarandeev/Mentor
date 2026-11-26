# Прокси DeepSeek для «Наставника» (Cloudflare Worker)

Воркер прячет ключ DeepSeek и не даёт браузеру обращаться к API напрямую.
Клиент присылает только короткий `x-app-token`, который вы сами придумываете.

## Что делает

| Метод | Путь воркера | Путь в DeepSeek | Назначение |
| --- | --- | --- | --- |
| `GET` | `/health` | — | живость, id версии деплоя и текущие лимиты стрима |
| `GET` | `/api/diag/stream` | — | диагностический SSE-стрим с пингами (нужен `x-app-token`) |
| `GET` | `/api/models` | `GET /models` | список моделей (кнопка «Проверить связь») |
| `GET` | `/api/user/balance` | `GET /user/balance` | баланс аккаунта |
| `POST` | `/api/chat/completions` | `POST /chat/completions` | чат, включая `stream: true` — ответ идёт потоком |

Клиент всегда ходит с префиксом `/api`, а у DeepSeek маршруты без него — префикс срезается
перед запросом к `https://api.deepseek.com`. Остальные пути → `404`.
Без корректного `x-app-token` → `401`.

## Развёртывание

```powershell
cd worker
npx.cmd -y wrangler@latest login                 # один раз
npx.cmd -y wrangler@latest secret put DEEPSEEK_API_KEY
npx.cmd -y wrangler@latest secret put APP_TOKEN  # придумайте длинную случайную строку
npx.cmd -y wrangler@latest deploy
```

Если `npm`/`npx` без `.cmd` падают с `... cannot be loaded because running scripts is disabled`
(ExecutionPolicy `Restricted`), используйте обёртки `npm.cmd` / `npx.cmd` — либо разово разрешите
скрипты для текущего пользователя:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

То же самое через скрипты из `worker/package.json` (не требуют установки зависимостей):

```powershell
npm.cmd run deploy           # = proxy:deploy: npx -y wrangler@latest deploy
npm.cmd run tail             # = proxy:tail: npx -y wrangler@latest tail
npm.cmd run proxy:deploy     # полный набор: proxy:login, proxy:dev, proxy:tail, proxy:secret:key, proxy:secret:token
```

После деплоя проверьте, что на проде именно свежая версия (это быстрее и надёжнее `tail`):

```powershell
Invoke-RestMethod "https://nastavnik-deepseek-proxy.<workers-subdomain>.workers.dev/health" | ConvertTo-Json
```

`version` в ответе совпадает с `Current Version ID` из вывода `deploy`, `stream.limitMs` = `240000`,
`stream.idlePingMs` = `10000`. Значение `null` в `version` значит, что биндинг `CF_VERSION_METADATA`
не подхватился — передеплойте из каталога `worker/`.

`wrangler deploy` выводит адрес вида `https://nastavnik-deepseek-proxy.<workers-subdomain>.workers.dev`.
**Запомните имя своего workers.dev-поддомена** — оно задаётся один раз на аккаунт и попадает в каждый
адрес. Если при деплое wrangler спрашивает `What would you like your workers.dev subdomain to be?` —
поддомен ещё не зарегистрирован; зарегистрировать его можно и в дашборде (`Workers & Pages` → **Your subdomain**).

Этот адрес (без пути и без слэша на конце) вставляется в приложении: **Настройки → Адрес прокси**.
Тот же `APP_TOKEN` вводится в поле **Токен приложения**. Без него воркер отвечает `401`.

> Если поддомен указан неверно, браузер покажет `Failed to fetch`: имени просто нет в DNS
> (`DNS_PROBE_FINISHED_NXDOMAIN`). Проверить можно так:
> `curl.exe -s -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=<worker>.workers.dev&type=A"`
> — `"Status":0` и блок `"Answer"` значат, что адрес существует.

## Ограничение источников

В `wrangler.toml` есть `ALLOWED_ORIGINS`. Пустое значение разрешает любые origin
(защита остаётся на `APP_TOKEN`). Лучше перечислить свои адреса:

```toml
[vars]
ALLOWED_ORIGINS = "https://USERNAME.github.io,http://localhost:5173"
```

## Локальная отладка

```powershell
cd worker
# .dev.vars (в git не попадает):
# DEEPSEEK_API_KEY=sk-...
# APP_TOKEN=dev-token
npx.cmd -y wrangler@latest dev
```

Затем в приложении (`npm run dev`) укажите адрес прокси `http://127.0.0.1:8787`
и токен `dev-token`. `ALLOWED_ORIGINS` уже содержит `http://localhost:5173`.

## Быстрая проверка из консоли

```powershell
$w = "https://nastavnik-deepseek-proxy.<workers-subdomain>.workers.dev"
curl.exe -i "$w/health"                                                       # 200 {"ok":true,"version":"...","stream":{...}}
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/models"                     # 200, список моделей
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/user/balance"               # 200, is_available
curl.exe -N -H "x-app-token: <APP_TOKEN>" "$w/api/diag/stream?seconds=30&ping=10"  # пинг каждые 10 с
```

В PowerShell 5.1 `curl` — это алиас `Invoke-WebRequest`, а не настоящий curl: используйте `curl.exe`.
Без `x-app-token` оба запроса вернут `401` — это ожидаемо и подтверждает, что защита работает.

## Диагностика долгого стрима (`Load failed` на клиенте)

Воркер пишет в лог по строке на каждый запрос — видно в `npm.cmd run proxy:tail`
или в дашборде Cloudflare (воркер → **Logs**):

| Строка | Что значит |
| --- | --- |
| `[proxy] → POST /chat/completions · stream` | запрос пришёл в воркер |
| `[proxy] ← 200 за N мс (заголовки upstream, стрим)` | DeepSeek ответил заголовками — это и есть время до первого байта |
| `[proxy] · ping 1 @ 10250 мс (от DeepSeek 4557 Б)` | в простое ушёл пинг; пишется первый и каждый шестой — видно, работает ли heartbeat на проде |
| `[proxy] ✔ стрим завершён: N Б за M мс (пингов K)` | поток дошёл до конца |
| `[proxy] ✖ стрим отменён клиентом: N Б, пингов K, за M мс` | поток закрыл клиент: сон экрана, мобильный Safari, кнопка «Стоп» |
| `[proxy] ✖ чтение upstream прервано через M мс (N Б, пингов K): terminated` | DeepSeek закрыл поток — клиент получает кадр `event: error`, а не «Load failed» |
| `[proxy] ✖ стрим дольше 240 с — закрываю (N Б, пингов K)` | сработал защитный лимит: клиент получит кадр `event: error` |
| `[proxy] ✖ DeepSeek не ответил заголовками за 60000 мс` | ответ на запрос — `504`, стрим даже не начался |
| `[proxy] ✖ upstream недоступен через N мс: …` | `fetch` к `api.deepseek.com` не удался |

Воркер сам следит за живостью соединения: тело ответа DeepSeek читается явно
(`new ReadableStream` + `reader.read()`), а пинги шлёт фоновый цикл — каждый шаг ждёт
`Promise.race([reader.read(), таймер на 10 с])`. При простое дольше 10 с в поток уходит
комментарий `: ping`, поэтому Safari и промежуточные прокси не считают соединение мёртвым.

Важно: `start(controller)` у потока **синхронный**, а чтение upstream живёт в фоновой задаче
`pump`. Если сделать `async start` и ждать в нём `reader.read()`, workerd держит поток в
состоянии «starting» и кадры, добавленные из таймеров, до клиента не доходят — именно так
на проде терялись пинги, пока DeepSeek молчал (`/api/diag/stream` с синхронным `start`
отдавал их нормально).

Полный лимит на один стрим — 240 с, отдельно ограничено ожидание заголовков (60 с). Когда
клиент закрывает вкладку или жмёт «Стоп», чтение upstream отменяется, чтобы не тратить токены.

### Проверить канал отдельно от DeepSeek

`GET /api/diag/stream?seconds=60&ping=10` отдаёт SSE-стрим с пингами и не обращается к модели:

```powershell
curl.exe -N -H "x-app-token: <APP_TOKEN>" "$w/api/diag/stream?seconds=60&ping=10"
```

Ожидаемо: `{"ok":true,"event":"start",…}`, затем `: ping` каждые 10 с, в конце
`{"ok":true,"event":"end","elapsedMs":…,"pings":…}` и `data: [DONE]`. Поле `pings` в кадре `end`
показывает, сколько пингов реально ушло: если оно равно нулю, а стрим длился минуту —
heartbeat не сработал, смотрите строки `[proxy] · ping …` в логах воркера.
Если пинги приходят, а ответ DeepSeek всё равно обрывается на ~70 с — рвётся upstream
(DeepSeek/веб-поиск), а не канал.

Логика воркера проверяется офлайн, без деплоя и без ключей:

```powershell
cd ..                          # из worker/ — в корень репозитория
npm.cmd run test:worker        # scripts/test-worker.mjs: health, 401, diag, пинги, обрыв upstream
```

Если `wrangler tail` циклически пишет `Tail connection lost: the Worker did not respond to a
keep-alive ping within 10000ms` — это обрыв служебного WebSocket у CLI (VPN, мобильный NAT,
антивирус с проверкой HTTPS), а не падение воркера: `/health` в это время отвечает `200`.
Увеличить keep-alive у `tail` нельзя. Смотрите логи в дашборде: **Workers & Pages → воркер →
Logs → Live** (не больше 10 клиентов одновременно) или **Workers Logs** — наблюдаемость
включена (`[observability] enabled = true`), логи доступны и после инцидента.

Секреты и тела запросов в логи не попадают. Повторить тот же запрос с компьютера и
сравнить тайминги: `npm.cmd run probe:book` из корня репозитория (разбор — в
[`../docs/SETUP.md`](../docs/SETUP.md), раздел «Запрос обрывается: «Load failed»»).

## Замечания

- Ключ DeepSeek хранится только как секрет воркера; в репозиторий и в браузер он не попадает.
- Ответы DeepSeek не кешируются (`cache-control: no-store`).
- Стриминг не буферизуется (`x-accel-buffering: no`), поэтому первые токены приходят сразу.
