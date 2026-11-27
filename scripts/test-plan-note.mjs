/**
 * Проверки связки «пункт плана ↔ конспект» (src/lib/utils/plan-note.ts)
 * и промпта конспекта (src/lib/api/prompts.ts).
 *
 * Чистые функции и строки: без браузера, Dexie, сети и ключа API.
 * Запуск: npm run test:plan
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let total = 0;
const failures = [];
const check = (ok, message) => {
  total += 1;
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

const planNote = await import(pathToFileURL(path.resolve('src/lib/utils/plan-note.ts')).href);
const prompts = await import(pathToFileURL(path.resolve('src/lib/api/prompts.ts')).href);

const { PLAN_ITEM_TAG_PREFIX, findItemNote, findPlanItem, itemTag, summarisedItemIds } = planNote;

const note = (id, tags, createdAt, md = '') => ({
  id,
  topicId: 't_1',
  title: `Заметка ${id}`,
  md,
  source: 'chat',
  tags,
  createdAt,
  updatedAt: createdAt,
  dirty: 1
});

const notes = [
  note('n_new', [itemTag('i_1')], 2000, 'свежий конспект'),
  note('n_old', [itemTag('i_1')], 1000, 'старый конспект'),
  note('n_other', ['book'], 1500),
  note('n_plain', undefined, 1400),
  note('n_multi', ['book', itemTag('i_2')], 900)
];

check(itemTag('i_1') === `${PLAN_ITEM_TAG_PREFIX}i_1`, 'itemTag добавляет префикс к id пункта');
check(PLAN_ITEM_TAG_PREFIX === 'plan-item:', 'префикс тега стабилен (его понимает синхронизация)');

check(findItemNote(notes, 'i_1')?.id === 'n_new', 'конспект пункта находится по тегу');
check(
  findItemNote(notes, 'i_1')?.md === 'свежий конспект',
  'из двух версий берётся самая свежая (список отсортирован по createdAt)'
);
check(findItemNote(notes, 'i_2')?.id === 'n_multi', 'тег пункта работает рядом с другими тегами');
check(findItemNote(notes, 'i_404') === undefined, 'для пункта без конспекта возвращается undefined');
check(
  findItemNote(notes, 'n_other') === undefined,
  'id заметки не путается с id пункта'
);
check(
  findItemNote([note('n_t', undefined, 1)], 'i_1') === undefined,
  'заметка без tags не ломает поиск'
);

const ids = summarisedItemIds(notes);
check(ids instanceof Set && ids.size === 2, 'summarisedItemIds собирает уникальные id пунктов');
check(ids.has('i_1') && ids.has('i_2'), 'в наборе есть оба пункта с конспектами');
check(!ids.has('book'), 'посторонние теги в набор не попадают');

const plan = {
  id: 'p_1',
  topicId: 't_1',
  title: 'SQL с нуля',
  summary: '',
  modules: [
    {
      id: 'm_1',
      title: 'Основы выборки',
      goal: 'Читать данные из одной таблицы',
      items: [
        { id: 'i_1', title: 'SELECT и WHERE', kind: 'theory', estMin: 25, done: false },
        { id: 'i_2', title: 'Сортировка и лимит', kind: 'practice', estMin: 20, done: true }
      ]
    },
    {
      id: 'm_2',
      title: 'Связи',
      goal: '',
      items: [{ id: 'i_3', title: 'JOIN', kind: 'check', estMin: 30, done: false }]
    }
  ],
  createdAt: 1,
  updatedAt: 2,
  dirty: 1
};

const ref = findPlanItem(plan, 'i_2');
check(ref?.module.id === 'm_1' && ref?.item.title === 'Сортировка и лимит', 'findPlanItem находит модуль и пункт');
check(findPlanItem(plan, 'i_3')?.module.id === 'm_2', 'пункт из второго модуля тоже находится');
check(findPlanItem(plan, 'i_404') === undefined, 'неизвестный пункт не найден');
check(findPlanItem(undefined, 'i_1') === undefined, 'без плана поиск не падает');

const topic = {
  id: 't_1',
  title: 'SQL',
  goal: 'Писать выборки для отчётов',
  level: 'новичок',
  hoursPerWeek: 5,
  status: 'active',
  createdAt: 1,
  updatedAt: 2,
  dirty: 1
};

const system = prompts.itemSummarySystem(topic, plan, plan.modules[0], plan.modules[0].items[0], {
  name: 'Аня',
  occupation: '',
  level: 'новичок',
  preferredStyle: 'короткие примеры',
  goals: [],
  interests: [],
  updatedAt: 3
});

check(system.includes('«SELECT и WHERE»'), 'промпт содержит название пункта');
check(system.includes('Основы выборки'), 'промпт содержит модуль (контекст уровня)');
check(system.includes('Писать выборки для отчётов'), 'промпт содержит цель ученика');
check(system.includes('Сортировка и лимит'), 'соседние пункты попадают в контекст');
check(system.includes('Аня'), 'профиль подмешивается в промпт');
check(
  ['## Коротко', '## Ключевые понятия', '## Как это устроено', '## Пример', '## Типичные ошибки', '## Что сделать сейчас', '## Проверь себя'].every(
    (heading) => system.includes(heading)
  ),
  'в промпте задана вся структура конспекта'
);
check(system.includes('Не выдумывай факты'), 'правила COMMON_RULES на месте');
check(
  prompts.itemSummarySystem(topic, plan, plan.modules[1], plan.modules[1].items[0]).includes('Модуль 2 из 2'),
  'нумерация модуля считается от плана'
);

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки конспектов пунктов пройдены (${total}).`);
