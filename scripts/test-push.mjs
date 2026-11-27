#!/usr/bin/env node
/**
 * Офлайн-тест отправителя push-напоминаний (`_push/lib.mjs`).
 *
 *   npm run test:push
 *
 * Сеть не нужна: проверяется чистая логика, которая решает, что и когда
 * отправлять. Настоящая отправка (Firebase Admin + web-push) живёт в
 * `_push/send.mjs` и запускается workflow `notify.yml`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (file) => import(pathToFileURL(path.resolve(file)).href);
const push = await load('_push/lib.mjs');

const {
  GRACE_MS,
  MAX_PER_RUN,
  SENT_TTL_MS,
  TEST_TTL_MS,
  clip,
  dueNow,
  missingSecrets,
  parseMs,
  pendingTestAt,
  planItems,
  pruneSent,
  pushPayload,
  shouldDropSubscription,
  shouldStopRetry,
  testPayload
} = push;

let total = 0;
const failures = [];
const check = (ok, message, details = '') => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}${ok || !details ? '' : ` — ${details}`}`);
};

// Пятница, 27 ноября 2026, 12:00 UTC — «сейчас» во всех проверках.
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const item = (key, offsetMs, extra = {}) => ({
  key,
  at: iso(offsetMs),
  title: `Событие ${key}`,
  body: `Тело ${key}`,
  tag: key,
  url: '#/tasks',
  ...extra
});

const plan = (items, extra = {}) => ({ items, version: 1, leadMinutes: 15, testAt: null, ...extra });

// --- 1. секреты ---
console.log('\nmissingSecrets');
{
  const missing = missingSecrets({});
  check(missing.length === 4, 'пустое окружение — нужны все четыре секрета', missing.join(', '));
  check(missing.includes('FIREBASE_SERVICE_ACCOUNT'), 'просит сервисный аккаунт Firebase');
  check(missing.includes('VAPID_PRIVATE_KEY'), 'просит приватный VAPID-ключ');
  const full = {
    FIREBASE_SERVICE_ACCOUNT: '{}',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:me@example.com'
  };
  check(missingSecrets(full).length === 0, 'все секреты заданы — замечаний нет');
  check(missingSecrets({ ...full, VAPID_SUBJECT: '   ' }).length === 1, 'пробелы не считаются значением');
}

// --- 2. разбор времени ---
console.log('\nparseMs');
{
  check(parseMs('2026-11-27T12:00:00.000Z') === NOW, 'ISO-строка разбирается');
  check(parseMs(NOW) === NOW, 'число остаётся числом');
  check(parseMs(new Date(NOW)) === NOW, 'Date разбирается');
  check(parseMs({ toMillis: () => NOW }) === NOW, 'Firestore Timestamp разбирается');
  check(Number.isNaN(parseMs('не дата')), 'мусор даёт NaN');
  check(Number.isNaN(parseMs(null)), 'null даёт NaN');
  check(Number.isNaN(parseMs(undefined)), 'undefined даёт NaN');
}

// --- 3. элементы плана ---
console.log('\nplanItems');
{
  const items = planItems(
    plan([
      item('ok', -5 * minute),
      { key: 'no-at', title: 'Без времени' },
      { at: iso(0), title: 'Без ключа' },
      { key: 'bad-at', at: 'кривая дата' },
      { tag: 'legacy', at: iso(hour), title: 'Старый формат' }
    ])
  );
  const keys = items.map((entry) => entry.key);
  check(items.length === 2, 'мусорные элементы отбрасываются', JSON.stringify(keys));
  check(keys.includes('ok') && keys.includes('legacy'), 'живые элементы на месте', JSON.stringify(keys));
  check(items.every((entry) => Number.isFinite(entry.at)), 'у всех элементов числовой момент');
  check(planItems({}).length === 0, 'план без items — пустой список');
  check(planItems(null).length === 0, 'null-план — пустой список');
}

// --- 4. созревшие напоминания ---
console.log('\ndueNow');
{
  const due = dueNow(plan([item('a', -10 * minute), item('b', 10 * minute), item('c', -3 * day)]), { now: NOW });
  check(due.length === 1 && due[0].key === 'a', 'будущее и слишком старое не отправляются', JSON.stringify(due.map((i) => i.key)));

  const ordered = dueNow(
    plan([item('late', -5 * minute), item('early', -30 * minute), item('same', -5 * minute)]),
    { now: NOW }
  );
  check(
    ordered.map((entry) => entry.key).join(',') === 'early,late,same',
    'сортировка по времени, при равенстве — по ключу',
    ordered.map((entry) => entry.key).join(',')
  );

  const sent = { a: iso(-9 * minute) };
  const afterSent = dueNow(plan([item('a', -10 * minute)]), { now: NOW, sent });
  check(afterSent.length === 0, 'отправленное повторно не уходит');

  const older = dueNow(plan([item('old', -GRACE_MS - minute)]), { now: NOW });
  check(older.length === 0, 'просрочка больше окна 12 ч отбрасывается');

  const edge = dueNow(plan([item('edge', -GRACE_MS)]), { now: NOW });
  check(edge.length === 1, 'ровно на границе окна — ещё отправляется');

  const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`, -(i + 1) * minute));
  const limited = dueNow(plan(many), { now: NOW });
  check(limited.length === MAX_PER_RUN, `за запуск не больше ${MAX_PER_RUN} уведомлений`, String(limited.length));
  check(dueNow(plan(many), { now: NOW, limit: 2 }).length === 2, 'лимит можно уменьшить');

  const junk = dueNow(plan([{ key: 'x', at: 'битая дата' }]), { now: NOW });
  check(junk.length === 0, 'элемент с битой датой не роняет рассылку');
  check(dueNow(null, { now: NOW }).length === 0, 'план без документа — ничего не отправляем');
}

// --- 5. отметки об отправке ---
console.log('\npruneSent');
{
  const pruned = pruneSent({ fresh: iso(-hour), stale: iso(-SENT_TTL_MS - hour) }, NOW);
  check(Object.keys(pruned).join(',') === 'fresh', 'старые отметки удаляются', JSON.stringify(pruned));
  check(pruned.fresh === iso(-hour), 'отметка приводится к ISO', pruned.fresh);
  check(Object.keys(pruneSent({ broken: 'вчера' }, NOW)).length === 0, 'битая отметка удаляется');
  check(Object.keys(pruneSent(null, NOW)).length === 0, 'нет отметок — пустая карта');
}

// --- 6. запрос проверки доставки ---
console.log('\npendingTestAt');
{
  const requested = iso(-2 * minute);
  check(pendingTestAt({ testAt: requested }, {}, NOW) === Date.parse(requested), 'свежий запрос выполняется');
  check(pendingTestAt({ testAt: requested }, { lastTestAt: requested }, NOW) === 0, 'тот же запрос дважды не выполняется');
  check(
    pendingTestAt({ testAt: requested }, { lastTestAt: iso(-3 * minute) }, NOW) === Date.parse(requested),
    'новый запрос после предыдущего выполняется'
  );
  check(pendingTestAt({ testAt: iso(-TEST_TTL_MS - minute) }, {}, NOW) === 0, 'просроченный запрос не выполняется');
  check(pendingTestAt({ testAt: iso(5 * minute) }, {}, NOW) === 0, 'будущий запрос ждёт своего времени');
  check(pendingTestAt({}, {}, NOW) === 0, 'без запроса — ничего не отправляем');
}

// --- 7. данные уведомления ---
console.log('\npushPayload');
{
  const payload = pushPayload(item('event:e1', 0, { title: '  Созвон  ', url: '#/calendar' }));
  check(payload.title === 'Созвон', 'заголовок без пробелов', payload.title);
  check(payload.body === 'Тело event:e1', 'тело переносится', payload.body);
  check(payload.tag === 'event:e1', 'tag переносится', payload.tag);
  check(payload.url === '#/calendar', 'маршрут переносится', payload.url);

  const long = pushPayload({ key: 'k', title: 'т'.repeat(400), body: 'б'.repeat(600), url: 'u'.repeat(400) });
  check(long.title.length === 120, 'заголовок обрезается до 120', String(long.title.length));
  check(long.body.length === 240, 'тело обрезается до 240', String(long.body.length));
  check(long.url.length === 200, 'адрес обрезается до 200', String(long.url.length));

  const empty = pushPayload({});
  check(empty.title === 'Наставник', 'без заголовка — «Наставник»', empty.title);
  check(empty.body.length > 0, 'без тела — осмысленный текст', empty.body);
  check(!('tag' in empty), 'пустой tag не попадает в payload');
  check(!('url' in empty), 'пустой url не попадает в payload');

  const test = testPayload();
  check(test.tag === 'test:server', 'у теста свой tag — не перебивает напоминания', test.tag);
  check(test.title.includes('проверка'), 'заголовок теста понятен', test.title);
  check(test.url === '#/settings', 'клик по тесту ведёт в настройки', test.url);
}

// --- 8. реакция на ошибки доставки ---
console.log('\nshouldDropSubscription / shouldStopRetry');
{
  check(shouldDropSubscription(404), '404 — подписка удаляется');
  check(shouldDropSubscription(410), '410 — подписка удаляется');
  check(!shouldDropSubscription(429), '429 — подписка остаётся');
  check(shouldStopRetry(400), '400 — повторять не нужно');
  check(shouldStopRetry(413), '413 (слишком большой payload) — повторять не нужно');
  check(!shouldStopRetry(500), '500 — повторим на следующем запуске');
}

// --- 9. текст не уходит за лимиты ---
console.log('\nclip');
{
  check(clip('  привет  ', 20) === 'привет', 'пробелы обрезаются');
  check(clip('абв', 2) === 'аб', 'длина ограничивается');
  check(clip(undefined, 10) === '', 'undefined — пустая строка');
}

// --- 10. статические проверки файлов ---
console.log('\nфайлы отправителя');
{
  const lib = fs.readFileSync(path.resolve('_push/lib.mjs'), 'utf8');
  const send = fs.readFileSync(path.resolve('_push/send.mjs'), 'utf8');
  const workflow = fs.readFileSync(path.resolve('.github/workflows/notify.yml'), 'utf8');

  check(!lib.includes('firebase-admin'), 'чистая логика не тянет Firebase Admin');
  check(send.includes('web-push'), 'отправитель использует web-push');
  check(send.includes('FIREBASE_SERVICE_ACCOUNT'), 'отправитель читает сервисный аккаунт из секретов');
  check(send.includes('pushState'), 'отправитель пишет отметки в pushState');
  check(workflow.includes("cron: '*/5 * * * *'"), 'workflow запускается каждые 5 минут');
  check(workflow.includes('workflow_dispatch'), 'workflow можно запустить вручную');
  check(workflow.includes('VAPID_PRIVATE_KEY'), 'приватный ключ берётся из секретов');

  const pkg = JSON.parse(fs.readFileSync(path.resolve('_push/package.json'), 'utf8'));
  check(Boolean(pkg.dependencies['web-push']), 'зависимость web-push объявлена');
  check(Boolean(pkg.dependencies['firebase-admin']), 'зависимость firebase-admin объявлена');
}

console.log(`\n${total - failures.length}/${total} проверок пройдено`);
if (failures.length) {
  console.log('\nОшибки:');
  for (const failure of failures) console.log(`  ✖ ${failure}`);
  process.exit(1);
}
