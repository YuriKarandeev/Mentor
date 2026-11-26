# Прокси DeepSeek для «Наставника» (Cloudflare Worker)

Воркер прячет ключ DeepSeek и не даёт браузеру обращаться к API напрямую.
Клиент присылает только короткий `x-app-token`, который вы сами придумываете.

## Что делает

| Метод | Путь воркера | Путь в DeepSeek | Назначение |
| --- | --- | --- | --- |
| `GET` | `/health` | — | проверка живости воркера |
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
npm.cmd run proxy:deploy     # proxy:login, proxy:dev, proxy:tail, proxy:secret:key, proxy:secret:token
```

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
curl.exe -i "$w/health"                                                # 200 {"ok":true,...}
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/models"              # 200, список моделей
curl.exe -i -H "x-app-token: <APP_TOKEN>" "$w/api/user/balance"        # 200, is_available
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
| `[proxy] ✔ стрим завершён: N Б за M мс` | поток дошёл до конца |
| `[proxy] ✖ клиент закрыл соединение через N мс` | поток закрыл клиент: сон экрана, мобильный Safari, кнопка «Стоп» |
| `[proxy] ✖ upstream недоступен через N мс: …` | `fetch` к `api.deepseek.com` не удался |

Секреты и тела запросов в логи не попадают. Повторить тот же запрос с компьютера и
сравнить тайминги: `npm.cmd run probe:book` из корня репозитория (разбор — в
[`../docs/SETUP.md`](../docs/SETUP.md), раздел «Запрос обрывается: «Load failed»»).

## Замечания

- Ключ DeepSeek хранится только как секрет воркера; в репозиторий и в браузер он не попадает.
- Ответы DeepSeek не кешируются (`cache-control: no-store`).
- Стриминг не буферизуется (`x-accel-buffering: no`), поэтому первые токены приходят сразу.
