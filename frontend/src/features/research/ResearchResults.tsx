import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from "recharts";
import { sourceResultBars, comparisonGroups } from "./results";
import { object, records, text, type RecordData } from "./model";
import { safeSourceUrl } from "./research-detail";

const tooltip = {
  backgroundColor: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  borderRadius: 5,
};
export function ResearchResults({
  data,
  comparisons,
  onSelect,
}: {
  data: RecordData;
  comparisons?: RecordData;
  onSelect?: (id: string) => void;
}) {
  const bars = sourceResultBars(data),
    sourceComparisons = records(comparisons?.items),
    groups = comparisonGroups(sourceComparisons);
  const excludedComparisons =
    sourceComparisons.length -
    groups.reduce((total, group) => total + group.items.length, 0);
  const limitations = (
    Array.isArray(comparisons?.limitations) ? comparisons.limitations : []
  ).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return (
    <section className="quant-panel" style={{ marginBottom: 20 }}>
      <header className="quant-panel-heading">
        <div>
          <h2>Research performance</h2>
          <p className="quant-muted">
            Selected record · historical source results, separate from live
            account PnL.
          </p>
        </div>
        {typeof data.verdict === "string" ? (
          <span>{text(data.verdict)}</span>
        ) : null}
      </header>
      <div className="quant-detail-body">
        {bars.length ? (
          <>
            <p>
              Source-reported totals in quote units. These are final recorded
              values, not an equity curve or proof of a valid baseline
              comparison.
            </p>
            <div style={{ height: 230, width: "100%" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={bars}
                  margin={{ top: 15, right: 20, left: 10, bottom: 0 }}
                  accessibilityLayer
                >
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="var(--color-text-muted)"
                    tickLine={false}
                  />
                  <YAxis
                    stroke="var(--color-text-muted)"
                    tickLine={false}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={tooltip}
                    cursor={{ fill: "var(--color-surface-hover)" }}
                  />
                  <ReferenceLine y={0} stroke="var(--color-text-muted)" />
                  <Bar dataKey="value" name="Quote units" maxBarSize={75}>
                    {bars.map((b) => (
                      <Cell
                        key={b.key}
                        fill={
                          b.value < 0
                            ? "var(--color-red)"
                            : b.key === "fees_quote"
                              ? "var(--color-text-muted)"
                              : "var(--color-primary)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <details>
              <summary>Recorded values</summary>
              <dl>
                {bars.map((b) => (
                  <div key={b.key}>
                    <dt>{b.label}</dt>
                    <dd>
                      {b.value.toLocaleString(undefined, {
                        maximumFractionDigits: 8,
                      })}{" "}
                      quote units
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </>
        ) : (
          <p>
            This record has no numeric PnL totals. Select a result-bearing idea
            or report in the library to inspect its recorded performance.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key}>
            <h3>Delta against {group.baseline}</h3>
            <p>
              {group.metric} · {group.unit} · Contract {group.contract}
            </p>
            <p>
              Capital model · {text(group.conditions.capital_model)} · Venue ·{" "}
              {text(group.conditions.venue)} · Instrument ·{" "}
              {text(group.conditions.instrument)}
            </p>
            <details>
              <summary>Comparison conditions and evidence</summary>
              <pre>
                {JSON.stringify(
                  {
                    conditions: group.conditions,
                    assessments: group.items.map((item) => ({
                      id: item.id,
                      label: item.label,
                      source_refs: item.sourceRefs,
                    })),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <details>
              <summary>
                Source values and references ({group.items.length})
              </summary>
              <div className="quant-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Assessment</th>
                      <th>Recorded delta</th>
                      <th>Supporting references</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item, index) => (
                      <tr key={`${item.id}:${index}`}>
                        <td>
                          {onSelect && item.id !== "Not recorded" ? (
                            <button
                              type="button"
                              className="quant-record-link"
                              onClick={() => onSelect(item.id)}
                            >
                              {item.label}
                            </button>
                          ) : (
                            <span>{item.label}</span>
                          )}
                          <small>{item.id}</small>
                        </td>
                        <td>
                          {String(item.value)} {group.unit}
                        </td>
                        <td>
                          <ComparisonReferences
                            references={item.sourceRefs}
                            onSelect={onSelect}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div
              style={{
                height: Math.max(200, group.items.length * 40),
                maxHeight: 500,
              }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={group.items}
                  layout="vertical"
                  margin={{ left: 12, right: 25 }}
                  accessibilityLayer
                >
                  <CartesianGrid
                    stroke="var(--chart-grid)"
                    horizontal={false}
                  />
                  <XAxis type="number" stroke="var(--color-text-muted)" />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={130}
                    stroke="var(--color-text-muted)"
                  />
                  <Tooltip contentStyle={tooltip} />
                  <ReferenceLine x={0} stroke="var(--color-text-muted)" />
                  <Bar
                    dataKey="value"
                    name={group.unit}
                    fill="var(--color-primary)"
                    maxBarSize={25}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}
        {excludedComparisons > 0 && (
          <p className="quant-muted">
            {excludedComparisons}{" "}
            {excludedComparisons === 1 ? "comparison is" : "comparisons are"}{" "}
            not plotted because admissibility fields are incomplete or
            incompatible.
          </p>
        )}
        {limitations.length > 0 && (
          <section aria-label="Source comparison limitations">
            <h3>Source comparison limitations</h3>
            <ul>
              {limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
          </section>
        )}
        {comparisons && groups.length === 0 ? (
          <p className="quant-muted">
            No admissible isolated baseline comparison is recorded for this
            selection.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ComparisonReferences({
  references,
  onSelect,
}: {
  references: unknown[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ul className="research-reference-list">
      {references.map((reference, index) => {
        const record = object(reference);
        const id =
          typeof reference === "string"
            ? reference
            : text(record.node_id, text(record.id, ""));
        const label = text(
          record.title,
          text(record.label, id || "Source reference"),
        );
        const url = safeSourceUrl(record.url);
        return (
          <li key={`${id}:${index}`}>
            {id && onSelect ? (
              <button type="button" onClick={() => onSelect(id)}>
                {label}
              </button>
            ) : url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
            {!id && !url && (
              <details>
                <summary>Recorded reference identity</summary>
                <pre>{JSON.stringify(reference, null, 2)}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
