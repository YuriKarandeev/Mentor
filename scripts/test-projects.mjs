/**
 * Проверки проектов и канбана: колонки, порядок карточек, перемещение,
 * прогресс, подписи и обмен с облаком
 * (src/lib/utils/projects.ts, src/lib/sync/model.ts).
 *
 * Чистые функции: без браузера, Dexie, сети и ключа API.
 * Запуск: npm run test:projects
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

const load = (file) => import(pathToFileURL(path.resolve(file)).href);

const util = await load('src/lib/utils/projects.ts');
const model = await load('src/lib/sync/model.ts');

const {
  CARD_COLUMNS,
  COLUMN_LABELS,
  boardOf,
  boardProgress,
  cardsIn,
  compareCards,
  compareProjects,
  dueLabel,
  nextOrder,
  normalizeColumn,
  normalizeOrder,
  planMove,
  planShift
} = util;

/* ---------- колонки и порядок ---------- */

check(CARD_COLUMNS.join() === 'todo,doing,done', 'колонки идут слева направо: todo, doing, done');
check(COLUMN_LABELS.doing === 'В работе', 'подпись средней колонки');
check(normalizeColumn('doing') === 'doing' && normalizeColumn('done') === 'done', 'известные колонки сохраняются');
check(normalizeColumn('later') === 'todo' && normalizeColumn(undefined) === 'todo', 'неизвестная колонка становится «Надо»');
check(normalizeOrder(3.4) === 3 && normalizeOrder(-2) === 0, 'порядок — целое неотрицательное число');
check(normalizeOrder('мусор') === 0, 'мусор вместо порядка становится 0');

const cards = [
  { id: 'c', projectId: 'p1', column: 'todo', order: 2 },
  { id: 'a', projectId: 'p1', column: 'todo', order: 0 },
  { id: 'b', projectId: 'p1', column: 'todo', order: 1 },
  { id: 'd', projectId: 'p1', column: 'doing', order: 0 },
  { id: 'e', projectId: 'p2', column: 'done', order: 0 }
];

check(compareCards(cards[0], cards[1]) > 0, 'compareCards: меньший order идёт первым');
check(cardsIn(cards, 'todo').map((card) => card.id).join() === 'a,b,c', 'cardsIn сортирует колонку');
check(cardsIn(cards, 'done').length === 1, 'cardsIn не смешивает колонки');

const board = boardOf(cards, 'p1');
check(board.todo.length === 3 && board.doing.length === 1 && board.done.length === 0, 'boardOf группирует карточки проекта');
check(boardOf(cards, 'p2').todo.length === 0, 'boardOf не берёт карточки чужого проекта');

check(nextOrder(cards, 'todo') === 3, 'nextOrder продолжает нумерацию колонки');
check(nextOrder(boardOf(cards, 'p2').todo, 'todo') === 0, 'пустая колонка начинается с 0');

const stats = boardProgress(cards.filter((card) => card.projectId === 'p1'));
check(stats.done === 0 && stats.total === 4 && stats.pct === 0, 'прогресс пустой доски');
check(boardProgress([{ id: 'x', column: 'done', order: 0 }, { id: 'y', column: 'todo', order: 0 }]).pct === 50, 'прогресс считает «Готово»');
check(boardProgress([]).pct === 0, 'пустая доска не делит на ноль');

/* ---------- перемещение карточек ---------- */

const intoDoing = planMove(cards, 'b', 'doing');
check(intoDoing.length === 1 && intoDoing[0].id === 'b' && intoDoing[0].column === 'doing' && intoDoing[0].order === 1, 'перенос в другую колонку ставит карточку в конец');
check(!intoDoing.some((patch) => patch.id === 'd'), 'порядок карточки, которая уже на месте, не переписывается');

const toEnd = planMove(cards, 'b', 'todo');
check(toEnd.length === 2 && toEnd.some((patch) => patch.id === 'b' && patch.order === 2), 'перенос внутри колонки отправляет карточку в конец');
check(!toEnd.some((patch) => patch.id === 'a' && patch.order === 0), 'первая карточка колонки не переписывается зря');

check(planMove(cards, 'нет-такой', 'doing').length === 0, 'перенос неизвестной карточки ничего не делает');

const up = planShift(cards, 'b', -1);
check(up.length === 2 && up.some((p) => p.id === 'b' && p.order === 0) && up.some((p) => p.id === 'a' && p.order === 1), 'сдвиг вверх меняет местами с соседом');
check(planShift(cards, 'a', -1).length === 0, 'выше первой карточки не подняться');
check(planShift(cards, 'c', 1).length === 0, 'ниже последней карточки не опуститься');

const down = planShift(cards, 'a', 1);
check(down.some((p) => p.id === 'a' && p.order === 1) && down.some((p) => p.id === 'b' && p.order === 0), 'сдвиг вниз меняет местами с соседом');

/* ---------- проекты ---------- */

const project = (title, status, dueDate, createdAt = 1) => ({ title, status, dueDate, createdAt });

check(compareProjects(project('A', 'active', ''), project('B', 'paused', '')) < 0, 'активный проект выше проекта на паузе');
check(compareProjects(project('A', 'paused', ''), project('B', 'done', '')) < 0, 'пауза выше завершённого');
check(compareProjects(project('A', 'active', '2026-12-01'), project('B', 'active', '')) < 0, 'ближайший срок идёт первым');
check(compareProjects(project('A', 'active', ''), project('B', 'active', '')) < 0, 'при равных условиях решает дата создания');

check(dueLabel('2026-12-01') === 'до 01.12.2026', 'подпись срока читается по-русски');
check(dueLabel('') === '', 'без срока подписи нет');

/* ---------- обмен с облаком ---------- */

const projectRow = {
  id: 'p1',
  title: 'Ремонт',
  goal: 'Новая кухня',
  notes: '',
  status: 'active',
  dueDate: '2026-12-01',
  createdAt: 1,
  updatedAt: 2,
  dirty: 1
};
const remoteProject = model.toRemoteProject(projectRow);
check(!('dirty' in remoteProject) && remoteProject.title === 'Ремонт', 'проект в облако без служебного dirty');
check(remoteProject.dueDate === '2026-12-01', 'срок проекта уходит в облако');

const brokenProject = model.fromRemoteProject('p1', {
  title: 'Ремонт',
  status: 'в работе',
  dueDate: '2026-02-30',
  updatedAt: 5
});
check(brokenProject.status === 'active', 'неизвестный статус из облака становится активным');
check(brokenProject.dueDate === '', 'несуществующая дата из облака отбрасывается');

const cardRow = {
  id: 'c1',
  projectId: 'p1',
  title: 'Купить краску',
  notes: '',
  column: 'doing',
  order: 2,
  dueDate: '',
  createdAt: 1,
  updatedAt: 2,
  dirty: 1
};
const remoteCard = model.toRemoteProjectCard(cardRow);
check(remoteCard.column === 'doing' && remoteCard.order === 2, 'колонка и порядок уходят в облако');
check(!('dirty' in remoteCard), 'карточка в облако без служебного dirty');

const brokenCard = model.fromRemoteProjectCard('c2', {
  projectId: 'p1',
  title: 'Карточка',
  column: 'later',
  order: 'мусор',
  updatedAt: 3
});
check(brokenCard.column === 'todo' && brokenCard.order === 0, 'битые колонка и порядок из облака нормализуются');

const orphan = model.fromRemoteProjectCard('c3', { title: 'Без проекта', updatedAt: 3 });
check(orphan.projectId === '', 'карточка без проекта не получает выдуманную ссылку');

check(model.collectionForTombstone('project') === 'projects', 'надгробие проекта указывает на коллекцию projects');
check(model.collectionForTombstone('projectCard') === 'projectCards', 'надгробие карточки указывает на projectCards');

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки проектов пройдены (${total}).`);
