<script lang="ts">
  import Sparkline from '../../components/Sparkline.svelte';
  import Stat from '../../components/Stat.svelte';
  import type {
    BudgetAsset,
    BudgetSnapshot,
    BudgetTransaction,
    MoneyAccount
  } from '../../db/db';
  import { ASSET_CLASS_TITLES, LIABILITY_CLASS_TITLES, netWorth } from '../../utils/budget';
  import { formatMoney } from '../../utils/money';
  import { formatDateRu } from '../../utils/planner';

  let {
    accounts,
    transactions,
    assets,
    snapshots,
    onOpen,
    onNew,
    onSnapshot
  }: {
    accounts: MoneyAccount[];
    transactions: BudgetTransaction[];
    assets: BudgetAsset[];
    snapshots: BudgetSnapshot[];
    onOpen: (asset: BudgetAsset) => void;
    onNew: () => void;
    onSnapshot: () => void;
  } = $props();

  const worth = $derived(netWorth(accounts, transactions, assets));
  const assetRows = $derived(assets.filter((asset) => asset.kind === 'asset'));
  const liabilityRows = $derived(assets.filter((asset) => asset.kind === 'liability'));

  const points = $derived(snapshots.slice(-12).map((snapshot) => snapshot.netWorth));
  const labels = $derived(
    snapshots.slice(-12).map((snapshot) => formatDateRu(snapshot.date))
  );

  function classLabel(asset: BudgetAsset): string {
    const titles = asset.kind === 'liability' ? LIABILITY_CLASS_TITLES : ASSET_CLASS_TITLES;
    return titles[asset.assetClass] ?? '';
  }
</script>

<div class="tab">
  <div class="row-between">
    <div class="tiles">
      <Stat
        label="Нетто-капитал"
        value={formatMoney(worth.net)}
        hint="деньги + активы − долги"
        tone={worth.net < 0 ? 'bad' : 'good'}
      />
      <Stat label="Деньги" value={formatMoney(worth.cash)} hint="все счета" />
      <Stat label="Прочие активы" value={formatMoney(worth.assets)} />
      <Stat label="Долги" value={formatMoney(worth.liabilities)} tone={worth.liabilities > 0 ? 'warn' : 'neutral'} />
    </div>
    <button class="btn btn-primary btn-sm" onclick={onNew}>+ Актив</button>
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Динамика капитала</strong>
      <button class="btn btn-sm" onclick={onSnapshot}>Снять снимок</button>
    </div>
    {#if points.length === 0}
      <p class="mute small empty-line">
        Снимков пока нет. Снимайте их раз в месяц — появится график, а сравнение с прошлым
        периодом станет честным.
      </p>
    {:else}
      <Sparkline {points} {labels} height={96} tone={worth.net < 0 ? 'bad' : 'good'} format={(value) => formatMoney(value)} />
      <p class="tiny mute hint">Снимок один на дату: повторное нажатие уточняет суммы за сегодня.</p>
    {/if}
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Активы</strong>
      <span class="mute tiny">{formatMoney(worth.assets)}</span>
    </div>
    {#if assetRows.length === 0}
      <p class="mute small empty-line">Квартира, машина, техника — всё, что можно продать.</p>
    {:else}
      <ul class="list">
        {#each assetRows as asset (asset.id)}
          <li>
            <button class="row-btn" onclick={() => onOpen(asset)}>
              <span class="grow">
                <span class="name">{asset.title}</span>
                <span class="tiny mute">{classLabel(asset)}</span>
              </span>
              <strong class="amount">{formatMoney(asset.value)}</strong>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <div class="row-between">
      <strong>Долги</strong>
      <span class="mute tiny">{formatMoney(worth.liabilities)}</span>
    </div>
    {#if liabilityRows.length === 0}
      <p class="mute small empty-line">Ипотека, кредиты, рассрочки — остаток долга на сегодня.</p>
    {:else}
      <ul class="list">
        {#each liabilityRows as asset (asset.id)}
          <li>
            <button class="row-btn" onclick={() => onOpen(asset)}>
              <span class="grow">
                <span class="name">{asset.title}</span>
                <span class="tiny mute">
                  {classLabel(asset)}{asset.ratePercent > 0 ? ` · ${asset.ratePercent} % годовых` : ''}
                </span>
              </span>
              <strong class="amount neg">{formatMoney(asset.value)}</strong>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="tiny mute hint">
      Денежные счета сюда не входят — они уже учтены в «Деньгах», чтобы капитал не задваивался.
    </p>
  </div>
</div>
<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .row-between {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .list {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .list li {
    border-bottom: 1px solid var(--border-soft);
  }

  .list li:last-child {
    border-bottom: none;
  }

  .row-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 0;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
  }

  .row-btn:hover .name {
    color: var(--accent);
  }

  .name {
    display: block;
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .amount {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .amount.neg {
    color: var(--danger);
  }

  .hint {
    margin: 8px 0 0;
  }

  .empty-line {
    margin: 8px 0 0;
  }
</style>

