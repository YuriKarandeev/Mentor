# Прокси DeepSeek для «Наставника» (Cloudflare Worker)

Воркер прячет ключ DeepSeek и не даёт браузеру обращаться к API напрямую.
Клиент присылает только короткий `x-app-token`, который вы сами придумываете.

## Что делает

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/health` | проверка живости воркера |
| `GET` | `/api/models` | список моделей (кнопка «Проверить связь») |
| `GET` | `/api/user/balance` | баланс аккаунта |
| `POST` | `/api/chat/completions` | чат, включая `stream: true` — ответ идёт потоком |

Остальные пути → `404`. Без корректного `x-app-token` → `401`.

## Развёртывание

```powershell
cd worker
npx wrangler login                 # один раз
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put APP_TOKEN  # придумайте длинную случайную строку
npx wrangler deploy
```

`wrangler deploy` выведет адрес вида `https://nastavnik-deepseek-proxy.<account>.workers.dev` —
его нужно вставить в приложении: **Настройки → Адрес прокси**.

Тот же `APP_TOKEN` вводится в поле **Токен приложения**. Без него воркер отвечает `401`.

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
# .dev.vars:
# DEEPSEEK_API_KEY=sk-...
# APP_TOKEN=dev-token
npx wrangler dev
```

Затем в приложении (`npm run dev`) укажите адрес прокси `http://127.0.0.1:8787`
и токен `dev-token`.

## Быстрая проверка из консоли

```powershell
curl "https://<worker>.workers.dev/health"
curl -H "x-app-token: <APP_TOKEN>" "https://<worker>.workers.dev/api/models"
```

## Замечания

- Ключ DeepSeek хранится только как секрет воркера; в репозиторий и в браузер он не попадает.
- Ответы DeepSeek не кешируются (`cache-control: no-store`).
- Стриминг не буферизуется (`x-accel-buffering: no`), поэтому первые токены приходят сразу.
