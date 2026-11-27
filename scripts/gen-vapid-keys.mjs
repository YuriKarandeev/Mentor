#!/usr/bin/env node
/**
 * Генерирует пару VAPID-ключей для Web Push.
 *
 * Запуск: npm run vapid:keys
 *
 * Публичный ключ (65 байт, несжатая точка P-256) нужен браузеру для подписки:
 * его кладут в переменную сборки `VITE_VAPID_PUBLIC_KEY` или в `src/lib/push/config.ts`.
 * Приватный (32 байта) — только секрет репозитория `VAPID_PRIVATE_KEY`, он живёт
 * в GitHub Actions и в код не попадает. `VAPID_SUBJECT` — почта владельца сайта.
 *
 * Оба значения — base64url, как требует RFC 8292.
 *
 * Ключи одноразовые: при их смене все подписки станут недействительными,
 * и напоминания нужно будет включить заново на каждом устройстве.
 */
const encoder = new TextEncoder();

function b64u(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

if (publicKey.length !== 65 || !jwk.d) {
  console.error('Не удалось сгенерировать ключи: неожиданный формат P-256.');
  process.exit(1);
}

const publicB64 = b64u(publicKey);
const privateB64 = String(jwk.d);

// Проверяем пару сразу: подпись должна сходиться с публичным ключом.
const probe = encoder.encode('nastavnik-vapid-check');
const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, probe);
const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, probe);

console.log('VAPID-ключи для «Наставника» (base64url, P-256)\n');
console.log(`VAPID_PUBLIC_KEY=${publicB64}`);
console.log(`VAPID_PRIVATE_KEY=${privateB64}`);
console.log(`\nПроверка пары: ${ok ? 'ОК' : 'ОШИБКА'}\n`);
console.log('Дальше — в GitHub: Settings → Secrets and variables → Actions');
console.log('  Variables → VITE_VAPID_PUBLIC_KEY  # публичный ключ попадёт в сборку');
console.log('  Secrets   → VAPID_PUBLIC_KEY');
console.log('  Secrets   → VAPID_PRIVATE_KEY');
console.log('  Secrets   → VAPID_SUBJECT          # mailto:you@example.com');
console.log('\nПриватный ключ не публикуйте: он даёт право отправлять уведомления от вашего приложения.');
console.log('Ключ можно вписать и прямо в src/lib/push/config.ts — тогда переменная сборки не нужна.');
