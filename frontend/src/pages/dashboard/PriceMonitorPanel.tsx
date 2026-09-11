import type { InstrumentWithMappings, LatestPrice } from "../../api/client";
import {
  formatDateTime,
  formatDecimal,
  formatLevels,
  formatSourceLabel,
} from "../../utils/format";
import {
  computeResistanceDistancePercent,
  computeRiskRewardRatio,
  computeSupportDistancePercent,
  formatMetric,
  nearestInstrumentLevels,
} from "../../utils/instrumentMetrics";

type PriceMonitorPanelProps = {
  readonly prices: readonly LatestPrice[];
  readonly instruments: readonly InstrumentWithMappings[];
};

type SourceMapping = InstrumentWithMappings["source_mappings"][number];

type FlatPriceRow = {
  readonly instrument: InstrumentWithMappings;
  readonly price: LatestPrice | null;
  readonly source: SourceMapping;
};

function groupPricesByInstrument(prices: readonly LatestPrice[]): Map<number, LatestPrice[]> {
  const buckets = new Map<number, LatestPrice[]>();
  for (const price of prices) {
    const existing = buckets.get(price.instrument_id);
    if (existing === undefined) {
      buckets.set(price.instrument_id, [price]);
    } else {
      existing.push(price);
    }
  }
  return buckets;
}

function buildFlatRows(
  prices: readonly LatestPrice[],
  instruments: readonly InstrumentWithMappings[],
): readonly FlatPriceRow[] {
  const buckets = groupPricesByInstrument(prices);
  const rows: FlatPriceRow[] = [];

  for (const instrument of instruments) {
    if (!instrument.enabled) {
      continue;
    }
    const priceBySourceId = new Map(
      (buckets.get(instrument.id) ?? []).map((price) => [price.source_mapping_id, price]),
    );
    for (const source of instrument.source_mappings) {
      if (!source.enabled) {
        continue;
      }
      rows.push({ instrument, price: priceBySourceId.get(source.id) ?? null, source });
    }
  }

  rows.sort((left, right) => {
    const byName = left.instrument.name.localeCompare(right.instrument.name);
    if (byName !== 0) {
      return byName;
    }
    const leftSource = formatSourceLabel(
      left.source.provider,
      left.source.market_type,
      left.source.symbol,
    );
    const rightSource = formatSourceLabel(
      right.source.provider,
      right.source.market_type,
      right.source.symbol,
    );
    return leftSource.localeCompare(rightSource);
  });

  return rows;
}

type PriceTableRowProps = {
  readonly row: FlatPriceRow;
};

function PriceTableRow({ row }: PriceTableRowProps) {
  const { instrument, price, source } = row;
  const { support, resistance } = price === null
    ? { support: undefined, resistance: undefined }
    : nearestInstrumentLevels(price.last_price, instrument.supports, instrument.resistances);
  const supportPct =
    price !== null && support !== undefined
      ? computeSupportDistancePercent(price.last_price, support)
      : null;
  const resistancePct =
    price !== null && resistance !== undefined
      ? computeResistanceDistancePercent(price.last_price, resistance)
      : null;
  const riskReward =
    price !== null && support !== undefined && resistance !== undefined
      ? computeRiskRewardRatio(price.last_price, support, resistance)
      : null;
  const sourceLabel = formatSourceLabel(source.provider, source.market_type, source.symbol);

  return (
    <tr className="price-table-row">
      <td className="price-table-row__instrument">
        <span className="price-table-row__instrument-name">{instrument.name}</span>
        {price !== null && (price.support_breached || price.resistance_broken) && (
          <span className="price-table-row__crossings" aria-label="历史价位突破">
            {price.support_breached && (
              <span className="price-crossing price-crossing--support">曾跌破支撑</span>
            )}
            {price.resistance_broken && (
              <span className="price-crossing price-crossing--resistance">曾突破阻力</span>
            )}
          </span>
        )}
      </td>
      <td className="price-table-row__levels muted-text">
        <span className="price-table-row__level-pair">
          <span>
            支撑{" "}
            <span className="price-monitor__level-value">{formatLevels(instrument.supports)}</span>
          </span>
          <span className="price-monitor__levels-sep" aria-hidden="true">
            ·
          </span>
          <span>
            阻力{" "}
            <span className="price-monitor__level-value">
              {formatLevels(instrument.resistances)}
            </span>
          </span>
        </span>
      </td>
      <td className="price-table-row__source">{sourceLabel}</td>
      <td className="price-table-row__price">
        {price === null ? "待获取" : formatDecimal(price.last_price)}
      </td>
      <td className="price-table-row__metric">{formatMetric(supportPct, "%")}</td>
      <td className="price-table-row__metric">{formatMetric(resistancePct, "%")}</td>
      <td className="price-table-row__metric">{formatMetric(riskReward)}</td>
      <td className="price-table-row__time muted-text">
        {price === null ? (
          "—"
        ) : (
          <time dateTime={price.last_observed_at}>{formatDateTime(price.last_observed_at)}</time>
        )}
      </td>
    </tr>
  );
}

export function PriceMonitorPanel({ prices, instruments }: PriceMonitorPanelProps) {
  const rows = buildFlatRows(prices, instruments);

  if (rows.length === 0) {
    return <p className="empty-state">暂无价格数据。</p>;
  }

  return (
    <div className="price-monitor-table-wrap">
      <table className="price-monitor-table">
        <thead>
          <tr>
            <th scope="col">标的</th>
            <th scope="col">支撑 / 阻力</th>
            <th scope="col">来源</th>
            <th scope="col">价格</th>
            <th scope="col">距支撑</th>
            <th scope="col">距阻力</th>
            <th scope="col">盈亏比</th>
            <th scope="col">更新时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PriceTableRow
              key={`${row.instrument.id}-${row.source.id}`}
              row={row}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}