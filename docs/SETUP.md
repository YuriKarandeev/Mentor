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
