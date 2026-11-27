#!/usr/bin/env node
/**
 * Отправитель push-напоминаний: GitHub Actions → Firestore → браузер.
 *
 * Своего сервера у приложения нет. Приложение пишет подписку и готовый план
 * в Firestore, а этот скрипт по cron раз в 5 минут:
 *  1. обходит `users/{uid}/push/*` — подписки устройств;
 *  2. для каждой подписки читает `pushPlan/{deviceId}` и `pushState/{deviceId}`;
 *  3. выбирает созревшие элементы (`dueNow`), отправляет их через `web-push`
 *     и отмечает отправленное в `pushState.sent` (дедупликация);
 *  4. удаляет подписки, которые браузер отозвал (404/410);
 *  5. пишет `lastRunAt`/`lastError` — по ним карточка настроек показывает,
 *     что рассылка жива.
 *
 * Режимы (`PUSH_MODE`):
 *  - `send`    — обычная рассылка (cron и ручной запуск по умолчанию);
 *  - `dry-run` — только показать, что было бы отправлено, ничего не записывая;
 *  - `test`    — отправить тестовое уведомление на все подписки.
 *
 * Секреты (GitHub → Settings → Secrets and variables → Actions):
 *  FIREBASE_SERVICE_ACCOUNT — JSON сервисного аккаунта Firebase
 *  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT — пара `npm run vapid:keys`
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import webpush from 'web-push';
import {
  MAX_PER_RUN,
  clip,
  dueNow,
  missingSecrets,
  pendingTestAt,
  planItems,
  pruneSent,
  pushPayload,
  shouldDropSubscription,
  shouldStopRetry,
  testPayload
} from './lib.mjs';

const MODES = new Set(['send', 'dry-run', 'test']);

function readMode() {
  const raw = String(process.env.PUSH_MODE ?? '').trim();
  return MODES.has(raw) ? raw : 'send';
}

/** Секрет приходит одной строкой JSON; переносы в private_key — как `\n`. */
function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT — это не JSON: ${error.message}`);
  }
  if (typeof parsed?.private_key === 'string' && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  if (!parsed?.project_id || !parsed?.private_key || !parsed?.client_email) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT: нет project_id, client_email или private_key');
  }
  return parsed;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Подписка из Firestore в вид, который понимает web-push. */
function readSubscription(data) {
  const endpoint = String(data?.endpoint ?? '').trim();
  const p256dh = String(data?.keys?.p256dh ?? '').trim();
  const auth = String(data?.keys?.auth ?? '').trim();
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

async function removeDevice(userRef, deviceId) {
  await Promise.all([
    userRef.collection('push').doc(deviceId).delete(),
    userRef.collection('pushPlan').doc(deviceId).delete(),
    userRef.collection('pushState').doc(deviceId).delete()
  ]);
  console.log(`[push] ${userRef.id}/${deviceId}: подписка удалена`);
}

/**
 * Отправка пачки уведомлений одному устройству.
 * Возвращает счётчики и карту отправленных ключей для `pushState.sent`.
 */
async function deliver(subscription, entries, mode, now) {
  const marked = {};
  let sent = 0;
  let failed = 0;
  let testSent = false;
  let testFailed = false;
  let lastError = '';
  let drop = false;

  for (const entry of entries) {
    const payload = entry.payload;
    if (mode === 'dry-run') {
      console.log(`[push] dry-run: «${payload.title}» — ${payload.body}`);
      continue;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 3600,
        urgency: 'high'
      });
      sent += 1;
      if (entry.isTest) testSent = true;
      marked[entry.key] = iso(now);
      console.log(`[push] → «${payload.title}» (${entry.key})`);
    } catch (error) {
      failed += 1;
      if (entry.isTest) testFailed = true;
      const status = Number(error?.statusCode ?? 0);
      lastError = `${status || 'ошибка'}: ${clip(error?.body ?? error?.message ?? error, 300)}`;
      console.log(`[push] ✖ ${entry.key}: ${lastError}`);
      if (shouldDropSubscription(status)) {
        drop = true;
        break;
      }
      // Payload не принят — повторять бессмысленно, но подписка жива.
      if (shouldStopRetry(status)) marked[entry.key] = iso(now);
    }
  }

  return { marked, sent, failed, testSent, testFailed, lastError, drop };
}

/** Чтение плана и состояния устройства, выбор созревшего и запись результата. */
async function handleDevice({ userRef, deviceId, subscription, mode, now }) {
  const planRef = userRef.collection('pushPlan').doc(deviceId);
  const stateRef = userRef.collection('pushState').doc(deviceId);
  const [planSnap, stateSnap] = await Promise.all([planRef.get(), stateRef.get()]);
  const plan = planSnap.exists ? planSnap.data() ?? {} : {};
  const state = stateSnap.exists ? stateSnap.data() ?? {} : {};
  const sentMap = pruneSent(state.sent, now);
  const planned = planItems(plan).length;

  const testAt = pendingTestAt(plan, state, now);
  const entries = [];
  if (mode === 'test') {
    entries.push({ key: 'test:manual', isTest: true, payload: testPayload() });
  } else {
    for (const item of dueNow(plan, { now, sent: sentMap, limit: MAX_PER_RUN })) {
      entries.push({ key: item.key, payload: pushPayload(item) });
    }
    if (testAt > 0) entries.push({ key: 'test:server', isTest: true, payload: testPayload() });
  }

  if (!entries.length) {
    if (mode !== 'dry-run') {
      await stateRef.set({ lastRunAt: iso(now), lastError: '', updatedAt: iso(now) }, { merge: true });
    }
    return { sent: 0, failed: 0, planned, drop: false };
  }

  const result = await deliver(subscription, entries, mode, now);
  if (mode === 'dry-run') return { ...result, planned };

  if (result.drop) {
    await removeDevice(userRef, deviceId);
    return { ...result, planned };
  }

  const patch = {
    sent: pruneSent({ ...sentMap, ...result.marked }, now),
    lastRunAt: iso(now),
    lastError: clip(result.lastError, 300),
    updatedAt: iso(now)
  };
  if (result.testSent && testAt > 0) patch.lastTestAt = iso(testAt);
  await stateRef.set(patch, { merge: true });

  if (result.testSent && testAt > 0) {
    // Запрос выполнен: убираем его из плана, чтобы не повторялся.
    await planRef
      .set({ testAt: FieldValue.delete(), updatedAt: iso(now) }, { merge: true })
      .catch(() => undefined);
  }

  return { ...result, planned };
}

/** `VAPID_SUBJECT` может быть как `mailto:…`, так и просто адресом. */
function normalizeSubject(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^mailto:/i.test(value) || /^https?:\/\//i.test(value)) return value;
  return `mailto:${value}`;
}

async function main() {
  const mode = readMode();
  const missing = missingSecrets(process.env);
  if (missing.length) {
    console.log(`[push] пропуск (${mode}): не заданы секреты ${missing.join(', ')}`);
    return;
  }

  const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);
  webpush.setVapidDetails(
    normalizeSubject(process.env.VAPID_SUBJECT),
    String(process.env.VAPID_PUBLIC_KEY).trim(),
    String(process.env.VAPID_PRIVATE_KEY).trim()
  );

  const now = Date.now();
  const users = await db.collection('users').listDocuments();
  console.log(`[push] режим ${mode}, проект ${serviceAccount.project_id}, пользователей ${users.length}`);

  let devices = 0;
  let sent = 0;
  let failed = 0;
  let planned = 0;
  let dropped = 0;

  for (const userRef of users) {
    const subsSnap = await userRef.collection('push').get();
    if (subsSnap.empty) continue;
    for (const subDoc of subsSnap.docs) {
      devices += 1;
      const subscription = readSubscription(subDoc.data());
      if (!subscription) {
        if (mode === 'dry-run') {
          console.log(`[push] dry-run: ${userRef.id}/${subDoc.id} — подписка без endpoint/keys`);
          continue;
        }
        await removeDevice(userRef, subDoc.id);
        dropped += 1;
        continue;
      }
      try {
        const result = await handleDevice({ userRef, deviceId: subDoc.id, subscription, mode, now });
        sent += result.sent;
        failed += result.failed;
        planned += result.planned ?? 0;
        if (result.drop) dropped += 1;
      } catch (error) {
        failed += 1;
        console.log(`[push] ✖ ${userRef.id}/${subDoc.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log(
    `[push] итог: устройств ${devices}, отправлено ${sent}, ошибок ${failed}, ` +
      `в планах ${planned}, удалено подписок ${dropped}`
  );
  // Полный провал должен быть виден в Actions красным запуском.
  if (failed > 0 && sent === 0 && mode !== 'dry-run') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[push] ✖ ${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
