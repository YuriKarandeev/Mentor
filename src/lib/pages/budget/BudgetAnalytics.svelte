<script lang="ts">
  import BarList from '../../components/BarList.svelte';
  import Sparkline from '../../components/Sparkline.svelte';
  import Stat from '../../components/Stat.svelte';
  import type {
    BudgetCategory,
    BudgetObligation,
    BudgetTransaction,
    MoneyAccount,
    MonthBudget
  } from '../../db/db';
  import {
    categoryDelta,
    debtLoad,
    essentialMonthly,
    groupShares,
    lastMonths,
    monthFlow,
    monthShortLabel,
    monthSpend,
    obligationsMonthlyTotal,
    reserveMonths,
    savingsRate,
    savingsTotal,
    shiftMonth,
    topCategories
  } from '../../utils/budget';
  import { formatMoney } from '../../utils/money';
  import { todayIso } from '../../utils/planner';

  let {
    accounts,
    categories,
    transactions,
    budget,
    obligations,
    month
  }: {
    accounts: MoneyAccount[];
    categories: BudgetCategory[];
    transactions: BudgetTransaction[];
    budget: MonthBudget | null;
    obligations: BudgetObligation[];
    month: string;
  } = $props();

  const now = todayIso();
  const flow = $derived(monthFlow(transactions, month, accounts, categories));
  const spend = $derived(monthSpend(transactions, month, now));
  const previous = $derived(monthFlow(transactions, shiftMonth(month, -1), accounts, categories));
  const expenseDelta = $derived(categoryDelta(spend.spent, previous.expense));

  const months = $derived(lastMonths(6, now));
  const expenseSeries = $derived(months.map((key) => monthFlow(transactions, key, accounts, categories).expense));
  const monthLabels = $derived(months.map((key) => monthShortLabel(key)));

  const shares = $derived(groupShares(transactions, month, categories));
  const shareBars = $derived(
    shares.groups.map((group) => ({
      key: group.group,
      label: `${group.title} · цель ${group.target} %`,
      valueLabel: formatMoney(group.amount),
      percent: group.percent,
      note: `${group.percent} % расходов`,
      tone: group.percent > group.target + 10 ? ('bad' as const) : group.percent <= group.target ? ('good' as const) : ('warn' as const)
    }))
  );

  const top = $derived(topCategories(transactions, month, categories, 6));
  const topBars = $derived(
    top.map((item) => ({
      key: item.categoryId,
      label: `${item.icon} ${item.title}`,
      valueLabel: formatMoney(item.amount),
      percent: item.share,
      note: `${item.share} % расходов`
    }))
  );

  const reserve = $derived(savingsTotal(accounts, transactions));
  const essential = $derived(essentialMonthly(transactions, categories, months.slice(-3)));
  const monthlyBills = $derived(obligationsMonthlyTotal(obligations));
  const load = $derived(debtLoad(monthlyBills, flow.income));
</script>
<div class="tab">
  <div class="tiles">
    <Stat
      label="Норма сбережений"
      value={`${savingsRate(flow)} %`}
      hint={`сбережено ${formatMoney(flow.saved)}`}
      tone={savingsRate(flow) >= 20 ? 'good' : savingsRate(flow) > 0 ? 'warn' : 'neutral'}
    />
    <Stat
      label="Прогноз расходов"
      value={spend.days > 0 ? formatMoney(spend.forecast) : '—'}
      hint={spend.days > 0 ? `по ${spend.days} дням` : 'месяц ещё не начался'}
    />
    <Stat
      label="Средний расход в день"
      value={spend.days > 0 ? formatMoney(spend.perDay) : '—'}
      hint={`потрачено ${formatMoney(spend.spent)}`}
    />
    <Stat
      label="Резерв"
      value={essential > 0 ? `${reserveMonths(reserve, essential)} мес.` : '—'}
      hint={essential > 0 ? `обязательных трат ${formatMoney(essential)}/мес` : 'нет данных о тратах'}
      tone={reserveMonths(reserve, essential) >= 3 ? 'good' : reserveMonths(reserve, essential) > 0 ? 'warn' : 'neutral'}
    />
    <Stat
      label="Долговая нагрузка"
      value={flow.income > 0 ? `${load} %` : '—'}
      hint={`платежи ${formatMoney(monthlyBills)}/мес`}
      tone={load > 40 ? 'bad' : load > 25 ? 'warn' : 'good'}
    />
    <Stat
      label="К прошлому месяцу"
      value={expenseDelta === null ? '—' : `${expenseDelta > 0 ? '+' : ''}${expenseDelta} %`}
      hint={`было ${formatMoney(previous.expense)}`}
      tone={expenseDelta !== null && expenseDelta > 0 ? 'bad' : 'neutral'}
    />
  </div>

  <div class="card">
    <strong>Расходы за полгода</strong>
    <Sparkline
      points={expenseSeries}
      labels={monthLabels}
      height={90}
      tone="accent"
      format={(value) => formatMoney(value)}
    />
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Правило 50/30/20</strong>
      <span class="mute tiny">расходы месяца {formatMoney(shares.total)}</span>
    </div>
    <BarList items={shareBars} empty="В этом месяце расходов ещё нет." />
    <p class="tiny mute hint">
      Ориентир: 50 % — нужды, 30 % — желания, 20 % — сбережения. Это не догма, а способ увидеть
      перекос: если «желания» заметно выше цели, деньги уходят не туда, куда планировалось.
    </p>
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Куда уходят деньги</strong>
      <span class="mute tiny">топ категорий</span>
    </div>
    <BarList items={topBars} empty="Нет расходов с категориями." />
  </div>

  <div class="card">
    <strong>Что это значит</strong>
    <ul class="notes small">
      <li>
        <b>Норма сбережений</b> — доля сбережённого от дохода. Перевод на копилку считается
        сбережением, перевод между текущими счетами — нет.
      </li>
      <li>
        <b>Резерв</b> — сколько месяцев обязательных трат покрывают накопления. Три месяца — уже
        устойчиво, полгода — спокойно.
      </li>
      <li>
        <b>Долговая нагрузка</b> — доля обязательных платежей от дохода месяца. Выше 40 % — деньги
        работают на долги, а не на вас.
      </li>
      <li>
        Всё считается по кассовому методу: доход и расход попадают в месяц фактической операции,
        а прогноз расходов — это средний расход в день × дней в месяце.
      </li>
    </ul>
  </div>
</div>
<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }

  .hint {
    margin: 8px 0 0;
  }

  .notes {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--text-dim);
  }

  .notes li {
    margin-bottom: 6px;
  }

  .notes li:last-child {
    margin-bottom: 0;
  }
</style>


