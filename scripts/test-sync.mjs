/**
 * Проверки чистых функций синхронизации: без Firebase, браузера и Dexie.
 * Запуск: npm run test:sync
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

const model = await import(pathToFileURL(path.resolve('src/lib/sync/model.ts')).href);

const topic = {
  id: 't_1',
  title: 'SQL',
  goal: 'JOIN и агрегаты',
  level: 'новичок',
  hoursPerWeek: 5,
  status: 'active',
  createdAt: 1000,
  updatedAt: 2000,
  dirty: 1
};

const plan = {
  id: 'p_1',
  topicId: 't_1',
  title: 'План',
  summary: 'кратко',
  modules: [{ id: 'm_1', title: 'Модуль', items: [{ id: 'i_1', title: 'Пункт', kind: 'theory', estMin: 25, done: false }] }],
  createdAt: 1000,
  updatedAt: 2500,
  dirty: 1
};

const message = {
  id: 'msg_1',
  topicId: 't_1',
  role: 'assistant',
  content: 'Привет',
  reasoning: 'думал',
  citations: [{ url: 'https://example.com', title: 'Источник' }],
  createdAt: 1100,
  updatedAt: 1200,
  dirty: 1
};

const note = {
  id: 'n_1',
  topicId: 't_1',
  title: 'Заметка',
  md: '# текст',
  source: 'chat',
  tags: ['sql'],
  citations: [],
  createdAt: 1300,
  updatedAt: 1400,
  dirty: 1
};

// Профиль намеренно «загрязнён» служебными настройками устройства.
const profile = {
  name: 'Юрий',
  occupation: 'аналитик',
  goals: ['сменить профессию'],
  interests: ['SQL'],
  updatedAt: 3000,
  appToken: 'super-secret-token',
  proxyUrl: 'https://proxy.example.workers.dev',
  settings: { appToken: 'nested-secret' }
};

const memory = { topicId: 't_1', text: 'краткое резюме', updatedAt: 4000, dirty: 1 };

/* --- белые списки полей и защита от утечки токена --- */

const profileDoc = model.toRemoteProfile(profile);
const serializedProfile = JSON.stringify(profileDoc);
check(!serializedProfile.includes('super-secret-token'), 'профиль в облако не содержит appToken');
check(!serializedProfile.includes('nested-secret'), 'профиль в облако не содержит вложенных настроек');
check(!serializedProfile.includes('proxyUrl'), 'профиль в облако не содержит адрес прокси');
check(profileDoc.name === 'Юрий' && Array.isArray(profileDoc.goals), 'профиль в облако содержит нужные поля');

const payloads = {
  topic: model.toRemoteTopic(topic),
  plan: model.toRemotePlan(plan),
  message: model.toRemoteMessage(message),
  note: model.toRemoteNote(note),
  memory: model.toRemoteMemory(memory)
};

for (const [name, payload] of Object.entries(payloads)) {
  const text = JSON.stringify(payload);
  check(!text.includes('appToken'), `${name}: в документе нет appToken`);
  check(!('dirty' in payload), `${name}: служебный флаг dirty не уходит в облако`);
  check(payload.updatedAt > 0, `${name}: в документе есть updatedAt`);
}

check(payloads.topic.id === undefined, 'идентификатор топика хранится в имени документа, а не в поле');
check(payloads.plan.modules.length === 1, 'план сохраняет модули');
check(payloads.note.md === '# текст' && payloads.note.source === 'chat', 'заметка сохраняет markdown и источник');
check(payloads.memory.text === 'краткое резюме', 'память сохраняет текст');
check(payloads.message.citations.length === 1, 'сообщение сохраняет источники');

const withLegacy = model.toRemoteTopic({ ...topic, appToken: 'legacy-token' });
check(!JSON.stringify(withLegacy).includes('legacy-token'), 'посторонние поля топика отбрасываются');

/* --- разрешение конфликтов --- */

check(model.shouldApply(undefined, { updatedAt: 10 }), 'новая удалённая запись применяется');
check(model.shouldApply({ updatedAt: 5 }, { updatedAt: 10 }), 'более новая удалённая запись применяется');
check(!model.shouldApply({ updatedAt: 10 }, { updatedAt: 10 }), 'при равных метках остаётся локальная версия');
check(!model.shouldApply({ updatedAt: 20 }, { updatedAt: 10 }), 'старая удалённая запись игнорируется');
check(!model.shouldApply({ updatedAt: 10 }, { updatedAt: 0 }), 'документ без updatedAt не затирает локальный');

/* --- служебные поля и утилиты --- */

const remote = { title: 'SQL', updatedAt: 5, srvUpdatedAt: { seconds: 1 } };
const cleaned = model.withoutServerFields(remote);
check(!('srvUpdatedAt' in cleaned) && cleaned.title === 'SQL', 'srvUpdatedAt вырезается перед записью в Dexie');
check(model.pickUpdatedAt({ updatedAt: 42 }) === 42, 'pickUpdatedAt читает метку');
check(model.pickUpdatedAt({}) === 0, 'pickUpdatedAt без метки возвращает 0');

check(model.collectionForTombstone('note') === 'notes', 'надгробие заметки указывает на коллекцию notes');
check(model.collectionForTombstone('profile') === 'profile', 'надгробие профиля указывает на профиль');
check(model.docIdForTombstone({ type: 'profile', refId: 'ignored' }) === 'main', 'у профиля фиксированный id документа');
check(model.docIdForTombstone({ type: 'topic', refId: 't_1' }) === 't_1', 'у топика id документа = refId');

const items = Array.from({ length: 900 }, (_, i) => i);
const chunks = model.chunk(items, model.MAX_BATCH_WRITES);
check(model.MAX_BATCH_WRITES <= 500, 'размер батча не превышает лимит Firestore (500)');
check(chunks.length === 3 && chunks[2].length === 100, 'чанкование режет отправку на пачки');
check(model.chunk([], 10).length === 0, 'пустой список не даёт батчей');

check(
  model.SYNCED_COLLECTIONS.length === 5 && !model.SYNCED_COLLECTIONS.includes('kv'),
  'в облако синхронизируются только данные, но не таблица настроек kv'
);

const messy = {
  id: 'm_1',
  goal: undefined,
  items: [{ title: 'a', note: undefined }, undefined],
  nested: { deep: undefined, keep: 1 }
};
const plain = model.toPlain(messy);
check(!('goal' in plain), 'toPlain убирает undefined из объектов (Firestore такое отклоняет)');
check(plain.items[1] === null, 'toPlain превращает undefined в массивах в null');
check(!('note' in plain.items[0]) && plain.nested.keep === 1, 'toPlain чистит вложенные структуры');

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length}`);
  process.exit(1);
}
console.log('\nВсе проверки синхронизации пройдены.');
