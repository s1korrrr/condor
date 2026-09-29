import { useState } from "react";
import type { MarketContext } from "./market-context";
import { formatDisplayNumber } from "./model.mjs";

const pair = (id: string) => id.split(":").at(-1) || id;
const words = (value: string) => value.replaceAll("_", " ");
const number = (value: string | null | undefined, suffix = "") =>
  value == null ? "Unavailable" : `${formatDisplayNumber(value, 2)}${suffix}`;
const participationLabels: Record<string, string> = {
  above_ema21: "Above EMA21",
  rsi_above_50: "RSI > 50",
  rsi_oversold_30: "RSI ≤ 30",
  rsi_overbought_70: "RSI ≥ 70",
  rvol_ge_1_5: "Relative volume ≥ 1.5×",
  compression_le_20: "Compression ≤ 20th percentile",
  adx_gt_18: "ADX > 18",
};

export function MarketOverview({
  context,
  freshness,
}: {
  context?: MarketContext;
  freshness: string;
}) {
  const [benchmark, setBenchmark] = useState("BTC");
  const [horizon, setHorizon] = useState("1h");
  if (!context || context.schema_version !== "market-context.v1") return null;
  const source = context.source;
  const correlation = context.correlations;
  const ids = context.assets.map((asset) => asset.instrument_id);
  const isCurrent = ["Recorded candles", "Partial coverage"].includes(
    freshness,
  );
  return (
    <section className="market-overview" aria-label="Market overview">
      <header className="market-overview-head">
        <div>
          <h2>Market overview</h2>
          <p>
            {source.venue.toUpperCase()} {source.lane} · {source.quote_asset} ·{" "}
            {source.aligned_count}/{source.subscribed_count} registered
            instruments aligned
          </p>
        </div>
        <span className="market-context-state">
          {isCurrent ? words(source.completeness) : freshness}
        </span>
      </header>
      <p className="market-context-note">
        Full registered universe before screening. Filters and pagination do not
        change these denominators. Alignment uses the newest fresh recorded
        close; lagging instruments are omitted even when older history overlaps.
        Exchange-wide coverage is unavailable.
      </p>
      {!isCurrent && (
        <p className="market-context-warning" role="status">
          Last snapshot retained. These observations are not current; their
          original cutoff is shown below.
        </p>
      )}
      <div
        className="market-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Breadth by horizon"
      >
        <table className="market-context-table">
          <caption>
            Participation and return distribution · {source.interval} closed
            bars
          </caption>
          <thead>
            <tr>
              <th scope="col">Horizon</th>
              <th scope="col">Positive breadth</th>
              <th scope="col">Up / Down / Flat</th>
              <th scope="col">Coverage</th>
              <th scope="col">Mean return</th>
              <th scope="col">Median return</th>
              <th scope="col">Dispersion</th>
              <th scope="col">Downside magnitude</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(context.breadth.horizons).map(([key, entry]) => (
              <tr key={key} title={entry.reason_codes.map(words).join(" · ")}>
                <th scope="row">{key}</th>
                <td>{number(entry.positive_percent, "%")}</td>
                <td>
                  {entry.denominator
                    ? `${entry.advancing} / ${entry.declining} / ${entry.unchanged}`
                    : "Unavailable"}
                </td>
                <td>
                  {entry.denominator}/{entry.subscribed_denominator}
                  {entry.omitted > 0 && (
                    <small> · {entry.omitted} omitted</small>
                  )}
                </td>
                <td>{number(entry.equal_weight_mean_return_pct, "%")}</td>
                <td>{number(entry.median_return_pct, "%")}</td>
                <td>{number(entry.dispersion_population_std_pct, " pp")}</td>
                <td>{number(entry.systemic_downside_pct, "%")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="market-context-note">
        Mean is equally weighted. Flat returns are separate from decliners.
        Dispersion is population standard deviation; downside magnitude is
        max(−mean return, 0), not a forecast.
      </p>
      <ul className="market-participation">
        {Object.entries(context.breadth.participation).map(([key, entry]) => (
          <li key={key} title={entry.reason_codes.map(words).join(" · ")}>
            <span>{participationLabels[key] || words(key)}</span>
            <strong>{number(entry.percent, "%")}</strong>
            <small>
              {entry.count}/{entry.denominator} valid · {entry.omitted} omitted
            </small>
          </li>
        ))}
      </ul>
      <details open className="market-context-details">
        <summary>Recorded regimes and trend context</summary>
        <p className="market-context-note">
          Regime, direction and context bias are independent fields recorded by
          each controller on this bar. They can disagree. Confidence is the
          producer's reported score; model identity and calibration were not
          recorded. EMA, ADX and volatility are reconstructed separately.
        </p>
        <div
          className="market-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Recorded regimes and trend context"
        >
          <table className="market-context-table">
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col">Recorded regime</th>
                <th scope="col">Confidence</th>
                <th scope="col">Trend / confidence</th>
                <th scope="col">Context bias</th>
                <th scope="col">EMA9/21</th>
                <th scope="col">ADX / +DI / −DI</th>
                <th scope="col">ATR / realized vol.</th>
              </tr>
            </thead>
            <tbody>
              {context.assets.map((asset) => {
                const producer = asset.producer_context;
                const fields = producer.fields;
                const trend = asset.trend_snapshot;
                const valid = producer.status === "valid";
                const metric = (
                  entry: { value: string | null; status: string },
                  suffix = "",
                ) =>
                  entry.status === "valid"
                    ? number(entry.value, suffix)
                    : words(entry.status);
                return (
                  <tr key={asset.instrument_id}>
                    <th scope="row">{pair(asset.instrument_id)}</th>
                    <td title={producer.reason_codes.map(words).join(" · ")}>
                      {valid && fields.regime_label
                        ? words(fields.regime_label)
                        : "Unavailable"}
                      <small>
                        {producer.observed_at
                          ? new Date(producer.observed_at).toLocaleTimeString()
                          : "No observation"}
                      </small>
                    </td>
                    <td>
                      {valid ? number(fields.regime_confidence) : "Unavailable"}
                    </td>
                    <td>
                      {valid
                        ? fields.trend_direction || "Unavailable"
                        : "Unavailable"}{" "}
                      /{" "}
                      {valid ? number(fields.trend_confidence) : "Unavailable"}
                    </td>
                    <td>
                      {valid
                        ? fields.buy_context_bias || "Unavailable"
                        : "Unavailable"}
                    </td>
                    <td>
                      {trend.alignment.status === "valid"
                        ? String(trend.alignment.value ?? "Unavailable")
                        : words(trend.alignment.status)}
                    </td>
                    <td>
                      {metric(trend.adx_14)} / {metric(trend.plus_di_14)} /{" "}
                      {metric(trend.minus_di_14)}
                    </td>
                    <td>
                      {metric(trend.atr_pct_14, "%")} /{" "}
                      {metric(trend.realized_volatility_20, "%")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
      <details className="market-context-details">
        <summary>Correlation and relative strength</summary>
        <p className="market-context-note">
          Pearson correlation · {correlation.window_returns} aligned simple
          returns · mean {number(correlation.summary.mean_off_diagonal)} ·{" "}
          {correlation.summary.valid_pair_count}/
          {correlation.summary.pair_count} valid pairs ·{" "}
          {correlation.summary.dense_pair_count} with |ρ| ≥{" "}
          {correlation.edge_threshold_abs}. Constant or missing series stay
          unavailable.
        </p>
        <div
          className="market-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Correlation matrix"
        >
          <table className="market-context-table market-correlation">
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                {ids.map((id) => (
                  <th scope="col" key={id}>
                    {pair(id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ids.map((left) => (
                <tr key={left}>
                  <th scope="row">{pair(left)}</th>
                  {ids.map((right) => {
                    const cell = correlation.matrix[left]?.[right];
                    return (
                      <td
                        key={right}
                        title={cell?.reason_codes.map(words).join(" · ")}
                      >
                        {number(cell?.value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="market-context-controls">
          <label>
            Benchmark{" "}
            <select
              value={benchmark}
              onChange={(event) => setBenchmark(event.target.value)}
            >
              {["BTC", "ETH", "BNB", "SOL"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Return horizon{" "}
            <select
              value={horizon}
              onChange={(event) => setHorizon(event.target.value)}
            >
              {Object.keys(context.breadth.horizons).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <ul className="market-participation">
          {context.assets.map((asset) => {
            const entry =
              asset.relative_strength.vs_benchmarks[benchmark]?.[horizon];
            return (
              <li key={asset.instrument_id}>
                <span>{pair(asset.instrument_id)}</span>
                <strong>
                  {number(entry?.difference_percentage_points, " pp")}
                </strong>
                <small>
                  {entry?.reason_codes.length
                    ? entry.reason_codes.map(words).join(" · ")
                    : `return minus ${benchmark} return`}
                </small>
              </li>
            );
          })}
        </ul>
        <p className="market-context-note">
          Relative return is a percentage-point difference. It is not the
          canonical factor model's alpha, beta or residual strength.
        </p>
      </details>
      <details className="market-context-details">
        <summary>Leaders, laggards and source definitions</summary>
        <ul className="market-leaders">
          {Object.entries(context.breadth.horizons).map(([key, value]) => (
            <li key={key}>
              <strong>{key}</strong>
              <span>
                Leader:{" "}
                {value.best
                  ? `${pair(value.best.instrument_id)} ${number(value.best.return_pct, "%")}`
                  : "Unavailable"}
              </span>
              <span>
                Laggard:{" "}
                {value.worst
                  ? `${pair(value.worst.instrument_id)} ${number(value.worst.return_pct, "%")}`
                  : "Unavailable"}
              </span>
            </li>
          ))}
        </ul>
        <p className="market-context-note">
          Cutoff {source.common_cutoff || "Unavailable"} · source{" "}
          {source.source_id} · revision {source.source_revision} ·{" "}
          {context.feature_set_version}. Original ingestion times are
          unavailable.
        </p>
        <pre className="market-definition">
          {JSON.stringify(context.definitions, null, 2)}
        </pre>
        <ul className="market-provider-list">
          {context.capabilities.map((capability) => (
            <li key={capability.id}>
              <strong>{words(capability.id)}</strong>
              <span>
                {words(capability.availability)}
                {capability.reason_codes?.length
                  ? ` · ${capability.reason_codes.map(words).join(" · ")}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
