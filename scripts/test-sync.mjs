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
const plainValue = await import(pathToFileURL(path.resolve('src/lib/utils/plain.ts')).href);

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

/* --- тексты ошибок для интерфейса --- */

const errors = await import(pathToFileURL(path.resolve('src/lib/sync/errors.ts')).href);

const denied = errors.describeSyncError(
  { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
  'pull'
);
check(denied.code === 'permission-denied', 'код permission-denied распознан');
check(denied.message.startsWith('Чтение из облака'), 'сообщение об ошибке указывает этап чтения');
check(!/missing or insufficient/i.test(denied.message), 'английский текст Firestore не показывается пользователю');
check(denied.hint.includes('firestore.rules'), 'подсказка отправляет к правилам Firestore');
check(denied.fatal === true, 'permission-denied не повторяется автоматически');
check(denied.raw.includes('Missing or insufficient permissions'), 'исходный текст сохранён для логов');

const deniedByText = errors.describeSyncError(new Error('Missing or insufficient permissions.'));
check(deniedByText.code === 'permission-denied', 'ошибка доступа распознаётся и по тексту без кода');

const offlineError = errors.describeSyncError({ code: 'unavailable' }, 'push');
check(offlineError.fatal === false, 'сетевую ошибку повторяем автоматически');
check(offlineError.message.startsWith('Отправка в облако'), 'этап отправки попадает в сообщение');

const noDatabase = errors.describeSyncError({ code: 'not-found' }, 'pull');
check(noDatabase.hint.includes('Create database'), 'для not-found подсказка про создание базы');

const quota = errors.describeSyncError({ code: 'resource-exhausted' }, 'push');
check(quota.hint.includes('Spark'), 'для исчерпанной квоты упомянут тариф Spark');

const authDomain = errors.describeSyncError({ code: 'auth/unauthorized-domain' }, 'auth');
check(authDomain.message.startsWith('Вход'), 'ошибки входа помечены этапом «Вход»');
check(authDomain.hint.includes('Authorized domains'), 'подсказка про Authorized domains сохранена');

const unknownError = errors.describeSyncError(new Error('boom'), 'push');
check(
  unknownError.message.includes('boom') && unknownError.fatal === false,
  'неизвестная ошибка показывает исходный текст и повторяется'
);

check(errors.describeSyncError(null).message.length > 0, 'пустое значение ошибки не ломает описание');
check(
  errors.rulesConsoleUrl('mentor-1c954') ===
    'https://console.firebase.google.com/project/mentor-1c954/firestore/rules',
  'ссылка на правила ведёт в проект Firebase'
);
check(
  errors.rulesConsoleUrl(' ').startsWith('https://console.firebase.google.com/'),
  'без projectId ссылка ведёт на общую консоль'
);

/* --- настройки: снятие прокси Svelte перед записью в IndexedDB --- */

/** Имитация глубокого прокси `$state` из Svelte 5. */
function deepProxy(value) {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, key) {
      return deepProxy(Reflect.get(target, key));
    }
  });
}

const reactiveSettings = deepProxy({
  proxyUrl: 'https://proxy.example.workers.dev',
  appToken: 'secret-token',
  model: 'deepseek-flash',
  effort: 'high',
  webSearch: true,
  theme: 'auto',
  tags: ['a', 'b']
});

let proxyCloneFailed = false;
try {
  structuredClone(reactiveSettings);
} catch {
  proxyCloneFailed = true;
}
check(proxyCloneFailed, 'клон прокси из $state падает — это и была причина потери настроек');

let storedSettings = null;
try {
  storedSettings = structuredClone(plainValue.toPlainValue(reactiveSettings));
} catch {
  storedSettings = null;
}
check(storedSettings !== null, 'toPlainValue делает настройки пригодными для IndexedDB');
check(
  storedSettings?.proxyUrl === 'https://proxy.example.workers.dev',
  'адрес прокси не теряется при снятии прокси'
);
check(storedSettings?.appToken === 'secret-token', 'токен приложения не теряется при снятии прокси');
check(
  Array.isArray(storedSettings?.tags) && storedSettings.tags.length === 2,
  'массив внутри настроек остаётся массивом'
);

const withUndefined = plainValue.toPlainValue(deepProxy({ name: 'Аня', occupation: undefined }));
check(
  'occupation' in withUndefined && withUndefined.occupation === undefined,
  'undefined-поле профиля не исчезает при снятии прокси'
);

const scalars = plainValue.toPlainValue(deepProxy({ n: 0, b: false, s: '', z: null }));
check(
  scalars.n === 0 && scalars.b === false && scalars.s === '' && scalars.z === null,
  'примитивы, пустая строка и null не меняются'
);

check(plainValue.toPlainValue({ at: new Date(1700000000000) }).at instanceof Date, 'Date остаётся датой');
check(
  Array.isArray(plainValue.toPlainValue(deepProxy(['x', 'y']))),
  'массив на верхнем уровне не превращается в объект'
);

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length}`);
  process.exit(1);
}
console.log('\nВсе проверки синхронизации пройдены.');
