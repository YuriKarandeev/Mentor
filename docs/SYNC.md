# Синхронизация между устройствами

Приложение остаётся **local-first**: источник истины — IndexedDB (Dexie) в браузере.
Firebase используется только как канал обмена, поэтому приложение работает офлайн и без аккаунта.

- Без входа: всё как раньше, данные лежат только на устройстве.
- Со входом через Google: локальная база зеркалится в `users/{uid}/…` вашего проекта Firebase.
- Настройки устройства (`kv.settings`: ключ DeepSeek, адрес прокси, `APP_TOKEN`, модель, тема) **никогда** не уходят в облако —
  они относятся к конкретному браузеру. Профиль ученика синхронизируется.

Код: `src/lib/sync/` (`config`, `firebase`, `model`, `engine`, `errors`, `state.svelte`), правила — `firestore.rules`.
`errors.ts` переводит коды Firebase в русские тексты с этапом и подсказкой; проверяется в `npm run test:sync`.

## Что нужно сделать один раз в консоли Firebase

Проект: **mentor-1c954** (конфигурация в `src/lib/sync/config.ts`).

1. **Authentication → Get started → Sign-in method → Google**: включить провайдер, указать e-mail поддержки.
2. **Authentication → Settings → Authorized domains**: добавить
   - `yurikarandeev.github.io` (GitHub Pages),
   - `localhost` (локальная разработка).
3. **Firestore Database → Create database**: регион `eur3` (Europe, multi-region), режим **production**.
4. **Firestore → Rules**: вставить содержимое [`firestore.rules`](../firestore.rules) и опубликовать.
   Через CLI: `npx.cmd -y firebase-tools deploy --only firestore:rules` (проект задан в `.firebaserc`).

Проверка без браузера: `curl.exe -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<API_KEY>" -H "Content-Type: application/json" -d "{\"returnSecureToken\":true}"`.
Ответ с `CONFIGURATION_NOT_FOUND` означает, что Authentication не инициализирован или Google-провайдер выключен.

## Модель данных в Firestore

```
users/{uid}/
  profile/main         { name, occupation, level, goals[], interests[], preferredStyle, updatedAt, srvUpdatedAt }
  topics/{topicId}     { title, goal, level, hoursPerWeek, status, createdAt, updatedAt, srvUpdatedAt }
  plans/{planId}       { topicId, title, summary, modules[], createdAt, updatedAt, srvUpdatedAt }
  messages/{msgId}     { topicId, role, content, reasoning, citations[], createdAt, updatedAt, srvUpdatedAt }
  notes/{noteId}       { topicId, title, md, source, tags[], citations[], createdAt, updatedAt, srvUpdatedAt }
  memory/{topicId}     { text, updatedAt, srvUpdatedAt }
  events/{eventId}     { title, date, time, endTime, allDay, notes, createdAt, updatedAt, srvUpdatedAt }
  tasks/{taskId}       { title, notes, days[], onceDate, time, done[], createdAt, updatedAt, srvUpdatedAt }
  projects/{projectId} { title, goal, notes, status, dueDate, createdAt, updatedAt, srvUpdatedAt }
  projectCards/{cardId} { projectId, title, notes, column, order, dueDate, createdAt, updatedAt, srvUpdatedAt }
  accounts/{accountId} { title, kind, openingBalance, includeInFree, archived, order, notes, createdAt, updatedAt, srvUpdatedAt }
  categories/{catId}   { title, kind, group, essential, icon, archived, order, createdAt, updatedAt, srvUpdatedAt }
  transactions/{txId}  { date, type, amount, accountId, toAccountId, categoryId, payee, notes, obligationId, createdAt, updatedAt, srvUpdatedAt }
  budgets/{YYYY-MM}    { expectedIncome, savingsTarget, lines[{categoryId,limit}], notes, createdAt, updatedAt, srvUpdatedAt }
  obligations/{obId}   { title, kind, amount, frequency, dueDay, dueDate, active, remind, categoryId, accountId, assetId, notes, createdAt, updatedAt, srvUpdatedAt }
  assets/{assetId}     { title, kind, assetClass, value, ratePercent, notes, createdAt, updatedAt, srvUpdatedAt }
  snapshots/{YYYY-MM-DD} { date, assetsTotal, liabilitiesTotal, netWorth, notes, createdAt, updatedAt, srvUpdatedAt }
  push/{deviceId}      { endpoint, keys{p256dh,auth}, label, ua, timeZone, updatedAt }
  pushPlan/{deviceId}  { items[{key,at,title,body,tag,url}], leadMinutes, timeZone, version, testAt? }
  pushState/{deviceId} { sent{key:ISO}, lastRunAt, lastTestAt, lastError, updatedAt }
  tombstones/{type:id} { type, refId, deletedAt, origin, srvUpdatedAt }
```

События календаря живут отдельной коллекцией: они не привязаны к теме, поэтому удаление темы
их не затрагивает. Дата хранится строкой `ГГГГ-ММ-ДД` (локальный день пользователя), время —
`ЧЧ:ММ`; «весь день» — пустое время и `allDay: true`.

Дела (`tasks`) — повторяющиеся задачи. `days` — дни недели `0…6` (0 — понедельник),
`onceDate` — дата разового дела (тогда `days` пуст), `done` — история отметок по датам.
Удаление темы дел не затрагивает.

Проекты (`projects`) и их карточки (`projectCards`) — канбан-доска. `column` принимает
`todo`, `doing` или `done`, `order` — место внутри колонки (целое число, при перемещении
перенумеровывается без пропусков). Карточка без `projectId` или без названия не применяется.
Удаление проекта убирает и его карточки: локально, надгробиями `project`/`projectCard`
и отдельной зачисткой коллекции в облаке.

### Бюджет в облаке

Семь коллекций бюджета устроены так же, как события и дела: белый список полей, `updatedAt`
и `dirty` на устройстве, разрешение конфликтов «побеждает более новый». Особенности:

- **Суммы — целые копейки** и на устройстве, и в облаке. Это важно: `normalizeAccount` и
  другие нормализаторы числа не пересчитывают, иначе сумма при каждом круге синхронизации
  умножалась бы на 100.
- `budgets/{YYYY-MM}` — id документа равен месяцу. Бюджет января один на всех устройствах,
  а кривой id (не «ГГГГ-ММ») движок отбрасывает.
- `snapshots/{YYYY-MM-DD}` — один снимок капитала в день; `netWorth` при приёме
  пересчитывается как `assetsTotal − liabilitiesTotal`, а не берётся из документа.
- `transactions` без валидной даты, нулевой суммы или без счёта не применяются: такая
  операция не участвует ни в остатке, ни в потоке.
- Надгробия (`account`, `category`, `transaction`, `budget`, `obligation`, `asset`,
  `snapshot`) удаляют локальную строку, только если она не новее самого надгробия.
- `accounts` и `obligations` на устройствах не связаны жёстко: если счёт удалён, его операции
  остаются в журнале, но перестают попадать в остатки. Поэтому клиент не даёт удалить счёт
  с операциями — только архив.

Коллекции `push`, `pushPlan`, `pushState` — не данные ученика, а транспорт напоминаний:
их пишет только клиент (подписка устройства и готовый план на две недели), а `pushState`
заполняет workflow `notify.yml`, когда отправляет уведомление. Движок синхронизации их
не читает и не зеркалит: у каждой коллекции ключ — `deviceId`, поэтому устройства друг
друга не перезаписывают. Правила Firestore для них те же: владелец `users/{uid}`.

Правила доступа: только владелец (`request.auth.uid == uid`), всё остальное закрыто.
`apiKey` в клиенте — не секрет; доступ ограничивают правила.


## Алгоритм

1. **Pull.** Для каждой коллекции запрашиваются документы с `srvUpdatedAt >` курсора
   (`serverTimestamp()`, поэтому расхождение часов устройств не мешает).
   Страницами по 200, окно перекрывается на 10 минут как страховка от гонок.
2. **Push.** Записи с `dirty = 1` уходят батчами `writeBatch` (≤ 400 операций),
   им проставляется серверная метка `srvUpdatedAt`. Флаг `dirty` снимается только
   у той версии, которую реально отправили.
3. **Повтор.** Цикл повторяется до 4 раз, пока есть что тянуть или отправлять.
4. **Конфликты.** Побеждает запись с большим `updatedAt` (last-write-wins).
   При равных метках остаётся локальная копия.
5. **Удаления.** Удаление строки создаёт «надгробие» (`tombstones`) — оно удаляет документ
   в облаке, а другие устройства узнают об удалении. Надгробия от самого устройства
   при pull пропускаются по полю `origin`.
6. **Триггеры.** Старт приложения, вход в аккаунт, `online`, `visibilitychange`,
   изменения в локальной базе (с задержкой ~1.5 с) и опрос раз в 60 секунд.
   Живых подписок `onSnapshot` нет — так экономятся квоты.

Когда pull принёс чужие изменения, растёт `sync.revision`, и открытые страницы
перечитывают данные (кроме момента, когда идёт стриминг ответа модели).

## Что уходит в облако, а что нет

| Данные | В облако |
| --- | --- |
| Темы, планы, сообщения чата, конспекты, память темы | да |
| События календаря и дела с повтором | да |
| Профиль (имя, цели, интересы, стиль) | да |
| `appToken`, `deepseekKey`, адрес прокси, модель, тема оформления | **нет** |
| Экспорт/импорт JSON | остаётся локальной операцией |
| Кэш service worker, настройки устройства | нет |

## Настройка сборки

Значения по умолчанию для конфигурации Firebase лежат в `src/lib/sync/config.ts`.
Их можно переопределить переменными окружения:

| Переменная | Смысл |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | `apiKey` веб-приложения |
| `VITE_FIREBASE_AUTH_DOMAIN` | `<project>.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` |
| `VITE_SYNC_ENABLED` | `0` — полностью выключить синхронизацию |

В CI значения передаются из **Settings → Secrets and variables → Actions → Variables**.
Пустая переменная = значение по умолчанию из `config.ts`.

SDK Firebase грузится динамическим `import()`, поэтому основной бандл не растёт:
Firebase попадает в отдельный чанк (≈110–130 КБ gzip) и скачивается только при инициализации синхронизации.


## Проверка на двух устройствах

1. Устройство A: **Настройки → Синхронизация → Войти через Google**, создать тему и план.
2. Открыть консоль Firebase → Firestore: в `users/<uid>/topics` появился документ.
3. Устройство B: войти тем же аккаунтом, дождаться «Синхронизировано» — тема и план на месте.
4. На B отправить сообщение в чат, на A вернуться на вкладку — сообщение подтянется
   (при возврате фокуса или в течение минуты).
5. На B удалить конспект, на A обновить страницу — конспект исчез.
6. **Настройки → Данные → Удалить всё** на одном устройстве: после синхронизации
   данные удаляются и в облаке (надгробия), на втором устройстве — тоже.
7. Проверить `appToken` и `deepseekKey`: в Firestore не должно быть полей с ключом или адресом прокси.

## Ограничения

- **Квоты Spark** (бесплатный план): 50 000 чтений и 20 000 записей в день. Батчи и курсоры
  держат расход низким, но при интенсивной переписке на нескольких устройствах лимит можно исчерпать.
- **Нет реального времени.** Два устройства сходятся при возврате фокуса, по кнопке
  «Синхронизировать сейчас» или в течение минуты — не мгновенно.
- **Last-write-wins.** Если отметить один и тот же пункт плана на двух устройствах
  одновременно, останется версия с более поздним `updatedAt`; вторая правка потеряется.
- **Надгробия не удаляются из облака.** Они малы (несколько полей) и нужны, чтобы
  «воскресшие» данные не возвращались; при необходимости чистите их вручную в консоли.
- **Удаление темы** дополнительно вычищает её дочерние документы (`plans`, `messages`, `notes`,
  `memory`) запросом `where('topicId','==',…)` — это тратит чтения.

## Частые ошибки

Приложение показывает этап («Чтение из облака: …», «Отправка в облако: …») и подсказку, что делать;
служебный текст Firebase остаётся в консоли браузера с префиксом `[sync:<этап>]`. Сетевые ошибки
движок повторяет сам, а «постоянные» (нет прав, нет базы, истекла сессия) — нет, чтобы не тратить квоту:
после исправления нажмите «Синхронизировать сейчас».

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `Вход: этот домен не разрешён…` (`auth/unauthorized-domain`) | домен не добавлен в Authorized domains | добавить `yurikarandeev.github.io` и `localhost` |
| `Вход: вход через Google выключен` (`auth/operation-not-allowed`) или `auth/configuration-not-found` | провайдер Google выключен либо Auth не инициализирован | Authentication → Sign-in method → Google → Enable |
| `Чтение из облака: Firestore отклонил доступ` (`permission-denied`) | в проекте остались правила по умолчанию `allow read, write: if false` | Firestore Database → **Rules** → вставить [`firestore.rules`](../firestore.rules) → **Publish** → «Синхронизировать сейчас». Ссылка «Открыть правила Firestore» в настройках ведёт сразу в консоль |
| То же, но правила опубликованы | включён **App Check** в режиме *Enforce* для Cloud Firestore | App Check → Cloud Firestore → снять Enforce (или зарегистрировать приложение и добавить debug-токен) |
| `permission-denied` после публикации правил | правила применены не к той базе или не к тому продукту | правила публикуются для базы `(default)` в проекте из `.firebaserc`; убедитесь, что это **Firestore Database → Rules**, а не Realtime Database |
| `permission-denied`, хотя вход выполнен | в правилах нет условия `request.auth.uid == uid` | сравните текст правил с [`firestore.rules`](../firestore.rules): корень должен быть `match /users/{uid}/{document=**}` |
| `Чтение из облака: в проекте нет базы Firestore` (`not-found`) | база не создана | Firestore Database → Create database → регион `eur3`, режим production |
| `исчерпана квота Firebase` (`resource-exhausted`) | дневной лимит тарифа Spark | дождаться сброса квоты; данные остаются на устройстве |
| «The query requires an index» (`failed-precondition`) | в проекте отключены авто-индексы | создать композитный индекс по `srvUpdatedAt` по ссылке из консоли браузера |
| Окно входа не открывается (`auth/popup-blocked`) | блокировщик всплывающих окон | приложение автоматически пробует редирект; разрешить попапы для сайта |
| Синхронизация «залипла» (`unavailable`) | нет сети | проверить сеть; движок повторит сам через несколько секунд |

