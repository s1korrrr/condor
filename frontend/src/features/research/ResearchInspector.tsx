import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, X } from "lucide-react";
import { authFetch } from "@/lib/auth-token";
import {
  object,
  records,
  text,
  researchReadState,
  type RecordData,
} from "./model";
import { readResearch as createReader } from "./read";
import { ResearchResults } from "./ResearchResults";
import { sourceResultBars } from "./results";
import { ResearchDocuments } from "./ResearchDocument";
import {
  metricValue,
  safeSourceUrl,
  researchLabel,
  displayResearchValue,
} from "./research-detail";
import "./research-detail.css";

const readResearch = createReader(authFetch);
function count(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value.toLocaleString()
    : "UNAVAILABLE";
}
export function RawResearchData({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const serialized = useMemo(
    () => (expanded ? JSON.stringify(value ?? null, null, 2) : null),
    [expanded, value],
  );
  return (
    <details
      className="research-raw"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {expanded && <pre>{serialized}</pre>}
    </details>
  );
}
export function ResearchMetadata({ values }: { values: RecordData }) {
  return (
    <dl className="research-metadata">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} style={{ display: "contents" }}>
          <dt>{researchLabel(key)}</dt>
          <dd>{displayResearchValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
export function ResearchReferences({
  references,
  onSelect,
}: {
  references: unknown;
  onSelect: (id: string) => void;
}) {
  const refs = Array.isArray(references) ? references : [];
  return refs.length ? (
    <ul className="research-reference-list">
      {refs.map((reference, i) => {
        const r = object(reference);
        const id =
          typeof reference === "string"
            ? reference
            : text(r.node_id, text(r.id, ""));
        const url = safeSourceUrl(r.url);
        return (
          <li key={`${id}:${i}`}>
            {id ? (
              <button type="button" onClick={() => onSelect(id)}>
                {text(r.title, text(r.label, id))}
              </button>
            ) : url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {text(r.label, "Source URL")}
              </a>
            ) : (
              <>
                <span>
                  {text(r.label, text(r.pointer, "Source reference"))}
                </span>
                <RawResearchData title="Reference identity" value={reference} />
              </>
            )}
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="quant-muted">No supporting references were recorded.</p>
  );
}
export function ResearchRecommendations({
  items,
  onSelect,
}: {
  items: unknown;
  onSelect: (id: string) => void;
}) {
  const suggestions = records(items);
  return suggestions.length ? (
    <ul className="research-recommendations">
      {suggestions.map((item, index) => {
        const id = text(item.node_id, text(item.idea_id, ""));
        return (
          <li key={`${id}:${index}`}>
            <h4>{text(item.title, "Recorded next test")}</h4>
            {item.priority != null && (
              <small className="quant-muted">
                {displayResearchValue(item.priority)}
              </small>
            )}
            <p>{text(item.reason, "Reason unavailable.")}</p>
            {id && (
              <button type="button" onClick={() => onSelect(id)}>
                {text(item.idea_title, id)}
              </button>
            )}
            {Array.isArray(item.evidence_refs) &&
              item.evidence_refs.length > 0 && (
                <details>
                  <summary>Supporting references</summary>
                  <ResearchReferences
                    references={item.evidence_refs}
                    onSelect={onSelect}
                  />
                </details>
              )}
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="quant-muted">
      No grounded suggestion is available. Suggestions require a recorded
      evidence gap and reason.
    </p>
  );
}
function ResearchUsage({ usage }: { usage: RecordData }) {
  return (
    <section>
      <h4>Idea usage and evaluations</h4>
      <div className="research-usage">
        {[
          ["experiments", "Distinct experiments"],
          ["attempts", "Recorded attempts"],
          ["valid_evaluations", "Valid evaluations"],
        ].map(([key, label]) => (
          <div key={key}>
            <strong>{count(usage[key])}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <h4>Valid and isolated</h4>
      <div className="research-evaluation-counts">
        {["SUPPORTED", "CONTRADICTED", "INCONCLUSIVE"].map((verdict) => (
          <span key={verdict}>
            {researchLabel(verdict.toLowerCase())}
            <strong>{count(object(usage.valid_isolated)[verdict])}</strong>
          </span>
        ))}
      </div>
      <p>
        Counts refer to declared evaluation identities; they are not a
        profitability or promotion score.
      </p>
      <ResearchMetadata
        values={{
          combined_attribution: usage.combined,
          unavailable_attribution: usage.unavailable,
        }}
      />
      {typeof usage.independent_evaluation_note === "string" && (
        <p>{usage.independent_evaluation_note}</p>
      )}
      {usage.attempt_states != null && (
        <RawResearchData
          title="Attempt outcomes"
          value={usage.attempt_states}
        />
      )}
    </section>
  );
}
function ResearchLearning({
  data,
  onSelect,
}: {
  data: RecordData;
  onSelect: (id: string) => void;
}) {
  const supervisor = data.schema === "research_knowledge.supervisor.v1";
  const mandate = object(data.mandate),
    budget = object(mandate.budget),
    scope = object(data.scope),
    window = object(scope.window);
  const trials = records(data.trials);
  return (
    <section>
      <h4>
        {supervisor
          ? "Supervised research"
          : data.schema === "research_knowledge.outcome.v1"
            ? "Recorded outcome"
            : "Scoped lesson"}
      </h4>
      {supervisor ? (
        <>
          <ResearchMetadata
            values={{
              program: mandate.program_id,
              stage: data.stage,
              trials: `${Array.isArray(data.trials) ? trials.length : "UNAVAILABLE"} / ${displayResearchValue(budget.max_trials)}`,
              agent_actions: `${displayResearchValue(data.agent_actions)} / ${displayResearchValue(budget.max_agent_actions)}`,
              authority: mandate.authority,
              promotion: data.promotion,
            }}
          />
          {typeof data.reason === "string" && <p>{data.reason}</p>}
          <p>
            The local supervisor determines the next action. This view reports
            its recorded state.
          </p>
          {Array.isArray(object(data.program).blockers) && (
            <ul>
              {(object(data.program).blockers as unknown[]).map(
                (blocker, i) => (
                  <li key={i}>{displayResearchValue(blocker)}</li>
                ),
              )}
            </ul>
          )}
          {trials.map((trial, i) => (
            <section
              className="research-trial"
              key={text(trial.idea_revision_id, String(i))}
            >
              <h4>
                Trial {i + 1}: {text(object(trial.idea).title)}
              </h4>
              <ResearchReferences
                onSelect={onSelect}
                references={[
                  ...(trial.idea_revision_id
                    ? [
                        {
                          node_id: trial.idea_revision_id,
                          title: "Idea revision",
                        },
                      ]
                    : []),
                  ...(trial.outcome_id
                    ? [{ node_id: trial.outcome_id, title: "Recorded outcome" }]
                    : []),
                  ...(Array.isArray(trial.lesson_ids)
                    ? trial.lesson_ids.map((id) => ({
                        node_id: id,
                        title: "Retained lesson",
                      }))
                    : []),
                ]}
              />
              {trial.scorecard != null && (
                <ResearchMetadata
                  values={{
                    process: object(trial.scorecard).process_status,
                    historical_result: object(trial.scorecard)
                      .historical_result,
                    owner_comparison:
                      object(trial.owner_comparison).verdict ??
                      object(trial.owner_comparison).status,
                  }}
                />
              )}
            </section>
          ))}
        </>
      ) : (
        <>
          <p>{text(data.statement, text(data.rationale))}</p>
          <ResearchMetadata
            values={{
              program: data.program_id,
              evidence: data.evidence_state,
              domain: data.domain ?? data.failure_domain,
              ...(data.outcome
                ? { outcome: data.outcome, backtest: data.backtest_state }
                : { confidence: data.confidence }),
              venue: scope.venue,
              capital_model: scope.capital_model,
              window: Object.keys(window).length
                ? `${displayResearchValue(window.start)} to ${displayResearchValue(window.end_exclusive)} (end exclusive)`
                : null,
              regimes: scope.regimes,
            }}
          />
          {typeof data.reopening_condition === "string" && (
            <p>
              <strong>Reopen when:</strong> {data.reopening_condition}
            </p>
          )}
          <ResearchReferences
            onSelect={onSelect}
            references={
              data.outcome_ids ??
              (data.idea_revision_id ? [data.idea_revision_id] : [])
            }
          />
          {Array.isArray(data.sources) && data.sources.length > 0 && (
            <RawResearchData
              title="Recorded evidence source identities"
              value={data.sources}
            />
          )}
          {data.supersedes != null && (
            <>
              <h4>Supersedes</h4>
              <ResearchReferences
                onSelect={onSelect}
                references={[data.supersedes]}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
function ResearchScorecard({ score }: { score: RecordData }) {
  const owner = object(score.owner_scorecard),
    metrics = Object.entries(object(score.metrics));
  return (
    <section>
      <h4>Research scorecard</h4>
      <ResearchMetadata
        values={{
          process: score.process_status,
          historical_result:
            owner.owner_evidence_status ?? score.historical_result,
          owner_baseline_comparison: score.owner_baseline_comparison,
          all_weather: score.all_weather,
          promotion: score.promotion,
        }}
      />
      {metrics.length ? (
        <div className="quant-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Recorded value</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([name, metric]) => (
                <tr key={name}>
                  <td>{researchLabel(name)}</td>
                  <td>{metricValue(metric)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No validated economic metrics are available for this attempt.</p>
      )}
      {owner.passive_baseline != null && (
        <p>
          Passive baseline is an uncosted reference, not the RSI controller
          baseline.
        </p>
      )}
      {typeof owner.activity_definition === "string" && (
        <p>{owner.activity_definition}</p>
      )}
      {typeof score.evidence_error === "string" && (
        <p role="alert" className="research-read-error">
          {score.evidence_error}
        </p>
      )}
      {Array.isArray(owner.limitations ?? score.limitations) && (
        <ul>
          {((owner.limitations ?? score.limitations) as unknown[]).map(
            (limit, i) => (
              <li key={i}>{displayResearchValue(limit)}</li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
export interface ResearchInspectorProps {
  server: string;
  id: string;
  onSelect: (id: string) => void;
  onFindInNetwork: (id: string) => void;
  onArchiveRecord: (id: string) => void;
}
export function ResearchInspector({
  server,
  id,
  onSelect,
  onFindInNetwork,
  onArchiveRecord,
}: ResearchInspectorProps) {
  const panel = useRef<HTMLElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const detail = useQuery({
    queryKey: ["research-node", server, id],
    queryFn: ({ signal }) => readResearch("node", server, { id }, signal),
    enabled: !!server && !!id,
    refetchInterval: 30000,
    retry: 1,
  });
  const state = researchReadState(
    detail.data,
    now,
    detail.isError,
    detail.dataUpdatedAt,
  );
  const available = state === "available";
  const response = available ? object(detail.data?.data) : {},
    node = object(response.node),
    data = object(node.data),
    source = object(node.source);
  const isIdea = node.kind === "idea" || node.kind === "idea_revision";
  const comparisons = useQuery({
    queryKey: ["research-comparisons", server, id, response.revision],
    queryFn: ({ signal }) =>
      readResearch("comparisons", server, { idea_id: id }, signal),
    enabled: !!server && isIdea,
    refetchInterval: 30000,
    retry: 1,
  });
  const comparisonState = researchReadState(
    comparisons.data,
    now,
    comparisons.isError,
    comparisons.dataUpdatedAt,
  );
  useEffect(() => {
    if (available && window.matchMedia("(max-width: 1000px)").matches)
      panel.current?.focus({ preventScroll: true });
  }, [id, available]);
  const comparisonMismatch =
    comparisonState === "available" &&
    response.revision !== comparisons.data?.data.revision;
  const context =
    data.statement ||
    data.rationale ||
    object(data.mandate).objective ||
    data.hypothesis ||
    data.summary ||
    data.description ||
    data.mechanism;
  const related = records(response.related),
    edges = records(response.edges);
  const external = safeSourceUrl(source.url);
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="quant-panel quant-inspector research-inspector"
      aria-label="Research record detail"
    >
      <header className="quant-panel-heading">
        <h2>Evidence detail</h2>
        <button
          type="button"
          onClick={() => onSelect("")}
          aria-label="Close evidence detail"
        >
          <X size={15} />
        </button>
      </header>
      {!available ? (
        <div
          className="quant-notice"
          role={detail.isError ? "alert" : "status"}
        >
          {detail.isError
            ? detail.error.message
            : state === "stale"
              ? "The record has not refreshed. Previous details are unavailable."
              : "Loading record…"}
          {(detail.isError || state === "stale") && (
            <button type="button" onClick={() => void detail.refetch()}>
              Retry detail
            </button>
          )}
        </div>
      ) : (
        <div className="quant-detail-body">
          <p className="quant-record-kind">
            {text(node.kind)} · {text(node.lane)}
          </p>
          <h3>{text(node.title, id)}</h3>
          <ResearchMetadata
            values={{
              kind: node.kind,
              family: node.family,
              lane: node.lane,
              recorded_status: node.status,
              recorded_at: node.recorded_at,
            }}
          />
          {context != null && context !== "" && (
            <section>
              <h4>Context</h4>
              <p>{displayResearchValue(context)}</p>
            </section>
          )}
          {[
            "hypothesis",
            "mechanism",
            "baseline",
            "falsification",
            "rationale",
            "verdict",
            "identity_state",
          ]
            .filter(
              (key) => typeof data[key] === "string" && data[key] !== context,
            )
            .map((key) => (
              <section key={key}>
                <h4>{researchLabel(key)}</h4>
                <p>{text(data[key])}</p>
              </section>
            ))}
          {isIdea && <ResearchUsage usage={object(response.usage)} />}
          {[
            "research_knowledge.supervisor.v1",
            "research_knowledge.outcome.v1",
            "research_knowledge.scoped_lesson.v1",
          ].includes(text(data.schema, "")) && (
            <ResearchLearning data={data} onSelect={onSelect} />
          )}
          {data.schema === "research_knowledge.campaign_scorecard.v1" && (
            <ResearchScorecard score={data} />
          )}
          <section>
            <h4>Recorded history</h4>
            {related.length ? (
              <ul className="research-history">
                {related.map((item) => (
                  <li key={text(item.id)}>
                    <button
                      type="button"
                      onClick={() => onSelect(text(item.id, ""))}
                    >
                      {text(item.title, text(item.id))}
                    </button>
                    <small>
                      {text(item.kind)} ·{" "}
                      {edges
                        .filter(
                          (edge) =>
                            edge.source === item.id || edge.target === item.id,
                        )
                        .map(
                          (edge) =>
                            `${text(edge.relation).replaceAll("_", " ")} · ${text(edge.basis, "basis unavailable")}`,
                        )
                        .join("; ") || "relation unavailable"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No linked history is recorded for this node.</p>
            )}
          </section>
          {isIdea && (comparisonState !== "available" || comparisonMismatch) ? (
            <div
              className="quant-notice"
              role={comparisons.isError ? "alert" : "status"}
            >
              {comparisonMismatch
                ? "Comparison evidence belongs to a different graph revision. Refresh comparisons before using it."
                : comparisons.isError
                  ? comparisons.error.message
                  : comparisonState === "stale"
                    ? "Comparison data has not refreshed. Previous values are unavailable."
                    : "Loading baseline comparisons…"}
              {(comparisons.isError ||
                comparisonState === "stale" ||
                comparisonMismatch) && (
                <button
                  type="button"
                  onClick={() => void comparisons.refetch()}
                >
                  Retry comparisons
                </button>
              )}
            </div>
          ) : isIdea || sourceResultBars(data).length > 0 ? (
            <ResearchResults
              data={data}
              comparisons={isIdea ? comparisons.data?.data : undefined}
              onSelect={onSelect}
            />
          ) : null}
          {isIdea && comparisonState === "available" && !comparisonMismatch && (
            <RawResearchData
              title="Complete comparison evidence and limitations"
              value={comparisons.data?.data}
            />
          )}
          <section>
            <h4>Next test suggestions</h4>
            <ResearchRecommendations
              items={response.recommendations}
              onSelect={onSelect}
            />
          </section>
          <ResearchDocuments
            key={`${server}:${id}:${text(response.revision, "")}`}
            server={server}
            scope="node"
            id={id}
            documents={response.documents}
          />
          <section>
            <h4>Source and provenance</h4>
            {external && (
              <p>
                <a href={external} target="_blank" rel="noopener noreferrer">
                  Source URL
                </a>
              </p>
            )}
            {typeof source.record_id === "string" && (
              <button
                type="button"
                onClick={() => onArchiveRecord(source.record_id as string)}
              >
                Open archival record
              </button>
            )}
            <ResearchMetadata
              values={{
                node_id: node.id,
                origin: source.origin,
                source_hash: source.sha256 ?? source.event_sha256,
                source_pointer: source.pointer,
                revision: response.revision,
              }}
            />
            <RawResearchData title="Full graph node" value={node} />
            <RawResearchData
              title="Recorded relations and provenance"
              value={edges}
            />
          </section>
          <button type="button" onClick={() => onFindInNetwork(id)}>
            <Network size={15} />
            Find in research network
          </button>
        </div>
      )}
    </aside>
  );
}
