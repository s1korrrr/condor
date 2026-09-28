import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Pause,
  Play,
  Search,
  Settings2,
  Share2,
  Star,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useServer } from "@/hooks/useServer";
import { api } from "@/lib/api";
import {
  ageState,
  csvCell,
  downloadFile,
  parseView,
  nativeViewSearch,
  viewQuery,
} from "./model.mjs";
import { canonical, digest } from "./contract.mjs";
import { useMarketPicture } from "./useMarketPicture";
import { boundedJson, projectEvents, type FrameBundle } from "./source";
import {
  type DisplayAsset,
  type DisplayEvent,
  type DisplayFrame,
  type ViewSettings,
} from "./presentation";
import { MarketPulsePanel, MarketSummaryStrip } from "./MarketPulse";
import {
  CorrelationMatrix,
  CorrelationsPanel,
  LeadersLaggardsPanel,
  RegimeOverviewPanel,
} from "./AssetPanels";
import {
  MarketHeatmapPanel,
  ParticipationPanel,
  ReturnDistributionPanel,
} from "./OverviewPanels";
import {
  AssetInspector,
  CoverageProvenance,
  Drawer,
  MarketEventFeed,
} from "./DetailViews";
import { Empty } from "./Primitives";
import "./market-picture.css";

const CanonicalContext = lazy(() =>
  import("@/features/screener/CanonicalContext").then((m) => ({
    default: m.CanonicalContext,
  })),
);
const NativeTools = lazy(() =>
  import("@/features/screener/NativeScreenerTools").then((m) => ({
    default: m.Screener,
  })),
);
type DrawerName =
  "asset" | "coverage" | "matrix" | "settings" | "tools" | "export" | null;
interface Preferences {
  universe: string | null;
  watchlist: string[];
  notes: Record<string, string>;
  views: Array<{ name: string; view: ViewSettings }>;
}
const EMPTY_PREFS: Preferences = {
  universe: null,
  watchlist: [],
  notes: {},
  views: [],
};
function loadPreferences(key: string): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      !value ||
      !Array.isArray(value.watchlist) ||
      value.watchlist.length > 300 ||
      !Array.isArray(value.views) ||
      value.views.length > 20 ||
      typeof value.notes !== "object" ||
      !value.notes
    )
      return EMPTY_PREFS;
    return {
      universe: typeof value.universe === "string" ? value.universe : null,
      watchlist: value.watchlist.filter(
        (v: unknown) =>
          typeof v === "string" && /^okx:spot:[A-Z0-9]+-[A-Z0-9]+$/.test(v),
      ),
      notes: Object.fromEntries(
        Object.entries(value.notes)
          .filter(
            ([key, v]) =>
              /^okx:spot:[A-Z0-9]+-[A-Z0-9]+$/.test(key) &&
              typeof v === "string" &&
              v.length <= 2000,
          )
          .map(([key, v]) => [key, String(v)]),
      ),
      views: value.views
        .filter(
          (v: { name?: unknown; view?: unknown }) =>
            typeof v.name === "string" && v.name.length <= 60 && v.view,
        )
        .map((v: { name: string; view: ViewSettings }) => ({
          name: v.name,
          view: parseView(viewQuery(v.view)),
        })),
    };
  } catch {
    return EMPTY_PREFS;
  }
}
function predicateMembers(assets: DisplayAsset[], key: string) {
  return assets
    .filter((a) => a.predicates[key]?.value === 1)
    .map((a) => a.instrument_id);
}

export function MarketPicture() {
  const { server } = useServer();
  const { user } = useAuth();
  return (
    <MarketPictureSurface
      key={`${user?.id ?? "anonymous"}:${server ?? "none"}`}
      server={server}
      userId={String(user?.id ?? "anonymous")}
    />
  );
}

/** Explicit fixture injection is only used by the isolated test entry, never source selection. */
export function MarketPictureSurface({
  server,
  userId,
  fixture,
}: {
  server: string | null;
  userId: string;
  fixture?: FrameBundle;
}) {
  const [view, setView] = useState<ViewSettings>(() =>
    parseView(location.search),
  );
  const [search, setSearch] = useState(""),
    [drawer, setDrawer] = useState<DrawerName>(() => nativeViewSearch(location.search) ? "tools" : null);
  const [nativeSearch, setNativeSearch] = useState(() => nativeViewSearch(location.search));
  const [cohort, setCohort] = useState<string[]>([]),
    [cohortLabel, setCohortLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null),
    [viewName, setViewName] = useState("");
  const [additionalEvents, setAdditionalEvents] = useState<{
    snapshot: string;
    events: DisplayEvent[];
    cursor: string | null;
  } | null>(null);
  const eventAbort = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => eventAbort.current?.abort(), []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !document.querySelector("dialog[open]") &&
        !target?.closest("input,textarea,[contenteditable=true]")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const [busy, setBusy] = useState(false),
    [resumeAfterTools, setResumeAfterTools] = useState(false);
  const source = useMarketPicture(server, view.window, view.benchmark, fixture);
  const data = source.data,
    frame = data?.frame ?? null;
  const state = ageState(frame, Date.now(), source.frozen);
  const selected =
    frame?.assets.find((a) => a.instrument_id === view.selected) ?? null;
  const preferencesKey = `condor.market-picture.v1:${encodeURIComponent(userId)}:${encodeURIComponent(server ?? "none")}:${encodeURIComponent(frame?.universeId ?? "pending")}`;
  const storedPreferences = useMemo(() => loadPreferences(preferencesKey), [preferencesKey]);
  const [preferences, setPreferences] = useState<{key: string; value: Preferences} | null>(null);
  const scopedPreferences = preferences?.key === preferencesKey ? preferences.value : storedPreferences;
  const cohortSet = new Set(cohort);
  const set = (patch: Partial<ViewSettings>) =>
    setView((v) => ({ ...v, ...patch }));
  const select = (id: string) => {
    set({ selected: id });
    setDrawer("asset");
  };
  const highlight = (ids: string[], label: string) => {
    setCohort(ids);
    setCohortLabel(label);
  };
  const savePreferences = (patch: Partial<Preferences>) => {
    const next = {
      ...scopedPreferences,
      ...patch,
      universe: frame?.universeId ?? null,
    };
    setPreferences({key: preferencesKey, value: next});
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(next));
    } catch {
      setMessage(
        "Browser storage is unavailable. Changes remain in this session.",
      );
    }
  };
  const closeDrawer = () => {
    setDrawer(null);
    if (resumeAfterTools) {
      source.toggleFreeze();
      setResumeAfterTools(false);
    }
  };
  const openTools = () => {
    if (frame && !source.frozen) {
      source.toggleFreeze();
      setResumeAfterTools(true);
    }
    setDrawer("tools");
  };
  const exportContext = async () => {
    if (!data) return;
    const packet = {
      schema_version: "market-picture-research-export.v1",
      frame: data.frame.raw,
      components: data.components,
      selected_view: view,
      selected_cohort: cohort,
      full_universe_count: data.frame.expected,
      source_server: server,
      exported_at_ms: Date.now(),
      mode: state.mode,
      component_faults: data.faults,
    };
    const checksum = await digest(packet);
    downloadFile(
      `market-picture-${data.frame.snapshot_id.slice(0, 12)}.json`,
      "application/json",
      canonical({ ...packet, export_digest: checksum }),
    );
    setMessage(
      "Exported this immutable frame, stored components and view provenance.",
    );
  };
  const exportCsv = () => {
    if (!frame) return;
    const rows = [
      [
        "instrument_id",
        "price_quote",
        "return_24h_percent",
        "return_7d_percent",
        "snapshot_id",
        "source_kind",
      ],
      ...frame.assets.map((a) => [
        a.instrument_id,
        a.price.original,
        a.returns["1440"].original,
        a.returns["10080"].original,
        frame.snapshot_id,
        frame.source_kind,
      ]),
    ];
    downloadFile(
      `market-picture-${frame.snapshot_id.slice(0, 12)}.csv`,
      "text/csv;charset=utf-8",
      rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
    );
  };
  const share = async () => {
    const url = `${location.origin}${location.pathname}${viewQuery(view)}`;
    try {
      await navigator.clipboard.writeText(url);
      setMessage(
        "View link copied. Recipients use their own authorized source.",
      );
    } catch {
      setMessage(`View link: ${url}`);
    }
  };
  const loadEvents = async () => {
    if (!server || !frame || !data || busy) return;
    const cursor =
      additionalEvents?.snapshot === frame.snapshot_id
        ? additionalEvents.cursor
        : data.eventCursor;
    if (!cursor) return;
    setBusy(true);
    eventAbort.current?.abort();
    const controller = new AbortController();
    eventAbort.current = controller;
    try {
      const payload = await boundedJson(
        await api.getMarketPicture(
          server,
          "events",
          { snapshot_id: frame.snapshot_id, cursor, limit: "50" },
          AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        ),
      );
      if (controller.signal.aborted) return;
      const next = projectEvents(payload, frame);
      setAdditionalEvents((previous) => ({
        snapshot: frame.snapshot_id,
        events: [
          ...(previous?.snapshot === frame.snapshot_id ? previous.events : []),
          ...next,
        ].slice(-500),
        cursor:
          typeof payload.next_cursor === "string" ? payload.next_cursor : null,
      }));
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Earlier event history unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  const extra =
    additionalEvents?.snapshot === frame?.snapshot_id ? additionalEvents : null;
  const events = [
    ...new Map(
      [...(data?.events ?? []), ...(extra?.events ?? [])].map((e) => [
        e.event_id,
        e,
      ]),
    ).values(),
  ];
  const common = { frame, selected: view.selected, select, cohort: cohortSet };
  return (
    <div
      className="mp-page"
      data-frozen={source.frozen || undefined}
      data-mode={state.mode}
    >
      <header className="mp-header">
        <div className="mp-brand">
          <span className="mp-version">V3</span>
          <div>
            <h1>Market Picture</h1>
            <span>Whole market. A clearer view.</span>
          </div>
        </div>
        <nav aria-label="Market Picture sections">
          <a href="#mp-pulse" className="mp-command-link">
            Command center
          </a>
          <a href="#mp-regimes">Regimes</a>
          <a href="#mp-correlations">Correlations</a>
          <a href="#mp-heatmap">Heatmap</a>
          <a href="#mp-feed">Alerts</a>
          <button onClick={() => setDrawer("coverage")}>Research</button>
        </nav>
        <label className="mp-search">
          <Search size={14} />
          <input
            ref={searchInput}
            aria-label="Search market symbols"
            value={search}
            onChange={(e) => setSearch(e.target.value.slice(0, 60))}
            placeholder="Search symbol…"
          />
          <kbd>/</kbd>
        </label>
        <SourceStatus frame={frame} frozen={source.frozen} loading={source.loading} server={server} fixtureTime={fixture?.frame.available_at_ms} />
        <button
          className="mp-icon-button"
          aria-label="Market Picture settings"
          onClick={() => setDrawer("settings")}
        >
          <Settings2 size={18} />
        </button>
      </header>
      <div className="mp-view-toolbar">
        <div>
          <span className="mp-source-label">{server ?? "No source"}</span>
          {frame && (
            <span>
              {frame.universeRevision} · frame {frame.sequence}
            </span>
          )}
          {fixture && <span className="mp-warning">Synthetic fixture</span>}
          {frame?.source_kind === "reconstructed" && !fixture && (
            <span className="mp-warning">Reconstructed observations</span>
          )}
          {cohort.length > 0 && (
            <button
              className="mp-cohort-chip"
              onClick={() => highlight([], "")}
            >
              {cohort.length} highlighted · {cohortLabel}
              <X size={12} />
            </button>
          )}
        </div>
        <div>
          <button disabled={!frame} onClick={source.toggleFreeze}>
            {source.frozen ? <Play size={13} /> : <Pause size={13} />}
            {source.frozen ? "Resume" : "Freeze"}
          </button>
          <button onClick={share}>
            <Share2 size={13} /> Share view
          </button>
          <button disabled={!frame} onClick={() => setDrawer("export")}>
            <Download size={13} /> Export
          </button>
          <button onClick={openTools}>Screener tools ↗</button>
          <button id="mp-coverage-button" onClick={() => setDrawer("coverage")}>
            Coverage & sources
          </button>
        </div>
      </div>
      {(source.error || message) && (
        <div className="mp-notice" role="status">
          <span>
            {source.error
              ? `${source.error}${frame ? " · Retaining the last validated frame with its original expiry." : ""}`
              : message}
          </span>
          {source.error ? (
            <button onClick={source.retry}>Retry</button>
          ) : (
            <button
              aria-label="Dismiss message"
              onClick={() => setMessage(null)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      <MarketSummaryStrip
        frame={frame}
        history={data?.history ?? []}
        horizon={view.horizon}
        setHorizon={(h) => set({ horizon: h })}
      />
      <div className="mp-grid">
        <RegimeOverviewPanel {...common} search={search} />
        <MarketPulsePanel
          frame={frame}
          history={data?.history ?? []}
          horizon={view.horizon}
          window={view.window}
          setHorizon={(h) => set({ horizon: h })}
          setWindow={(w) => set({ window: w })}
          replay={(id) => void source.replay(id)}
        />
        <CorrelationsPanel
          {...common}
          correlations={data?.correlations ?? []}
          benchmark={view.benchmark}
          setBenchmark={(b) => set({ benchmark: b })}
          openMatrix={() => setDrawer("matrix")}
        />
        <div className="mp-right-rail">
          <LeadersLaggardsPanel {...common} benchmark={view.benchmark} />
          <MarketEventFeed
            events={events}
            frame={frame}
            select={select}
            nextPage={() => void loadEvents()}
            hasMore={Boolean(extra ? extra.cursor : data?.eventCursor)}
            fault={data?.faults.events}
          />
        </div>
        <MarketHeatmapPanel
          {...common}
          sector={view.sector}
          setSector={(s) => set({ sector: s })}
        />
        <ReturnDistributionPanel frame={frame} selectCohort={highlight} />
        <ParticipationPanel
          frame={frame}
          selectPredicate={(p) =>
            highlight(
              predicateMembers(frame?.assets ?? [], p),
              p.replaceAll("_", " "),
            )
          }
        />
      </div>
      <footer className="mp-page-footer">
        <span>
          <strong>V3 Market Picture</strong> · {frame?.expected ?? "—"} symbols
          · one observation frame
        </span>
        <span>
          {source.frozen
            ? "View frozen · source age continues"
            : "Read-only market intelligence"}{" "}
          <span className="mp-up">●</span>
        </span>
      </footer>
      {drawer && (
        <Drawer
          title={
            drawer === "asset"
              ? `${selected?.symbol ?? "Asset"} · observation`
              : drawer === "coverage"
                ? "Coverage, provenance & research"
                : drawer === "matrix"
                  ? "Correlation matrix"
                  : drawer === "settings"
                    ? "Market Picture settings"
                    : drawer === "tools"
                      ? "Native screener tools"
                      : "Export this frame"
          }
          wide={drawer === "matrix" || drawer === "tools"}
          close={closeDrawer}
        >
          {drawer === "asset" &&
            (selected && frame ? (
              <AssetInspector
                asset={selected}
                frame={frame}
                openNativeTools={() => {
                  setNativeSearch(`?${new URLSearchParams({search: selected.symbol})}`);
                  openTools();
                }}
                watched={scopedPreferences.watchlist.includes(
                  selected.instrument_id,
                )}
                toggleWatch={() =>
                  savePreferences({
                    watchlist: scopedPreferences.watchlist.includes(
                      selected.instrument_id,
                    )
                      ? scopedPreferences.watchlist.filter(
                          (id) => id !== selected.instrument_id,
                        )
                      : [
                          ...scopedPreferences.watchlist,
                          selected.instrument_id,
                        ],
                  })
                }
                note={scopedPreferences.notes[selected.instrument_id] ?? ""}
                saveNote={(value) =>
                  savePreferences({
                    notes: {
                      ...scopedPreferences.notes,
                      [selected.instrument_id]: value,
                    },
                  })
                }
              />
            ) : (
              <Empty>The selected asset is not in this frame.</Empty>
            ))}
          {drawer === "coverage" && (
            <CoverageDetails frame={frame} server={server} fixtureTime={fixture?.frame.available_at_ms}
              faults={data?.faults ?? {source: source.error ?? "Source unavailable"}} />
          )}
          {drawer === "matrix" && (
            <CorrelationMatrix
              frame={frame}
              server={server}
              initial={data?.correlations ?? []}
              fixture={Boolean(fixture)}
              select={select}
            />
          )}
          {drawer === "tools" && (
            <Suspense
              fallback={<p role="status">Opening native screener tools…</p>}
            >
              <p className="mp-muted">Native tools read their own recorded source snapshot. Their candles and reconstructed history are separate from the Market Picture frame.</p>
              <NativeTools viewSearch={nativeSearch} />
            </Suspense>
          )}
          {drawer === "export" && (
            <div className="mp-export-actions">
              <p>
                Exports preserve the selected frame, its full observation
                universe and original source times.
              </p>
              <button onClick={() => void exportContext()}>
                <Download size={16} /> Full context & research JSON
              </button>
              <button onClick={exportCsv}>
                <Download size={16} /> All-asset CSV
              </button>
              <p className="mp-muted">
                JSON includes source checksums, stored components, local view
                selection and highlighted cohort. Private notes are excluded.
              </p>
            </div>
          )}
          {drawer === "settings" && (
            <div className="mp-settings">
              <h3>Saved views</h3>
              <label>
                Name
                <input
                  value={viewName}
                  maxLength={60}
                  onChange={(e) => setViewName(e.target.value)}
                />
              </label>
              <button
                disabled={
                  !viewName.trim() ||
                  !frame ||
                  scopedPreferences.views.length >= 20
                }
                onClick={() => {
                  savePreferences({
                    views: [
                      ...scopedPreferences.views,
                      { name: viewName.trim(), view },
                    ],
                  });
                  setViewName("");
                }}
              >
                Save current view
              </button>
              {scopedPreferences.views.map((saved, i) => (
                <div className="mp-saved-view" key={i}>
                  <button
                    onClick={() => {
                      setView(saved.view);
                      setDrawer(null);
                    }}
                  >
                    {saved.name}
                  </button>
                  <button
                    aria-label={`Delete ${saved.name}`}
                    onClick={() =>
                      savePreferences({
                        views: scopedPreferences.views.filter(
                          (_, index) => index !== i,
                        ),
                      })
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <h3>Watchlist</h3>
              {scopedPreferences.watchlist.length ? (
                scopedPreferences.watchlist.map((id) => (
                  <button key={id} onClick={() => select(id)}>
                    <Star size={14} />
                    {id}
                  </button>
                ))
              ) : (
                <p className="mp-muted">
                  Open a symbol to add it to this source's watchlist.
                </p>
              )}
              <h3>Display behavior</h3>
              <p>
                System reduced-motion preference is respected. Freeze pins every
                panel and export while freshness continues to age. Each panel
                names its observation interval.
              </p>
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}

/** Clock updates stay outside chart/table state; frame values remain immutable. */
function useObservationClock(fixtureTime?: number) {
  const [now, setNow] = useState(() => fixtureTime ?? Date.now());
  useEffect(() => {
    const start = Date.now();
    const tick = () => setNow(fixtureTime === undefined ? Date.now() : fixtureTime + Date.now() - start);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [fixtureTime]);
  return now;
}
function SourceStatus({frame, frozen, loading, server, fixtureTime}: {
  frame: DisplayFrame | null; frozen: boolean; loading: boolean; server: string | null; fixtureTime?: number;
}) {
  const now = useObservationClock(fixtureTime);
  const state = ageState(frame, now, frozen);
  return (
        <div className="mp-source-state">
          <strong data-freshness={state.freshness}>
            {loading
              ? "Loading"
              : state.mode === "LIVE"
                ? frame?.valid === 0
                  ? "No qualified data"
                  : state.freshness !== "FRESH"
                    ? state.freshness
                    : "LIVE"
                : `${state.mode}${state.freshness === "FRESH" ? "" : ` · ${state.freshness}`}`}
            <span aria-hidden="true">●</span>
          </strong>
          <time>
            {new Date(now).toISOString().replace("T", " ").slice(0, 19)} UTC
          </time>
          <small>
            {frame
              ? `${frame.expected} symbols · ${frame.quote} spot · ${Math.floor((state.ageMs ?? 0) / 1000)}s old`
              : (server ?? "Select a source")}
          </small>
          {frame && frame.valid < frame.expected && <small className="mp-warning">Partial · {frame.valid}/{frame.expected} qualified</small>}
        </div>
  );
}
function CoverageDetails({frame, faults, server, fixtureTime}: {
  frame: DisplayFrame | null; faults: Record<string,string>; server: string | null; fixtureTime?: number;
}) {
  const now = useObservationClock(fixtureTime);
  const canonicalRef = frame?.raw.canonical_context_ref as
    { status?: string; snapshot_id?: string } | undefined;
  return <>
    <CoverageProvenance frame={frame} faults={faults} now={now} />
    <h3>Canonical owner context</h3>
    {canonicalRef?.status === "available" && canonicalRef.snapshot_id ? (
      <Suspense fallback={<p>Loading attached context…</p>}>
        <CanonicalContext server={server} paused snapshotId={canonicalRef.snapshot_id} now={now} />
      </Suspense>
    ) : <p className="mp-muted">No qualified canonical context snapshot is attached to this observation frame.</p>}
  </>;
}
