import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw, Search, ArrowUpRight } from "lucide-react";
import { useServer } from "@/hooks/useServer";
import { authFetch } from "@/lib/auth-token";
import {
  object,
  text,
  records,
  catalogCount,
  researchSelectionMessage,
  researchReadState,
  type RecordData,
} from "@/features/research/model";
import "@/features/research/workspace.css";
import { readResearch as createResearchReader } from "@/features/research/read";
import { ResearchGraph } from "@/features/research/ResearchGraph";
import { ResearchResults } from "@/features/research/ResearchResults";

const readResearch = createResearchReader(authFetch);
function timestamp(value: unknown) {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "Not recorded";
}
function nodeTitle(node: RecordData) {
  return text(node.title, text(node.id));
}

export function Research() {
  const { server } = useServer();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const setSearch = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    next.delete("id");
    setParams(next, { replace: true });
  };
  const [query, setQuery] = useState(search);
  const [kind, setKind] = useState("idea");
  const [lane, setLane] = useState("");
  const [family, setFamily] = useState("");
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const overview = useQuery({
    queryKey: ["research-overview", server],
    enabled: !!server,
    queryFn: ({ signal }) => readResearch("overview", server!, {}, signal),
    refetchInterval: 30000,
    retry: 1,
  });
  const list = useQuery({
    queryKey: ["research-nodes", server, query, kind, lane, family, offset],
    enabled: !!server,
    queryFn: ({ signal }) =>
      readResearch(
        "nodes",
        server!,
        { q: query, kind, lane, family, offset: String(offset), limit: "20" },
        signal,
      ),
    refetchInterval: 30000,
    retry: 1,
  });
  const selected =
    params.get("id") ?? text(records(list.data?.data.items)[0]?.id, "");
  const detail = useQuery({
    queryKey: ["research-node", server, selected],
    enabled: !!server && !!selected,
    queryFn: ({ signal }) =>
      readResearch("node", server!, { id: selected }, signal),
    refetchInterval: 30000,
    retry: 1,
  });
  const graph = useQuery({
    queryKey: ["research-graph", server, selected],
    enabled: !!server && !!selected,
    queryFn: ({ signal }) =>
      readResearch("graph", server!, { id: selected, limit: "30" }, signal),
    refetchInterval: 30000,
    retry: 1,
  });
  const refresh = () => {
    void overview.refetch();
    void list.refetch();
    if (selected) {
      void detail.refetch();
      void graph.refetch();
      if (node.kind === "idea") void comparisons.refetch();
    }
  };
  const overviewState = researchReadState(
    overview.data,
    now,
    overview.isError,
    overview.dataUpdatedAt,
  );
  const listState = researchReadState(
    list.data,
    now,
    list.isError,
    list.dataUpdatedAt,
  );
  const data = overviewState === "available" ? object(overview.data?.data) : {};
  const freshness = object(data.freshness),
    counts = object(data.counts),
    facets = object(data.facets);
  const nodes = listState === "available" ? records(list.data?.data.items) : [];
  const total =
    listState === "available"
      ? catalogCount(object(list.data?.data), "total")
      : null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("id", id);
    else next.delete("id");
    setParams(next);
  };
  const detailState = researchReadState(
    detail.data,
    now,
    detail.isError,
    detail.dataUpdatedAt,
  );
  const detailAvailable = detailState === "available";
  const node = detailAvailable ? object(detail.data?.data.node) : {};
  const nodeData = object(node.data),
    usage = object(detail.data?.data.usage),
    source = object(node.source);
  const comparisons = useQuery({
    queryKey: ["research-comparisons", server, selected],
    enabled: !!server && node.kind === "idea",
    queryFn: ({ signal }) =>
      readResearch("comparisons", server!, { idea_id: selected }, signal),
    refetchInterval: 30000,
    retry: 1,
  });
  const graphState = researchReadState(
    graph.data,
    now,
    graph.isError,
    graph.dataUpdatedAt,
  );
  const graphAvailable = graphState === "available";
  const selectionMessage = researchSelectionMessage(selected, listState);
  const comparisonState = researchReadState(
    comparisons.data,
    now,
    comparisons.isError,
    comparisons.dataUpdatedAt,
  );
  const related = graphAvailable
    ? records(graph.data?.data.nodes).filter((n) => n.id !== selected)
    : [];
  const edges = graphAvailable ? records(graph.data?.data.edges) : [];
  const options = (key: string) =>
    (Array.isArray(facets[key]) ? facets[key] : []).filter(
      (v): v is string => typeof v === "string",
    );
  return (
    <div className="quant-workspace">
      <header className="quant-heading">
        <div>
          <h1>Research</h1>
          <p>Ideas, experiments and evidence from Research OS.</p>
        </div>
        <button
          onClick={refresh}
          disabled={!server || overview.isFetching || list.isFetching}
        >
          <RefreshCw
            size={15}
            className={overview.isFetching ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </header>
      {!server ? (
        <section className="quant-notice" role="status">
          Select a server to open its research workspace.{" "}
          <Link to="/settings">Open Settings</Link>
        </section>
      ) : (
        <>
          <div className="quant-source-strip">
            <span
              className={
                overviewState === "available" && freshness.state === "CURRENT"
                  ? "quant-positive"
                  : ""
              }
            >
              {overviewState === "available"
                ? `Index ${text(freshness.state, "unknown").toLowerCase()}`
                : `Research connection ${overviewState}`}
            </span>
            <span>Last index sync · {timestamp(freshness.last_sync)}</span>
            <span>Read-only source</span>
          </div>
          {overview.isError ? (
            <div className="quant-notice" role="alert">
              {overview.error.message}{" "}
              <button onClick={refresh}>Retry connection</button>
            </div>
          ) : null}
          <div className="quant-metrics" aria-label="Research catalog counts">
            {[
              ["ideas", "Ideas"],
              ["papers", "Papers"],
              ["experiments", "Experiments"],
              ["runs", "Attempts"],
            ].map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <strong>
                  {catalogCount(counts, key)?.toLocaleString() ?? "—"}
                </strong>
                <small>Catalog records</small>
              </div>
            ))}
          </div>
          <section className="quant-panel quant-graph-panel">
            <header className="quant-panel-heading">
              <div>
                <h2>Research network</h2>
                <p className="quant-muted">
                  Explore the selected idea and its recorded connections.
                </p>
              </div>
              <span>
                {!selected
                  ? "No record selected"
                  : graphAvailable
                    ? `${records(graph.data?.data.nodes).length} nodes in this view`
                    : `Research graph ${graphState}`}
              </span>
            </header>
            {selectionMessage ? (
              <div className="quant-notice" role="status">
                {selectionMessage}
              </div>
            ) : graphAvailable ? (
              <ResearchGraph
                data={object(graph.data?.data)}
                selectedId={selected}
                onSelect={select}
              />
            ) : (
              <div
                className="quant-notice"
                role={graph.isError ? "alert" : "status"}
              >
                {graph.isError
                  ? graph.error.message
                  : graphState === "stale"
                    ? "The research graph has not refreshed."
                    : "Loading research connections…"}
                {graph.isError || graphState === "stale" ? (
                  <button onClick={() => void graph.refetch()}>
                    Retry graph
                  </button>
                ) : null}
              </div>
            )}
          </section>
          {detailAvailable &&
          node.kind === "idea" &&
          comparisonState !== "available" ? (
            <div
              className="quant-notice"
              role={comparisons.isError ? "alert" : "status"}
            >
              {comparisons.isError
                ? comparisons.error.message
                : comparisonState === "stale"
                  ? "Comparison data has not refreshed; previous values are unavailable."
                  : "Loading baseline comparisons…"}
              {comparisons.isError || comparisonState === "stale" ? (
                <button onClick={() => void comparisons.refetch()}>
                  Retry comparisons
                </button>
              ) : null}
            </div>
          ) : null}
          {detailAvailable ? (
            <ResearchResults
              data={nodeData}
              comparisons={
                node.kind === "idea" && comparisonState === "available"
                  ? comparisons.data?.data
                  : undefined
              }
            />
          ) : null}
          <div className="quant-research-layout">
            <section className="quant-panel">
              <header className="quant-panel-heading">
                <h2>Knowledge library</h2>
                <span>
                  {total === null
                    ? "Waiting for source"
                    : `${total.toLocaleString()} matching records`}
                </span>
              </header>
              <div className="quant-filters">
                <label className="quant-search">
                  <Search size={16} />
                  <input
                    aria-label="Search research"
                    placeholder="Search ideas, hypotheses, evidence…"
                    value={search}
                    maxLength={200}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <label>
                  Type
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All records</option>
                    {(options("kinds").length
                      ? options("kinds")
                      : [
                          "idea",
                          "paper",
                          "experiment",
                          "run",
                          "assessment",
                          "decision",
                        ]
                    ).map((v) => (
                      <option key={v} value={v}>
                        {v.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Lane
                  <select
                    value={lane}
                    onChange={(e) => {
                      setLane(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All lanes</option>
                    {options("lanes").map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Family
                  <select
                    value={family}
                    onChange={(e) => {
                      setFamily(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All families</option>
                    {options("families").map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
              {listState !== "available" ? (
                <div
                  className="quant-notice"
                  role={list.isError ? "alert" : "status"}
                >
                  {list.isError
                    ? list.error.message
                    : listState === "stale"
                      ? "The research connection has not refreshed. Retry to load current catalog records."
                      : "Loading knowledge records…"}
                  {list.isError || listState === "stale" ? (
                    <button onClick={() => void list.refetch()}>
                      Retry records
                    </button>
                  ) : null}
                </div>
              ) : nodes.length === 0 ? (
                <div className="quant-notice" role="status">
                  No records match these filters.
                </div>
              ) : (
                <div className="quant-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Record</th>
                        <th>Lane</th>
                        <th>Recorded status</th>
                        <th>Recorded date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((n) => (
                        <tr key={text(n.id)} aria-selected={n.id === selected}>
                          <td>
                            <button
                              className="quant-record-link"
                              onClick={() => select(text(n.id, ""))}
                            >
                              {nodeTitle(n)}
                            </button>
                            <small>
                              {text(n.kind)} · {text(n.family, "No family")}
                            </small>
                          </td>
                          <td>{text(n.lane)}</td>
                          <td>{text(n.status)}</td>
                          <td>
                            {timestamp(n.recorded_at)}
                            {Date.parse(text(n.recorded_at, "")) >
                            now + 300000 ? (
                              <small>Future-dated source</small>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <footer className="quant-pagination">
                <span>
                  {total === null
                    ? ""
                    : `${total === 0 ? 0 : offset + 1}–${Math.min(offset + 20, total)} of ${total.toLocaleString()}`}
                </span>
                <button
                  onClick={() => setOffset(Math.max(0, offset - 20))}
                  disabled={offset === 0 || list.isFetching}
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset(offset + 20)}
                  disabled={
                    total === null ||
                    offset + 20 >= total ||
                    offset >= 9980 ||
                    list.isFetching
                  }
                >
                  Next
                </button>
              </footer>
            </section>
            {selected ? (
              <aside
                className="quant-panel quant-inspector"
                aria-label="Research record detail"
              >
                <header className="quant-panel-heading">
                  <h2>Evidence detail</h2>
                </header>
                {!detailAvailable ? (
                  <div
                    className="quant-notice"
                    role={detail.isError ? "alert" : "status"}
                  >
                    {detail.isError
                      ? detail.error.message
                      : detailState === "stale"
                        ? "The record has not refreshed; previous details are unavailable."
                        : "Loading record…"}
                    {detail.isError || detailState === "stale" ? (
                      <button onClick={() => void detail.refetch()}>
                        Retry detail
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="quant-detail-body">
                    <p className="quant-record-kind">
                      {text(node.kind)} · {text(node.lane)}
                    </p>
                    <h3>{nodeTitle(node)}</h3>
                    <p>
                      Recorded status · <strong>{text(node.status)}</strong>
                    </p>
                    <p className="quant-muted">
                      Source date · {timestamp(node.recorded_at)}
                    </p>
                    {[
                      "hypothesis",
                      "mechanism",
                      "baseline",
                      "falsification",
                      "rationale",
                      "verdict",
                      "identity_state",
                    ]
                      .filter((key) => typeof nodeData[key] === "string")
                      .map((key) => (
                        <section key={key}>
                          <h4>{key.replaceAll("_", " ")}</h4>
                          <p>{text(nodeData[key])}</p>
                        </section>
                      ))}
                    {Object.keys(usage).length ? (
                      <section>
                        <h4>Recorded evaluations</h4>
                        <p>
                          {catalogCount(usage, "experiments") ?? "—"} linked
                          experiments · {catalogCount(usage, "attempts") ?? "—"}{" "}
                          attempts
                        </p>
                        <p>
                          {text(
                            usage.independent_evaluation_note,
                            "Linked activity alone does not establish economic support.",
                          )}
                        </p>
                      </section>
                    ) : null}
                    <section>
                      <h4>Evidence connections</h4>
                      {!graphAvailable ? (
                        <p>
                          {graph.isError
                            ? graph.error.message
                            : graphState === "stale"
                              ? "The research graph has not refreshed."
                              : "Loading connections…"}
                        </p>
                      ) : related.length === 0 ? (
                        <p>No connected records in this source graph view.</p>
                      ) : (
                        <ul className="quant-related">
                          {related.map((n) => (
                            <li key={text(n.id)}>
                              <button onClick={() => select(text(n.id, ""))}>
                                {nodeTitle(n)}
                                <ArrowUpRight size={13} />
                              </button>
                              <small>
                                {text(n.kind)} · {text(n.status)}
                              </small>
                            </li>
                          ))}
                        </ul>
                      )}
                      <small>
                        {graphAvailable
                          ? `${edges.length} recorded edges in this bounded view${graph.data?.data.truncated ? " · More connections exist" : ""}`
                          : ""}
                      </small>
                    </section>
                    <details>
                      <summary>Source identity and native fields</summary>
                      <dl>
                        <dt>Record</dt>
                        <dd>{text(node.id)}</dd>
                        <dt>Origin</dt>
                        <dd>{text(source.origin)}</dd>
                        <dt>Source hash</dt>
                        <dd>
                          {text(source.sha256, text(source.event_sha256))}
                        </dd>
                      </dl>
                      <pre>
                        {JSON.stringify(nodeData, null, 2).slice(0, 20000)}
                      </pre>
                    </details>
                  </div>
                )}
              </aside>
            ) : (
              <aside className="quant-panel quant-inspector">
                <div className="quant-detail-body">
                  <h2>Read the evidence</h2>
                  <p>
                    Select a record to inspect its hypothesis, source identity
                    and linked research.
                  </p>
                  <hr />
                  <h3>Keep the comparison valid</h3>
                  <p>
                    Spot, futures and proxy lanes retain their own accounting.
                    Catalog counts include imported history; they are not
                    validated strategies or independent tests.
                  </p>
                  <p>
                    Recorded status and paper claims are separate from
                    reproduced results and trading permission.
                  </p>
                  <Link to="/">
                    Return to operations <ArrowUpRight size={14} />
                  </Link>
                </div>
              </aside>
            )}
          </div>
          <details className="quant-panel quant-source-detail">
            <summary>Index provenance and limitations</summary>
            <p>Projection generated · {timestamp(data.generated_at)}</p>
            <p>
              Pending events ·{" "}
              {catalogCount(freshness, "pending_events") ?? "—"}
            </p>
            <p>Snapshot · {text(data.source_snapshot)}</p>
            <p>Revision · {text(data.revision)}</p>
            <ul>
              {(Array.isArray(data.limitations) ? data.limitations : [])
                .filter((v): v is string => typeof v === "string")
                .map((v) => (
                  <li key={v}>{v}</li>
                ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
