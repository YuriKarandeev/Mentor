/**
 * Проверки бюджета: деньги, месяцы, остатки, поток, конверты, обязательства,
 * капитал и нормализация (src/lib/utils/money.ts, src/lib/utils/budget.ts).
 *
 * Чистые функции: без браузера, Dexie, сети и ключа API.
 * Запуск: npm run test:budget
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

const money = await load('src/lib/utils/money.ts');
const budget = await load('src/lib/utils/budget.ts');

const {
  MONEY_MAX,
  formatMoney,
  formatMoneyShort,
  isMoneyInput,
  moneyInputValue,
  moneyPercent,
  parseMoney,
  rubToKopecks,
  toKopecks
} = money;

const {
  SEED_CATEGORIES,
  accountBalance,
  accountBalances,
  budgetUsage,
  categoryDelta,
  clampDueDay,
  currentMonth,
  debtLoad,
  dueLabel,
  essentialMonthly,
  freeMoney,
  groupShares,
  lastMonths,
  liquidTotal,
  monthDays,
  monthFlow,
  monthLabel,
  monthOf,
  monthRange,
  monthShortLabel,
  monthSpend,
  monthlyEquivalent,
  netWorth,
  nextObligationDate,
  normalizeAccount,
  normalizeAsset,
  normalizeBudget,
  normalizeBudgetLines,
  normalizeCategory,
  normalizeObligation,
  normalizeSnapshot,
  normalizeTransaction,
  obligationDate,
  obligationScheduleLabel,
  obligationsForMonth,
  obligationsMonthlyTotal,
  pluralDays,
  reserveMonths,
  savingsRate,
  savingsTotal,
  shiftMonth,
  sortTransactions,
  spentByCategory,
  topCategories,
  unallocated,
  unpaidBetween
} = budget;

/* ---------- деньги ---------- */

check(toKopecks('1 234,56') === 123456, 'toKopecks: «1 234,56» → 123 456 копеек');
check(toKopecks('1234.5') === 123450, 'toKopecks: точка как разделитель');
check(toKopecks('1 234,567') === 123457, 'toKopecks: лишние знаки округляются');
check(toKopecks('1 234,56 ₽') === 123456, 'toKopecks: символ валюты не мешает');
check(toKopecks(-500) === 0 && toKopecks('abc') === 0, 'toKopecks: отрицательные и мусор → 0');
check(toKopecks(12345) === 12345, 'toKopecks: число — уже копейки');
check(rubToKopecks(123.45) === 12345, 'rubToKopecks: рубли числа → копейки');
check(rubToKopecks('1 500') === 150000, 'rubToKopecks: рубли строкой');
check(toKopecks(1e12) === MONEY_MAX, 'toKopecks: переполнение обрезается до MONEY_MAX');
check(formatMoney(123456) === '1 234,56 ₽', 'formatMoney: копейки показываются');
check(formatMoney(123400) === '1 234 ₽', 'formatMoney: нулевые копейки скрываются');
check(formatMoney(-45000) === '−450 ₽', 'formatMoney: минус');
check(formatMoney(45000, { sign: true }) === '+450 ₽', 'formatMoney: плюс по запросу');
check(formatMoney(123456, { currency: false }) === '1 234,56', 'formatMoney: без символа валюты');
check(formatMoneyShort(1_234_500) === '12,3 тыс ₽', 'formatMoneyShort: тысячи');
check(formatMoneyShort(250_000_000) === '2,5 млн ₽', 'formatMoneyShort: миллионы');
check(moneyInputValue(123456) === '1234,56', 'moneyInputValue: значение для поля ввода');
check(moneyInputValue(100000) === '1000', 'moneyInputValue: без нулевых копеек');
check(parseMoney('') === null && parseMoney('мусор') === null, 'parseMoney: пустое и мусор → null');
check(parseMoney('0') === 0, 'parseMoney: «0» — это ноль, а не пустота');
check(isMoneyInput('1 234,5') && !isMoneyInput('12,345'), 'isMoneyInput: не больше двух знаков после запятой');
check(moneyPercent(3000, 10000) === 30, 'moneyPercent: треть');
check(moneyPercent(5000, 0) === 0, 'moneyPercent: деление на ноль даёт 0');

/* ---------- месяцы ---------- */

const now = new Date(2026, 10, 28, 12, 0);
check(monthOf('2026-11-28') === '2026-11' && monthOf('2026-02-30') === '', 'monthOf: месяц даты');
check(currentMonth(now) === '2026-11', 'currentMonth по локальной дате');
check(shiftMonth('2026-01', -1) === '2025-12', 'shiftMonth: переход через год назад');
check(shiftMonth('2026-12', 1) === '2027-01', 'shiftMonth: переход через год вперёд');
check(monthDays('2028-02') === 29 && monthDays('2026-02') === 28, 'monthDays: високосный февраль');
check(monthRange('2026-02').end === '2026-02-28', 'monthRange: последний день месяца');
check(monthLabel('2026-11') === 'ноябрь 2026', 'monthLabel');
check(monthShortLabel('2026-11') === 'ноя 2026', 'monthShortLabel');
check(JSON.stringify(lastMonths(3, now)) === '["2026-09","2026-10","2026-11"]', 'lastMonths: три месяца подряд');
check(clampDueDay(31, '2026-02') === 28 && clampDueDay(31, '2028-02') === 29, 'clampDueDay: 31-е в феврале');

/* ---------- счета и поток ---------- */

const accounts = [
  { id: 'cash', title: 'Наличные', kind: 'cash', openingBalance: 100000, includeInFree: true },
  { id: 'card', title: 'Карта', kind: 'card', openingBalance: 0, includeInFree: true },
  { id: 'piggy', title: 'Копилка', kind: 'savings', openingBalance: 50000, includeInFree: false }
];

const txs = [
  { id: 't1', date: '2026-11-05', type: 'income', amount: 300000, accountId: 'card' },
  { id: 't2', date: '2026-11-06', type: 'expense', amount: 50000, accountId: 'card', categoryId: 'cat:food' },
  { id: 't3', date: '2026-11-07', type: 'transfer', amount: 20000, accountId: 'card', toAccountId: 'piggy' },
  { id: 't4', date: '2026-10-31', type: 'expense', amount: 31000, accountId: 'cash', categoryId: 'cat:food' }
];

check(accountBalance(accounts[0], txs) === 69000, 'accountBalance: расход прошлого месяца учтён');
check(accountBalance(accounts[1], txs) === 230000, 'accountBalance: карта 300 000 − 50 000 − 20 000');
check(accountBalance(accounts[2], txs) === 70000, 'accountBalance: перевод пришёл на копилку');
check(accountBalances(accounts, txs).piggy === 70000, 'accountBalances: карта остатков');
check(liquidTotal(accounts, txs) === 299000, 'liquidTotal: копилка не входит в свободные деньги');
check(savingsTotal(accounts, txs) === 70000, 'savingsTotal: копилка и инвестиции');

const flow = monthFlow(txs, '2026-11', accounts, []);
check(flow.income === 300000 && flow.expense === 50000, 'monthFlow: доход и расход месяца');
check(flow.net === 250000, 'monthFlow: переводы не меняют поток');
check(flow.saved === 20000, 'monthFlow: перевод на копилку — сбережение');
check(savingsRate(flow) === 6.7, 'savingsRate: 20 000 из 300 000 = 6,7 %');
check(savingsRate({ income: 0, expense: 0, saved: 100, net: 0 }) === 0, 'savingsRate: без дохода не делит на ноль');

/* ---------- конверты ---------- */

const plan = {
  expectedIncome: 300000,
  savingsTarget: 20000,
  lines: [
    { categoryId: 'cat:food', limit: 40000 },
    { categoryId: 'cat:fun', limit: 10000 }
  ]
};

const usage = budgetUsage(plan, txs, '2026-11');
check(usage.lines[0].spent === 50000 && usage.lines[0].over === 10000, 'budgetUsage: перерасход по конверту');
check(usage.lines[0].percent === 125, 'budgetUsage: проценты использования лимита');
check(usage.lines[1].left === 10000, 'budgetUsage: нетронутый конверт');
check(usage.limit === 50000 && usage.spent === 50000, 'budgetUsage: итоги конвертов');
check(usage.left === 0 && usage.over === 0, 'budgetUsage: остаток не уходит в минус');
check(unallocated(plan) === 230000, 'unallocated: доход − лимиты − цель');
check(
  unallocated({ expectedIncome: 100, lines: [{ categoryId: 'a', limit: 80 }], savingsTarget: 30 }) === -10,
  'unallocated: отрицательное значение допустимо'
);
check(budgetUsage(null, txs, '2026-11').lines.length === 0, 'budgetUsage: без плана конвертов нет');
check(spentByCategory(txs, '2026-11')['cat:food'] === 50000, 'spentByCategory: только расходы месяца');

const monthly = { id: 'o1', title: 'Аренда', kind: 'bill', amount: 20000, frequency: 'monthly', dueDay: 31 };

/* ---------- оплата обязательств ---------- */

const dueTxs = [
  { date: '2026-11-15', type: 'expense', amount: 20000, accountId: 'card', categoryId: 'cat:home', obligationId: 'o2' }
];
const dueList = obligationsForMonth(
  [{ id: 'o2', title: 'Интернет', amount: 20000, frequency: 'monthly', dueDay: 15 }, monthly],
  '2026-11',
  dueTxs
);
check(dueList.length === 2 && dueList[0].obligation.id === 'o2', 'obligationsForMonth: сортировка по дате');
check(dueList[0].paid && dueList[0].paidDate === '2026-11-15', 'obligationsForMonth: оплата видна по obligationId');
check(!dueList[1].paid, 'obligationsForMonth: второй платёж не оплачен');
check(
  obligationsForMonth([monthly], '2026-11', [
    { date: '2026-10-30', type: 'expense', amount: 20000, accountId: 'card', obligationId: 'o1' }
  ])[0].paid === false,
  'obligationsForMonth: оплата другого месяца не считается'
);
check(unpaidBetween([monthly], [], '2026-11-28', '2026-11-30').length === 1, 'unpaidBetween: платёж до конца месяца');
check(unpaidBetween([monthly], [], '2026-12-01', '2026-12-31').length === 1, 'unpaidBetween: следующий месяц');
check(
  unpaidBetween([{ ...monthly, id: 'o2' }], dueTxs, '2026-11-01', '2026-11-30').length === 0,
  'unpaidBetween: оплаченное не считается'
);

/* ---------- свободные деньги ---------- */

const free = freeMoney({
  accounts: [
    { id: 'card', kind: 'card', openingBalance: 100000, includeInFree: true },
    { id: 'piggy', kind: 'savings', openingBalance: 50000, includeInFree: false }
  ],
  transactions: [],
  obligations: [{ id: 'o1', amount: 10000, frequency: 'monthly', dueDay: 30 }],
  budget: { expectedIncome: 0, savingsTarget: 20000, lines: [{ categoryId: 'cat:food', limit: 30000 }] },
  now
});
check(free.onHands === 100000, 'freeMoney: на руках только свободные счета');
check(free.reserved === 30000, 'freeMoney: занято конвертами');
check(free.bills === 10000, 'freeMoney: обязательства до конца месяца');
check(free.savings === 20000, 'freeMoney: непокрытая цель по сбережениям');
check(free.free === 40000, 'freeMoney: 100 000 − 30 000 − 10 000 − 20 000');

const negative = freeMoney({
  accounts: [{ id: 'card', kind: 'card', openingBalance: 10000, includeInFree: true }],
  transactions: [],
  obligations: [{ id: 'o1', amount: 30000, frequency: 'monthly', dueDay: 30 }],
  now
});
check(negative.free === -20000, 'freeMoney: отрицательный остаток — честный сигнал');

/* ---------- здоровье финансов ---------- */

check(debtLoad(30000, 300000) === 10, 'debtLoad: 30 000 из 300 000 = 10 %');
check(debtLoad(30000, 0) === 0, 'debtLoad: без дохода не делит на ноль');
check(reserveMonths(300000, 50000) === 6, 'reserveMonths: 300 000 при тратах 50 000 = 6 месяцев');
check(reserveMonths(300000, 0) === 0, 'reserveMonths: без трат — 0');
check(
  essentialMonthly(
    [
      { date: '2026-11-10', type: 'expense', amount: 40000, accountId: 'card', categoryId: 'cat:food' },
      { date: '2026-10-10', type: 'expense', amount: 60000, accountId: 'card', categoryId: 'cat:food' },
      { date: '2026-11-11', type: 'expense', amount: 90000, accountId: 'card', categoryId: 'cat:fun' }
    ],
    [
      { id: 'cat:food', essential: true },
      { id: 'cat:fun', essential: false }
    ],
    ['2026-10', '2026-11']
  ) === 50000,
  'essentialMonthly: средние обязательные расходы, необязательные не в счёт'
);

/* ---------- капитал и прогноз ---------- */

const worth = netWorth(
  [
    { id: 'card', openingBalance: 100000 },
    { id: 'piggy', kind: 'savings', openingBalance: 50000 }
  ],
  [],
  [
    { id: 'car', kind: 'asset', value: 800000 },
    { id: 'credit', kind: 'liability', value: 200000 }
  ]
);
check(worth.cash === 150000 && worth.assets === 800000 && worth.liabilities === 200000, 'netWorth: составляющие');
check(worth.net === 750000, 'netWorth: 150 000 + 800 000 − 200 000');

const spendNow = monthSpend(txs, '2026-11', now);
check(spendNow.days === 28 && spendNow.perDay === 1786, 'monthSpend: средний расход в день');
check(spendNow.forecast === 53580, 'monthSpend: прогноз на 30 дней');
check(monthSpend(txs, '2026-10', now).forecast === 31000, 'monthSpend: прошедший месяц — факт');
check(monthSpend(txs, '2026-12', now).forecast === 0, 'monthSpend: будущий месяц без прогноза');

/* ---------- аналитика ---------- */

const cats = [
  { id: 'cat:food', title: 'Продукты', group: 'needs', icon: '🛒' },
  { id: 'cat:fun', title: 'Кафе', group: 'wants', icon: '☕' },
  { id: 'cat:reserve', title: 'Сбережения', group: 'savings', icon: '🏦' }
];
const shareTxs = [
  { date: '2026-11-03', type: 'expense', amount: 50000, accountId: 'card', categoryId: 'cat:food' },
  { date: '2026-11-04', type: 'expense', amount: 30000, accountId: 'card', categoryId: 'cat:fun' },
  { date: '2026-11-05', type: 'expense', amount: 20000, accountId: 'card', categoryId: 'cat:reserve' },
  { date: '2026-11-06', type: 'expense', amount: 10000, accountId: 'card', categoryId: 'unknown' },
  { date: '2026-11-07', type: 'income', amount: 500000, accountId: 'card' }
];
const shares = groupShares(shareTxs, '2026-11', cats);
check(shares.total === 110000, 'groupShares: доход не попадает в расходы');
check(shares.groups[0].percent === 45.5 && shares.groups[1].percent === 36.4, 'groupShares: неизвестная категория — «желание»');
check(shares.groups[2].percent === 18.2 && shares.groups[2].target === 20, 'groupShares: цель 50/30/20');
check(topCategories(shareTxs, '2026-11', cats, 2)[0].categoryId === 'cat:food', 'topCategories: крупнейшая категория');
check(topCategories(shareTxs, '2026-11', cats, 2).length === 2, 'topCategories: ограничение списка');
check(categoryDelta(50000, 40000) === 25, 'categoryDelta: рост на 25 %');
check(categoryDelta(100, 0) === null, 'categoryDelta: не с чем сравнивать');

/* ---------- подписи сроков ---------- */

check(dueLabel('2026-11-28', now) === 'сегодня', 'dueLabel: сегодня');
check(dueLabel('2026-11-29', now) === 'завтра', 'dueLabel: завтра');
check(dueLabel('2026-11-30', now) === 'послезавтра', 'dueLabel: послезавтра');
check(dueLabel('2026-12-01', now) === 'через 3 дня', 'dueLabel: через три дня');
check(dueLabel('2026-11-25', now) === 'просрочено на 3 дня', 'dueLabel: просрочка');
check(dueLabel('2026-12-20', now) === '20 декабря', 'dueLabel: далёкая дата');
check(dueLabel('', now) === '', 'dueLabel: пустая дата');
check(pluralDays(1) === 'день' && pluralDays(2) === 'дня' && pluralDays(5) === 'дней', 'pluralDays: 1/2/5');
check(pluralDays(11) === 'дней' && pluralDays(21) === 'день' && pluralDays(22) === 'дня', 'pluralDays: 11/21/22');
check(obligationScheduleLabel({ frequency: 'monthly', dueDay: 15 }) === 'каждый месяц, 15-го', 'obligationScheduleLabel: месячный');
check(
  obligationScheduleLabel({ frequency: 'yearly', dueDate: '2026-03-05' }) === 'раз в год, 5 марта',
  'obligationScheduleLabel: годовой'
);
check(
  obligationScheduleLabel({ frequency: 'once', dueDate: '2026-12-05' }) === 'один раз, 05.12.2026',
  'obligationScheduleLabel: разовый'
);

/* ---------- нормализация ---------- */

check(normalizeAccount({}).title === 'Карта', 'normalizeAccount: имя по умолчанию');
check(normalizeAccount({ kind: 'savings' }).includeInFree === false, 'normalizeAccount: копилка не в свободных');
check(normalizeAccount({ kind: 'invest', includeInFree: true }).includeInFree === true, 'normalizeAccount: флаг можно переопределить');
check(normalizeAccount({ openingBalance: '1 500,50' }).openingBalance === 150050, 'normalizeAccount: сумма в копейках');
check(normalizeCategory({ kind: 'income', group: 'wants' }).group === 'needs', 'normalizeCategory: доход не бывает «желанием»');
check(normalizeCategory({ kind: 'expense', group: 'savings', essential: 1 }).essential === true, 'normalizeCategory: essential из числа');

const selfTransfer = normalizeTransaction({ type: 'transfer', accountId: 'a', toAccountId: 'a', categoryId: 'c', amount: 500 });
check(selfTransfer.toAccountId === '' && selfTransfer.categoryId === '', 'normalizeTransaction: перевод сам в себя не перевод');
const realTransfer = normalizeTransaction({ type: 'transfer', accountId: 'a', toAccountId: 'b', categoryId: 'c' });
check(realTransfer.toAccountId === 'b' && realTransfer.categoryId === '', 'normalizeTransaction: у перевода нет категории');
check(normalizeTransaction({ date: '2026-02-30' }).date === '', 'normalizeTransaction: несуществующая дата');
check(normalizeTransaction({ type: 'income', obligationId: 'o1' }).obligationId === 'o1', 'normalizeTransaction: связь с обязательством');

check(normalizeObligation({ dueDay: 99 }).dueDay === 31, 'normalizeObligation: день платежа не больше 31');
check(normalizeObligation({ dueDay: 0 }).dueDay === 1, 'normalizeObligation: день платежа не меньше 1');
check(normalizeObligation({ frequency: 'weekly' }).frequency === 'monthly', 'normalizeObligation: недельных нет');
check(normalizeAsset({ kind: 'liability', assetClass: 'estate' }).assetClass === 'other', 'normalizeAsset: класс чужого вида сбрасывается');
check(normalizeAsset({ kind: 'asset', class: 'estate' }).assetClass === 'estate', 'normalizeAsset: поле class читается');
check(normalizeAsset({ kind: 'liability', value: '12 000' }).value === 1200000, 'normalizeAsset: остаток долга в копейках');

check(
  normalizeBudgetLines([
    { categoryId: 'x', limit: 1000 },
    { categoryId: 'x', limit: 2000 },
    { categoryId: '', limit: 3000 },
    { categoryId: 'y', limit: 0 }
  ]).length === 1,
  'normalizeBudgetLines: без повторов, пустых и нулевых'
);
const normalizedPlan = normalizeBudget({ expectedIncome: '50 000', savingsTarget: '10 000' });
check(normalizedPlan.expectedIncome === 5000000 && normalizedPlan.savingsTarget === 1000000, 'normalizeBudget: суммы');
check(
  normalizeSnapshot({ assetsTotal: 100000, liabilitiesTotal: 40000, netWorth: 999 }).netWorth === 60000,
  'normalizeSnapshot: нетто-капитал считается, а не берётся из данных'
);
check(normalizeSnapshot({}).netWorth === 0, 'normalizeSnapshot: пустой снимок безопасен');

/* ---------- журнал и справочник ---------- */

const journal = [
  { date: '2026-11-05', type: 'expense', amount: 1000, accountId: 'a' },
  { date: '2026-11-06', type: 'expense', amount: 2000, accountId: 'a' },
  { date: '2026-11-06', type: 'expense', amount: 5000, accountId: 'a' }
].sort(sortTransactions);
check(
  journal[0].amount === 5000 && journal[1].amount === 2000 && journal[2].date === '2026-11-05',
  'sortTransactions: свежие сверху, крупные первыми'
);

check(SEED_CATEGORIES.length === 16, 'SEED_CATEGORIES: 16 стартовых категорий');
check(new Set(SEED_CATEGORIES.map((item) => item.id)).size === SEED_CATEGORIES.length, 'SEED_CATEGORIES: id уникальны');
check(SEED_CATEGORIES.every((item) => item.title.length > 0), 'SEED_CATEGORIES: у всех есть название');
check(
  SEED_CATEGORIES.filter((item) => item.kind === 'income').every((item) => item.id.startsWith('inc:')),
  'SEED_CATEGORIES: доходы начинаются с inc:'
);
check(
  SEED_CATEGORIES.filter((item) => item.kind === 'expense').every((item) => !item.essential || item.group === 'needs'),
  'SEED_CATEGORIES: обязательными бывают только нужды'
);

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки бюджета пройдены (${total}).`);



/* ---------- обязательства ---------- */

check(obligationDate(monthly, '2026-02') === '2026-02-28', 'obligationDate: 31-е в феврале → 28-е');
check(obligationDate(monthly, '2028-02') === '2028-02-29', 'obligationDate: 31-е в високосный февраль');
check(obligationDate(monthly, '2026-04') === '2026-04-30', 'obligationDate: 31-е в апреле → 30-е');
check(obligationDate({ ...monthly, active: false }, '2026-11') === '', 'obligationDate: выключенное молчит');
check(obligationDate({ ...monthly, amount: 0 }, '2026-11') === '', 'obligationDate: без суммы не планируется');
check(
  obligationDate({ id: 'o2', dueDate: '2026-12-05', frequency: 'once', amount: 100 }, '2026-12') === '2026-12-05',
  'obligationDate: разовый платёж'
);
check(
  obligationDate({ id: 'o2', dueDate: '2026-12-05', frequency: 'once', amount: 100 }, '2027-01') === '',
  'obligationDate: разовый платёж не повторяется'
);
check(
  obligationDate({ id: 'o3', dueDate: '2026-03-05', frequency: 'yearly', amount: 100 }, '2026-03') === '2026-03-05',
  'obligationDate: годовой в свой месяц'
);
check(
  obligationDate({ id: 'o3', dueDate: '2026-03-05', frequency: 'yearly', amount: 100 }, '2026-04') === '',
  'obligationDate: годовой молчит в остальные месяцы'
);
check(nextObligationDate({ ...monthly, dueDay: 5 }, '2026-11-28') === '2026-12-05', 'nextObligationDate: следующий месяц');
check(nextObligationDate({ ...monthly, dueDay: 30 }, '2026-11-28') === '2026-11-30', 'nextObligationDate: платёж впереди');
check(monthlyEquivalent({ amount: 120000, frequency: 'yearly' }) === 10000, 'monthlyEquivalent: годовой делим на 12');
check(monthlyEquivalent({ amount: 50000, frequency: 'once' }) === 0, 'monthlyEquivalent: разовый не в прогнозе');
check(monthlyEquivalent({ amount: 50000, frequency: 'monthly', active: false }) === 0, 'monthlyEquivalent: выключен — ноль');
check(
  obligationsMonthlyTotal([monthly, { amount: 120000, frequency: 'yearly' }, { amount: 50000, frequency: 'once' }]) === 30000,
  'obligationsMonthlyTotal: сумма месячных эквивалентов'
);


/* ---------- денежные действия помощника ---------- */

const moneyActions = await load('src/lib/api/budget-actions.ts');
const moneyTool = await load('src/lib/api/budget-tools.ts');
const promptBuilder = await load('src/lib/api/prompts.ts');

const { applyBudgetActions, describeBudgetActions, normalizeBudgetAction } = moneyActions;

const stamp = { createdAt: 0, updatedAt: 0, dirty: 1 };
const testAccounts = [
  { id: 'acc-card', title: 'Карта', kind: 'card', openingBalance: 1000000, includeInFree: true, archived: false, order: 0, notes: '', ...stamp },
  { id: 'acc-save', title: 'Копилка', kind: 'savings', openingBalance: 5000000, includeInFree: false, archived: false, order: 1, notes: '', ...stamp },
  { id: 'acc-old', title: 'Старая карта', kind: 'card', openingBalance: 0, includeInFree: true, archived: true, order: 2, notes: '', ...stamp }
];
const testCategories = [
  { id: 'exp:food', title: 'Продукты', kind: 'expense', group: 'needs', essential: true, icon: '🛒', archived: false, order: 1, ...stamp },
  { id: 'inc:salary', title: 'Зарплата', kind: 'income', group: 'needs', essential: false, icon: '💼', archived: false, order: 2, ...stamp }
];
const testObligations = [
  {
    id: 'obl-rent',
    title: 'Аренда',
    kind: 'bill',
    amount: 3500000,
    frequency: 'monthly',
    dueDay: 5,
    dueDate: '',
    active: true,
    remind: true,
    categoryId: 'exp:food',
    accountId: 'acc-card',
    assetId: 'ast-debt',
    notes: '',
    ...stamp
  },
  {
    id: 'obl-old',
    title: 'Старая подписка',
    kind: 'subscription',
    amount: 99000,
    frequency: 'monthly',
    dueDay: 10,
    dueDate: '',
    active: false,
    remind: false,
    categoryId: '',
    accountId: 'acc-card',
    assetId: '',
    notes: '',
    ...stamp
  }
];
const testAssets = [
  { id: 'ast-debt', title: 'Долг', kind: 'liability', assetClass: 'loan', value: 10000000, ratePercent: 0, notes: '', ...stamp }
];
const testState = {
  accounts: testAccounts,
  categories: testCategories,
  obligations: testObligations,
  assets: testAssets
};

let txSeq = 0;
const applyMoney = (actions) =>
  applyBudgetActions(actions, testState, {
    today: '2026-11-28',
    now: 1000,
    newId: () => `tx-${++txSeq}`
  });

check(
  normalizeBudgetAction({ type: 'transaction.expense', amount: 500, accountId: 'acc-card' }).amount === 50000,
  'деньги: рубли модели превращаются в копейки'
);
check(
  normalizeBudgetAction({ type: 'transaction.expense', accountId: 'acc-card' }) === null,
  'деньги: без суммы действие отбрасывается'
);
check(
  normalizeBudgetAction({ type: 'transaction.expense', amount: 500 }) === null,
  'деньги: без счёта действие отбрасывается'
);
check(
  normalizeBudgetAction({ type: 'transaction.transfer', amount: 100, accountId: 'acc-card', toAccountId: 'acc-card' }) === null,
  'деньги: перевод сам в себя отбрасывается'
);
check(normalizeBudgetAction({ type: 'obligation.pay' }) === null, 'деньги: оплата без id отбрасывается');
check(normalizeBudgetAction({ type: 'savings.topup', amount: 100 }) === null, 'деньги: неизвестный тип отбрасывается');
check(
  normalizeBudgetAction({ type: 'transaction.expense', amount: 100, accountId: 'acc-card', date: '2026-02-30' }, '2026-11-28').date === '2026-11-28',
  'деньги: битая дата — это сегодня'
);

const expense = applyMoney([
  { type: 'transaction.expense', amount: 500, accountId: 'acc-card', categoryId: 'exp:food', payee: 'Пятёрочка' }
]);
const expenseRow = expense.changes.transactions.put[0];
check(
  expense.applied.length === 1 && expenseRow.type === 'expense' && expenseRow.amount === 50000,
  'деньги: расход записан в копейках'
);
check(
  expenseRow.date === '2026-11-28' && expenseRow.categoryId === 'exp:food' && expenseRow.payee === 'Пятёрочка',
  'деньги: дата, категория и получатель расхода'
);
check(expense.changes.assets.put.length === 0, 'деньги: расход не трогает активы');
check(expense.undo.transactions.remove[0] === expenseRow.id, 'деньги: откат удаляет созданный расход');
const expenseLabel = describeBudgetActions(
  [{ type: 'transaction.expense', amount: 500, accountId: 'acc-card', categoryId: 'exp:food' }],
  testState,
  '2026-11-28'
)[0];
check(
  expenseLabel.includes('расход') && expenseLabel.includes('Продукты') && expenseLabel.includes('Карта'),
  'деньги: подпись расхода называет категорию и счёт'
);

const transfer = applyMoney([
  { type: 'transaction.transfer', amount: 700, accountId: 'acc-card', toAccountId: 'acc-save', categoryId: 'exp:food' }
]);
const transferRow = transfer.changes.transactions.put[0];
check(
  transferRow.type === 'transfer' && transferRow.categoryId === '' && transferRow.toAccountId === 'acc-save',
  'деньги: перевод без категории, между счетами'
);
check(
  describeBudgetActions(
    [{ type: 'transaction.transfer', amount: 700, accountId: 'acc-card', toAccountId: 'acc-save' }],
    testState,
    '2026-11-28'
  )[0].includes('Копилка'),
  'деньги: подпись перевода называет счёт получателя'
);

const pay = applyMoney([{ type: 'obligation.pay', id: 'obl-rent' }]);
const payRow = pay.changes.transactions.put[0];
check(
  payRow.type === 'expense' && payRow.amount === 3500000 && payRow.obligationId === 'obl-rent',
  'деньги: оплата платежа — расход со ссылкой на платёж'
);
check(
  pay.changes.assets.put.length === 1 && pay.changes.assets.put[0].value === 6500000,
  'деньги: оплата уменьшает остаток долга'
);
check(
  pay.undo.assets.put[0] && pay.undo.assets.put[0].value === 10000000,
  'деньги: откат возвращает прежний долг'
);
check(
  describeBudgetActions([{ type: 'obligation.pay', id: 'obl-rent' }], testState, '2026-11-28')[0].includes('Аренда'),
  'деньги: подпись оплаты называет платёж'
);

check(
  applyMoney([{ type: 'transaction.expense', amount: 100, accountId: 'acc-old', categoryId: 'exp:food' }]).applied.length === 0,
  'деньги: на архивный счёт не пишем'
);
check(
  applyMoney([{ type: 'transaction.expense', amount: 100, accountId: 'acc-card', categoryId: 'exp:nope' }]).skipped.length === 1,
  'деньги: неизвестная категория — пропуск с причиной'
);
check(
  applyMoney([{ type: 'transaction.expense', amount: 100, accountId: 'acc-card', categoryId: 'exp:nope' }]).changes.transactions.put.length === 0,
  'деньги: с неизвестной категорией операция не создаётся'
);
check(
  applyMoney([{ type: 'transaction.transfer', amount: 100, accountId: 'acc-card', toAccountId: 'acc-old' }]).applied.length === 0,
  'деньги: перевод на архивный счёт не проходит'
);
check(applyMoney([{ type: 'obligation.pay', id: 'obl-old' }]).applied.length === 0, 'деньги: архивный платёж не оплачиваем');
check(applyMoney([{ type: 'obligation.pay', id: 'obl-nope' }]).skipped.length === 1, 'деньги: неизвестный платёж — пропуск');

const many = applyMoney(
  Array.from({ length: 6 }, () => ({ type: 'transaction.expense', amount: 10, accountId: 'acc-card' }))
);
check(many.applied.length === 4 && many.skipped.length === 1, 'деньги: не больше четырёх действий за ответ');

check(moneyTool.BUDGET_ACTIONS_TOOL.function.name === 'budget_actions', 'деньги: имя инструмента стабильно');
check(
  moneyTool.BUDGET_ACTIONS_TOOL.function.parameters.properties.actions.maxItems === 4,
  'деньги: схема инструмента ограничивает четырьмя действиями'
);
check(
  moneyTool.BUDGET_ACTIONS_TOOL.function.parameters.properties.actions.items.properties.type.enum.length === 4,
  'деньги: в схеме ровно четыре типа действий'
);

/* ---------- бюджет в промпте помощника ---------- */

const promptBudget = promptBuilder.buildBudgetPrompt(
  {
    accounts: testAccounts,
    categories: testCategories,
    obligations: testObligations,
    transactions: [{ date: '2026-11-20', type: 'expense', amount: 100000, accountId: 'acc-card' }]
  },
  { today: '2026-11-28' }
);
check(promptBudget.accounts.length === 2, 'промпт: архивные счета скрыты');
check(promptBudget.accounts[0].id === 'acc-save', 'промпт: счета по убыванию остатка');
check(
  promptBudget.accounts.find((item) => item.id === 'acc-card').balance === 900000,
  'промпт: остаток счёта считается по операциям'
);
check(
  promptBudget.obligations.length === 1 && promptBudget.obligations[0].date === '2026-12-05',
  'промпт: только активные платежи в окне'
);

const plannerNow = new Date('2026-11-28T10:00:00');
const calendarCtx = promptBuilder.buildPlannerContext([], plannerNow);
const budgetSystem = promptBuilder.plannerAssistantSystem({ ...calendarCtx, budget: promptBudget });
check(budgetSystem.includes('budget_actions'), 'промпт: денежный инструмент назван');
check(budgetSystem.includes('id: acc-card') && budgetSystem.includes('id: exp:food'), 'промпт: id счетов и категорий');
check(budgetSystem.includes('id: obl-rent'), 'промпт: id платежа для оплаты');
check(budgetSystem.includes('Не больше 4 денежных действий'), 'промпт: лимит денежных действий');
check(budgetSystem.includes('Суммы не выдумывай'), 'промпт: запрет придумывать суммы');
check(
  !promptBuilder.plannerAssistantSystem(calendarCtx).includes('budget_actions'),
  'промпт: без бюджета денег не обещаем'
);

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length} из ${total}`);
  process.exit(1);
}
console.log(`\nВсе проверки бюджета пройдены (${total}).`);

