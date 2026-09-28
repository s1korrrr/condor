import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileJson2,
  Filter,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Star,
  Table2,
  Waves,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useServer } from "@/hooks/useServer";
import type {
  MetricValue,
  ScreenerCapabilities,
  ScreenerCandlesEnvelope,
  ScreenerEnvelope,
  ScreenerHistoryEnvelope,
  ScreenerOwnerOption,
  ScreenerRow,
  ScreenFilter,
  ScreenPredicate,
  ScreenerStorage,
} from "@/features/screener/contracts";
import {
  COLUMNS,
  SCREENS,
  formatDisplayNumber,
  makeResearchPacket,
  makeViewUrl,
  matchTransitions,
  metricFor,
  metricSortValue,
  parseViewParams,
  scopeKey,
  storageScopeKey,
  snapshotFreshness,
  snapshotCsv,
  storageRead,
  storageWrite,
} from "@/features/screener/model.mjs";
import "@/features/screener/screener.css";
import { CandleChart } from "@/features/screener/CandleChart";

const INTERVALS = ["1m", "5m", "15m"];
const ADVANCED_CAPABILITIES = [
  [
    "Order book and trade flow",
    "requires_book_trade",
    "No admitted native book or trade reader is attached.",
  ],
  [
    "Cross-venue context",
    "requires_cross_venue",
    "No qualified aligned multi-venue observation is advertised.",
  ],
  [
    "Derivatives, options and macro",
    "requires_derivatives_context",
    "Each market has a different identity, unit and freshness contract.",
  ],
  [
    "DEX pool discovery and risk metadata",
    "requires_dex_provider",
    "No admitted DEX source is advertised.",
  ],
  [
    "Forecasts and external sentiment",
    "requires_external_artifacts",
    "No model or provider artifact is advertised.",
  ],
  [
    "Original recorded rank history",
    "recorded_rank_history",
    "Only candle reconstruction is available unless an original snapshot store is advertised.",
  ],
  [
    "Background notifications",
    "background_notifications",
    "This open workspace does not deliver background alerts.",
  ],
];
const emptyStorage: ScreenerStorage = {
  version: 1,
  views: [],
  watchlist: [],
  notes: [],
};
const NO_METRICS: NonNullable<ScreenerCapabilities["metrics"]> = [];

function metricDisplay(value: MetricValue | null | undefined, digits = 2) {
  if (!value)
    return {
      text: "Unavailable",
      title: "This metric is not supplied by the selected source.",
      status: "unavailable",
    };
  if (value.status !== "valid" || value.value == null)
    return {
      text:
        value.status === "warming"
          ? `${value.sample_count}/${value.required_samples} bars`
          : value.status[0]!.toUpperCase() + value.status.slice(1),
      title: [
        ...value.reason_codes,
        `${value.sample_count}/${value.required_samples} samples`,
        value.source_id,
      ].join(" · "),
      status: value.status,
    };
  return {
    text: `${formatDisplayNumber(value.value, digits, value.definition_id === "last_closed_price")}${value.unit === "percent" ? "%" : value.unit === "USDC" ? "" : ""}`,
    title: `${value.value} ${value.unit} · ${value.definition_id} v${value.definition_version} · ${value.sample_count} samples · ${value.source_id} · ${value.observed_at || "observation time unavailable"}`,
    status: value.status,
  };
}
function download(name: string, type: string, content: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
function readScopedStorage(key: string) {
  try {
    return storageRead(window.localStorage, key);
  } catch {
    return {
      value: null,
      error:
        "Browser storage is unavailable. This screener session can still be used.",
    };
  }
}
function writeScopedStorage(key: string, value: typeof emptyStorage) {
  try {
    return storageWrite(window.localStorage, key, value);
  } catch {
    return "This change is only available until the page closes because browser storage is unavailable.";
  }
}

export function Screener() {
  const { server, setServer } = useServer();
  const { user } = useAuth();
  const location = useLocation();
  const initialView = useRef(parseViewParams(location.search));
  const [sharedViewError, setSharedViewError] = useState<string | null>(
    initialView.current.error || null,
  );
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const viewError = sharedViewError || ownerError;
  const [scopeValidated, setScopeValidated] = useState(
    !initialView.current.value?.server,
  );
  const [includeNotes, setIncludeNotes] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [sharedViewUrl, setSharedViewUrl] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(
    () => window.matchMedia("(max-width: 1050px)").matches,
  );
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [screen, setScreen] = useState("all");
  const [interval, setInterval] = useState("1m");
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [filterDraft, setFilterDraft] = useState<ScreenPredicate>({
    metric: "rsi_14",
    operator: "lte",
    value: "30",
  });
  const [filters, setFilters] = useState<ScreenFilter | null>(null);
  const [capabilities, setCapabilities] = useState<ScreenerCapabilities | null>(
    null,
  );
  const [registryBots, setRegistryBots] = useState<ScreenerOwnerOption[]>([]);
  const [ownerReasons, setOwnerReasons] = useState<string[]>([]);
  const [visualSources, setVisualSources] = useState<
    Array<{ bot: string; server: string }>
  >([]);
  const [bot, setBot] = useState<string | null>(null);
  const scope = scopeKey(
    user?.id ? String(user.id) : null,
    server,
    bot,
    "spot",
    "USDC",
    interval,
  );
  const storageScope = storageScopeKey(
    user?.id ? String(user.id) : null,
    server,
    bot,
    "spot",
    "USDC",
  );
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [snapshot, setSnapshot] = useState<ScreenerEnvelope | null>(null);
  const [pendingSnapshot, setPendingSnapshot] =
    useState<ScreenerEnvelope | null>(null);
  const [matchChanges, setMatchChanges] = useState<
    Array<{ kind: "entered" | "left"; instrumentId: string; symbol: string }>
  >([]);
  const [moreRows, setMoreRows] = useState<ScreenerRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instrument, setInstrument] = useState<ScreenerRow | null>(null);
  const [candles, setCandles] = useState<ScreenerCandlesEnvelope | null>(null);
  const [compareCandles, setCompareCandles] = useState<
    Record<string, ScreenerCandlesEnvelope>
  >({});
  const [history, setHistory] = useState<ScreenerHistoryEnvelope | null>(null);
  const [storageData, setStorageData] = useState(emptyStorage);
  const [loadedScope, setLoadedScope] = useState(scope);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [viewName, setViewName] = useState("");
  const [namingView, setNamingView] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [ageNow, setAgeNow] = useState(Date.now());
  const [isVisible, setIsVisible] = useState(!document.hidden);
  const [isHeatmap, setIsHeatmap] = useState(false);
  const [sortMetric, setSortMetric] = useState("server");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<
    "signals" | "context" | "history" | "notes"
  >("signals");
  const [newNote, setNewNote] = useState("");
  const [showColumns, setShowColumns] = useState(false);
  const [columns, setColumns] = useState<string[]>([
    "price",
    "return_1h",
    "rsi_14",
    "atr_pct_14",
    "rvol_20",
    "turnover_24h",
  ]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentSnapshotId = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const pageAbortRef = useRef<AbortController | null>(null);
  const failureCountRef = useRef(0);
  const pollDelayRef = useRef(5000);
  const suppressChangesRef = useRef(true);
  const selected = useMemo(
    () =>
      [...(snapshot?.rows || []), ...moreRows].find(
        (row) => row.instrument_id === selectedId,
      ) || null,
    [snapshot, moreRows, selectedId],
  );

  useEffect(() => {
    const parsed = initialView.current;
    const view = parsed.value;
    if (view) {
      setScreen(view.screen);
      setInterval(view.interval);
      setDraftSearch(view.search);
      setSearch(view.search);
      setFilters(view.filters);
      if (view.sort) setSortMetric(view.sort);
      if (view.direction) setSortDirection(view.direction);
    } else if (parsed.error) setStorageMessage(parsed.error);
  }, []);

  useEffect(() => {
    const sharedServer = initialView.current.value?.server;
    if (!sharedServer || scopeValidated) return;
    let disposed = false;
    setSharedViewError(null);
    void api
      .getServers()
      .then((servers) => {
        if (disposed) return;
        if (!servers.some((item) => item.name === sharedServer)) {
          setSharedViewError(
            "The shared server is not authorized for this account.",
          );
          return;
        }
        setServer(sharedServer);
        setScopeValidated(true);
      })
      .catch(() => {
        if (!disposed)
          setSharedViewError("The shared source could not be authorized.");
      });
    return () => {
      disposed = true;
    };
  }, [setServer, scopeValidated, retryVersion]);

  useEffect(() => {
    setOwnerError(null);
    setOwnerReasons([]);
    setRegistryBots([]);
    setBot(null);
    setCapabilities(null);
    setSnapshot(null);
    setPendingSnapshot(null);
    setMoreRows([]);
    setSelectedId(null);
    setInstrument(null);
    setCandles(null);
    setHistory(null);
    setCompareIds([]);
    setMatchChanges([]);
    setIsFrozen(false);
    setFrozenAt(null);
    setColumns([
      "price",
      "return_1h",
      "rsi_14",
      "atr_pct_14",
      "rvol_20",
      "turnover_24h",
    ]);
    setError(null);
    setBusy(true);
    currentSnapshotId.current = null;
    setPageCursor(null);
    requestVersion.current += 1;
    abortRef.current?.abort();
    pageAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    suppressChangesRef.current = true;
    if (!server) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    api
      .getScreenerOwners(server, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const found = (result.owners || []).filter(
          (item) =>
            item.eligible === true &&
            item.lane === "spot" &&
            item.venue.toLowerCase() === "okx" &&
            item.quote_asset === "USDC",
        );
        setRegistryBots(found);
        setOwnerReasons([
          ...new Set(result.owners.flatMap((item) => item.reason_codes || [])),
        ]);
        const requested = initialView.current.value;
        const requestedBot =
          requested?.bot && (!requested.server || requested.server === server)
            ? requested.bot
            : null;
        const owner = requestedBot
          ? found.find((item) => item.bot_name === requestedBot)
          : found.find((item) => item.bot_name === result.default_bot) ||
            found[0];
        if (requestedBot && !owner)
          setOwnerError(
            "The shared owner is not an eligible registered source on this server.",
          );
        setBot(owner?.bot_name || null);
        setBusy(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setRegistryBots([]);
          setBot(null);
          setBusy(false);
          setError(
            e instanceof Error
              ? e.message
              : "Native bot registry is unavailable.",
          );
        }
      });
    return () => controller.abort();
  }, [server, user?.id, retryVersion]);

  useEffect(() => {
    const onVisibility = () => setIsVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    const tick = window.setInterval(() => setAgeNow(Date.now()), 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setPendingSnapshot(null);
    setMoreRows([]);
    setSelectedId(null);
    setInstrument(null);
    setCandles(null);
    setHistory(null);
    currentSnapshotId.current = null;
    setPageCursor(null);
    setMatchChanges([]);
    suppressChangesRef.current = true;
    pageAbortRef.current?.abort();
    exportAbortRef.current?.abort();
    setIsFrozen(false);
    setFrozenAt(null);
    setCompareIds([]);
    setCompareCandles({});
    setIncludeNotes(false);
    setError(null);
    const saved = readScopedStorage(storageScope);
    setStorageData(saved.value || emptyStorage);
    setStorageMessage(saved.error);
    setLoadedScope(storageScope);
  }, [storageScope]);

  const persist = useCallback(
    (next: typeof emptyStorage) => {
      setStorageData(next);
      setStorageMessage(writeScopedStorage(storageScope, next));
    },
    [storageScope],
  );

  useEffect(() => {
    if (!server || !bot) {
      setCapabilities(null);
      return;
    }
    const controller = new AbortController();
    setCapabilities(null);
    setBusy(true);
    api
      .getScreenerCapabilities(server, bot, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCapabilities(value);
          setBusy(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(
            e instanceof Error ? e.message : "Capabilities are unavailable.",
          );
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [server, bot, retryVersion]);

  useEffect(() => {
    if (!server || !bot) {
      setVisualSources([]);
      return;
    }
    const controller = new AbortController();
    api
      .getTradingVisualsSources(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setVisualSources(result.sources || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVisualSources([]);
      });
    return () => controller.abort();
  }, [server, bot, retryVersion]);

  useEffect(() => {
    if (
      !server ||
      !scopeValidated ||
      viewError ||
      !isVisible ||
      isFrozen ||
      capabilities?.availability !== "available"
    )
      return;
    let disposed = false;
    const read = async () => {
      const version = ++requestVersion.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestScope = scope;
      setBusy(true);
      try {
        const value = await api.getScreenerSnapshot(
          server,
          bot!,
          {
            screen,
            interval,
            limit: 100,
            search,
            filters: filters || undefined,
            sort: sortMetric,
            direction: sortDirection,
            watchlistIds:
              screen === "watchlist" ? storageData.watchlist : undefined,
          },
          controller.signal,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          version !== requestVersion.current ||
          requestScope !== activeScope.current
        )
          return;
        if (
          value.schema_version !== "condor-screener.v1" ||
          !value.server_id ||
          value.source_id !== capabilities?.source_id ||
          value.lane !== "spot" ||
          value.venue.toLowerCase() !== "okx" ||
          value.quote_asset !== "USDC" ||
          value.rows.some(
            (row) =>
              row.lane !== "spot" ||
              row.venue.toLowerCase() !== "okx" ||
              row.quote_asset !== "USDC" ||
              !/^okx:spot:[A-Z0-9]{1,30}-USDC$/.test(row.instrument_id),
          )
        )
          throw new Error(
            "The source identity does not match the selected OKX spot USDC scope.",
          );
        if (suppressChangesRef.current) {
          setSnapshot(value);
          setPendingSnapshot(null);
          setMoreRows([]);
          currentSnapshotId.current = value.snapshot_id;
          setPageCursor(value.next_cursor);
          suppressChangesRef.current = false;
        } else if (currentSnapshotId.current === value.snapshot_id) {
          /* immutable snapshot: keep its loaded cursor and rows */
        } else if (currentSnapshotId.current && !isFrozen)
          setPendingSnapshot(value);
        else {
          setSnapshot(value);
          setPendingSnapshot(null);
          setMoreRows([]);
          currentSnapshotId.current = value.snapshot_id;
          setPageCursor(value.next_cursor);
        }
        setError(null);
        failureCountRef.current = 0;
        pollDelayRef.current = 5000;
      } catch (e) {
        if (
          !disposed &&
          !controller.signal.aborted &&
          version === requestVersion.current
        ) {
          setError(
            e instanceof Error
              ? e.message
              : "The screener source could not be read.",
          );
          suppressChangesRef.current = true;
          failureCountRef.current += 1;
          pollDelayRef.current = Math.min(
            30_000,
            5000 *
              2 ** Math.min(3, failureCountRef.current - 1) *
              (0.85 + Math.random() * 0.3),
          );
        }
      } finally {
        if (!disposed && version === requestVersion.current) setBusy(false);
      }
    };
    let timer: number | undefined;
    const schedule = () => {
      if (!document.hidden && !isFrozen && !disposed)
        timer = window.setTimeout(() => {
          void read().finally(schedule);
        }, pollDelayRef.current);
    };
    void read().finally(schedule);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [
    server,
    bot,
    scope,
    scopeValidated,
    viewError,
    screen,
    interval,
    search,
    filters,
    isFrozen,
    isVisible,
    capabilities?.availability,
    capabilities?.source_id,
    sortMetric,
    sortDirection,
    storageData.watchlist,
  ]);

  useEffect(() => {
    if (!server || !selectedId || !snapshot) return;
    const controller = new AbortController();
    setInstrument(selected);
    setCandles(null);
    setHistory(null);
    void Promise.allSettled([
      api.getScreenerInstrument(
        server,
        bot!,
        selectedId,
        snapshot.snapshot_id,
        controller.signal,
      ),
      api.getScreenerCandles(
        server,
        bot!,
        selectedId,
        interval,
        240,
        controller.signal,
        snapshot.snapshot_id,
      ),
    ]).then(([detail, candleData]) => {
      if (controller.signal.aborted) return;
      if (
        detail.status === "fulfilled" &&
        detail.value.snapshot_id === snapshot.snapshot_id &&
        detail.value.instrument.instrument_id === selectedId
      )
        setInstrument(detail.value.instrument);
      if (
        candleData.status === "fulfilled" &&
        candleData.value.snapshot_id === snapshot.snapshot_id &&
        candleData.value.instrument_id === selectedId
      )
        setCandles(candleData.value);
      const failures = [detail, candleData].filter(
        (item) => item.status === "rejected",
      );
      if (failures.length)
        setStorageMessage(
          "Some instrument detail sources are unavailable. Available metrics remain scoped to this screen snapshot.",
        );
    });
    return () => controller.abort();
  }, [server, bot, selectedId, snapshot, interval, selected]);

  useEffect(() => {
    setNewNote(
      storageData.notes.find((note) => note.instrument_id === selectedId)
        ?.text || "",
    );
  }, [selectedId, storageData.notes]);
  useEffect(() => {
    setDetailTab("signals");
  }, [selectedId]);

  useEffect(() => {
    if (
      detailTab !== "history" ||
      !server ||
      !bot ||
      !selectedId ||
      !snapshot?.observed_at
    )
      return;
    const controller = new AbortController();
    setHistory(null);
    api
      .getScreenerHistory(
        server,
        bot,
        selectedId,
        interval,
        60,
        controller.signal,
        snapshot.observed_at,
      )
      .then((value) => {
        if (!controller.signal.aborted && value.instrument_id === selectedId)
          setHistory(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStorageMessage(
            "Historical reconstruction is unavailable for this bounded request.",
          );
      });
    return () => controller.abort();
  }, [
    detailTab,
    server,
    bot,
    selectedId,
    interval,
    snapshot?.snapshot_id,
    snapshot?.observed_at,
  ]);

  useEffect(() => {
    if (!server || !bot || !snapshot || compareIds.length < 2) {
      setCompareCandles({});
      return;
    }
    const controller = new AbortController();
    setCompareCandles({});
    void Promise.allSettled(
      compareIds.map((id) =>
        api.getScreenerCandles(
          server,
          bot,
          id,
          interval,
          240,
          controller.signal,
          snapshot.snapshot_id,
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const next: Record<string, ScreenerCandlesEnvelope> = {};
      results.forEach((result, index) => {
        if (
          result.status === "fulfilled" &&
          result.value.snapshot_id === snapshot.snapshot_id &&
          result.value.instrument_id === compareIds[index] &&
          result.value.completeness === "complete"
        )
          next[compareIds[index]!] = result.value;
      });
      setCompareCandles(next);
    });
    return () => controller.abort();
  }, [server, bot, snapshot, interval, compareIds]);

  const rows = useMemo(
    () => [...(snapshot?.rows || []), ...moreRows],
    [snapshot, moreRows],
  );
  const metrics = capabilities?.metrics || NO_METRICS;
  const sourceColumns = useMemo<Array<[string, string, string[]]>>(() => {
    const byId = new Map<string, [string, string, string[]]>();
    COLUMNS.forEach((column) =>
      byId.set(column[0], column as [string, string, string[]]),
    );
    metrics.forEach((metric) => {
      if (!byId.has(metric.id))
        byId.set(metric.id, [
          metric.id,
          metric.id
            .replace(/_/g, " ")
            .replace(/\b\w/g, (char) => char.toUpperCase()),
          [metric.id],
        ]);
    });
    return [...byId.values()];
  }, [metrics]);
  const normalizedComparison = useMemo(() => {
    if (compareIds.length < 2 || compareIds.some((id) => !compareCandles[id]))
      return null;
    const sets = compareIds.map(
      (id) =>
        new Map(
          compareCandles[id]!.candles.map((candle) => [
            candle.timestamp,
            Number(candle.close),
          ]),
        ),
    );
    const timestamps = [...sets[0]!.keys()]
      .filter((timestamp) => sets.every((set) => set.has(timestamp)))
      .sort((a, b) => a - b);
    if (timestamps.length < 2) return null;
    const series = sets.map((set) =>
      timestamps.map((timestamp) => set.get(timestamp)!),
    );
    const normalized = series.map((values) =>
      values.map((value) => (value / values[0]!) * 100),
    );
    const all = normalized.flat();
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;
    return {
      timestamps,
      values: normalized.map((values) =>
        values.map((value) => 88 - ((value - min) / span) * 72),
      ),
    };
  }, [compareIds, compareCandles]);
  const selectedColumns = sourceColumns.filter(([id]) => columns.includes(id));
  const age = snapshot?.observed_at
    ? Math.floor((ageNow - new Date(snapshot.observed_at).getTime()) / 1000)
    : null;
  const intervalMs =
    ({ "1m": 60_000, "5m": 300_000, "15m": 900_000 } as Record<string, number>)[
      interval
    ] || 60_000;
  const freshness = snapshotFreshness(snapshot, ageNow, intervalMs, !!error);

  const applyPending = () => {
    if (!pendingSnapshot) return;
    setMatchChanges(
      !suppressChangesRef.current
        ? matchTransitions(snapshot, pendingSnapshot)
        : [],
    );
    suppressChangesRef.current = pendingSnapshot.completeness !== "complete";
    setSelectedId((current) =>
      pendingSnapshot.rows.some((row) => row.instrument_id === current)
        ? current
        : null,
    );
    setSnapshot(pendingSnapshot);
    currentSnapshotId.current = pendingSnapshot.snapshot_id;
    setPendingSnapshot(null);
    setMoreRows([]);
    setPageCursor(pendingSnapshot.next_cursor);
  };
  const resetQuerySnapshot = () => {
    suppressChangesRef.current = true;
    setMatchChanges([]);
    currentSnapshotId.current = null;
    setSnapshot(null);
    setPendingSnapshot(null);
    setMoreRows([]);
    setPageCursor(null);
    setSelectedId(null);
    setInstrument(null);
    setCandles(null);
    setHistory(null);
    setCompareIds([]);
    abortRef.current?.abort();
    pageAbortRef.current?.abort();
    exportAbortRef.current?.abort();
  };
  const addFilter = () => {
    if (!metrics.some((metric) => metric.id === filterDraft.metric)) {
      setError("Choose a metric advertised by the selected source.");
      return;
    }
    if (
      filterDraft.operator !== "is_unavailable" &&
      (!filterDraft.value ||
        !/^-?\d+(\.\d+)?$/.test(filterDraft.value) ||
        !Number.isFinite(Number(filterDraft.value)))
    ) {
      setError("Enter a finite decimal filter value.");
      return;
    }
    const next = [...(filters?.predicates || []), { ...filterDraft }];
    if (next.length > (capabilities?.limits?.filters_max || 32)) {
      setError("The screener supports at most 32 filter predicates.");
      return;
    }
    resetQuerySnapshot();
    setFilters({ op: filters?.op || "and", predicates: next });
    setFilterOpen(false);
  };
  const removeFilter = (index: number) => {
    resetQuerySnapshot();
    setFilters((current) =>
      current
        ? {
            ...current,
            predicates: current.predicates.filter((_, i) => i !== index),
          }
        : null,
    );
  };
  const loadMore = async () => {
    if (!server || !snapshot || !pageCursor || busy) return;
    setBusy(true);
    const controller = new AbortController();
    pageAbortRef.current?.abort();
    pageAbortRef.current = controller;
    const thisScope = activeScope.current;
    const thisSnapshot = snapshot.snapshot_id;
    try {
      const page = await api.getScreenerSnapshot(
        server,
        bot!,
        {
          screen,
          interval,
          limit: 100,
          search,
          cursor: pageCursor,
          filters: filters || undefined,
          sort: sortMetric,
          direction: sortDirection,
          watchlistIds:
            screen === "watchlist" ? storageData.watchlist : undefined,
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        activeScope.current !== thisScope ||
        currentSnapshotId.current !== thisSnapshot
      )
        return;
      if (
        page.snapshot_id !== thisSnapshot ||
        page.query_hash !== snapshot.query_hash
      )
        throw new Error(
          "The pinned snapshot expired. Refresh to start a new screen.",
        );
      setMoreRows((rows) => [...rows, ...page.rows]);
      setPageCursor(page.next_cursor);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Could not load the next result page.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const toggleWatch = (id: string) => {
    if (
      !storageData.watchlist.includes(id) &&
      storageData.watchlist.length >= 250
    ) {
      setStorageMessage("This watchlist supports at most 250 instruments.");
      return;
    }
    persist({
      ...storageData,
      watchlist: storageData.watchlist.includes(id)
        ? storageData.watchlist.filter((item) => item !== id)
        : [...storageData.watchlist, id],
    });
    if (screen === "watchlist") resetQuerySnapshot();
  };
  const toggleCompare = (id: string) =>
    setCompareIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < 4
          ? [...current, id]
          : current,
    );
  const saveView = () => {
    const name = viewName;
    if (!name.trim()) return;
    if (
      storageData.views.length >= 50 &&
      !storageData.views.some((view) => view.name === name.trim())
    ) {
      setStorageMessage("This source supports at most 50 saved views.");
      return;
    }
    persist({
      ...storageData,
      views: [
        ...storageData.views.filter((view) => view.name !== name.trim()),
        {
          name: name.trim().slice(0, 60),
          screen,
          interval,
          search,
          filters,
          columns,
          sortMetric,
          sortDirection,
          display: isHeatmap ? "heatmap" : "table",
          compareIds,
        },
      ],
    });
    setNamingView(false);
    setViewName("");
    setStorageMessage(`Saved view: ${name.trim().slice(0, 60)}.`);
  };
  const loadView = (view: (typeof storageData.views)[number]) => {
    if (isFrozen) return;
    if (
      !(capabilities?.supported_intervals || INTERVALS).includes(
        view.interval,
      ) ||
      (view.sortMetric &&
        view.sortMetric !== "server" &&
        !metrics.some((metric) => metric.id === view.sortMetric)) ||
      view.columns.some(
        (id) => !sourceColumns.some(([sourceId]) => sourceId === id),
      ) ||
      view.filters?.predicates.some(
        (predicate) =>
          !metrics.some((metric) => metric.id === predicate.metric),
      )
    ) {
      setStorageMessage(
        "This saved view references a definition no longer advertised by this source. It has not been applied.",
      );
      return;
    }
    resetQuerySnapshot();
    setScreen(view.screen);
    setInterval(view.interval);
    setSearch(view.search);
    setDraftSearch(view.search);
    setFilters(view.filters);
    setColumns(
      view.columns.filter((id) =>
        sourceColumns.some(([sourceId]) => sourceId === id),
      ),
    );
    setSortMetric(
      view.sortMetric && metrics.some((metric) => metric.id === view.sortMetric)
        ? view.sortMetric
        : "server",
    );
    setSortDirection(view.sortDirection === "asc" ? "asc" : "desc");
    setIsHeatmap(view.display === "heatmap");
    setCompareIds(
      (view.compareIds || [])
        .filter((id) => /^okx:spot:[A-Z0-9]{1,30}-USDC$/.test(id))
        .slice(0, 4),
    );
  };
  const copyViewLink = async () => {
    if (screen === "watchlist") {
      setStorageMessage(
        "Watchlists stay local. Export this snapshot to share its exact instruments.",
      );
      return;
    }
    const url = new URL(
      makeViewUrl({
        screen,
        interval,
        search,
        filters,
        server,
        bot,
        sort: sortMetric,
        direction: sortDirection,
      }),
      window.location.origin,
    ).toString();
    try {
      await navigator.clipboard.writeText(url);
      setSharedViewUrl(null);
      setStorageMessage(
        "Screen link copied. It contains no credentials or personal notes.",
      );
    } catch {
      setSharedViewUrl(url);
      setStorageMessage(
        "Clipboard is unavailable. Copy the generated view link below.",
      );
    }
  };

  const exportAll = async (format: "csv" | "json") => {
    if (!server || !bot || !snapshot) return;
    const limit = Math.min(5000, capabilities?.limits?.export_max || 5000);
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    const scopeAtStart = activeScope.current;
    const snapshotAtStart = snapshot.snapshot_id;
    let all = [...snapshot.rows, ...moreRows];
    let cursor = pageCursor;
    setBusy(true);
    try {
      while (cursor && all.length < limit) {
        const page = await api.getScreenerSnapshot(
          server,
          bot,
          {
            screen,
            interval,
            limit: 100,
            search,
            cursor,
            filters: filters || undefined,
            sort: sortMetric,
            direction: sortDirection,
            watchlistIds:
              screen === "watchlist" ? storageData.watchlist : undefined,
          },
          controller.signal,
        );
        if (controller.signal.aborted || activeScope.current !== scopeAtStart)
          return;
        if (page.snapshot_id !== snapshotAtStart)
          throw new Error(
            "The pinned snapshot expired before the full export completed. No mixed-snapshot file was created.",
          );
        all = [...all, ...page.rows];
        cursor = page.next_cursor;
      }
      if (cursor && all.length >= limit)
        throw new Error(
          "This result set exceeds the 5,000 row export limit. Refine the screen before exporting.",
        );
      if (
        controller.signal.aborted ||
        activeScope.current !== scopeAtStart ||
        currentSnapshotId.current !== snapshotAtStart
      )
        return;
      if (format === "csv")
        download(
          "screener.csv",
          "text/csv;charset=utf-8",
          snapshotCsv({ ...snapshot, rows: all }),
        );
      else
        download(
          "screener-research-packet.json",
          "application/json",
          JSON.stringify(
            makeResearchPacket(
              { ...snapshot, rows: all },
              {
                server,
                bot,
                screen,
                interval,
                search,
                filters,
                sort: sortMetric,
                direction: sortDirection,
                watchlist_ids:
                  screen === "watchlist" ? storageData.watchlist : [],
              },
              instrument,
              includeNotes
                ? storageData.notes.filter((note) =>
                    all.some((row) => row.instrument_id === note.instrument_id),
                  )
                : [],
            ),
            null,
            2,
          ),
        );
      setStorageMessage(
        `Exported ${all.length} rows from snapshot ${snapshotAtStart}.`,
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "The full export could not be completed.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const addNote = () => {
    if (!selected) return;
    persist({
      ...storageData,
      notes: [
        ...storageData.notes.filter(
          (note) => note.instrument_id !== selected.instrument_id,
        ),
        ...(newNote.trim()
          ? [
              {
                instrument_id: selected.instrument_id,
                text: newNote.trim().slice(0, 500),
                updated_at: new Date().toISOString(),
              },
            ]
          : []),
      ],
    });
  };
  const onRowKey = (
    event: React.KeyboardEvent<HTMLTableRowElement>,
    index: number,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setSelectedId(rows[index]?.instrument_id || null);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (
        event.currentTarget.previousElementSibling as HTMLElement | null
      )?.focus();
    }
  };

  const closeInspector = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    window.requestAnimationFrame(() => {
      Array.from(
        document.querySelectorAll<HTMLTableRowElement>(
          "[data-screener-instrument]",
        ),
      )
        .find((item) => item.dataset.screenerInstrument === id)
        ?.focus();
    });
  }, [selectedId]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1050px)");
    const update = () => setIsCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!selected || !isCompact || !inspectorRef.current) return;
    // The compact inspector covers the page. Make every background branch inert,
    // preserving existing attributes and restoring them when the sheet closes.
    const background = new Map<HTMLElement, boolean>();
    let branch: HTMLElement = inspectorRef.current;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    return () => {
      background.forEach((inert, element) => {
        element.inert = inert;
      });
    };
  }, [selected, isCompact]);
  useEffect(() => {
    if (!selectedId) return;
    inspectorRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeInspector();
        return;
      }
      if (
        event.key === "Tab" &&
        window.matchMedia("(max-width: 1050px)").matches
      ) {
        const controls = Array.from(
          inspectorRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],input:not(:disabled),textarea,select",
          ) || [],
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [selectedId, closeInspector]);

  return (
    <section className="screener" aria-label="Market screener">
      <header className="screener-head">
        <div>
          <h1>Screener</h1>
          <p>Find and inspect candidates from recorded OKX spot candles.</p>
        </div>
        <div className="screener-head-actions">
          <button
            className="screen-button"
            onClick={() => setNamingView((value) => !value)}
          >
            <Bookmark size={15} /> Save view
          </button>
          <button className="screen-button" onClick={() => void copyViewLink()}>
            <Copy size={15} /> Share view
          </button>
          <button
            className="screen-button primary"
            disabled={!snapshot || busy}
            onClick={() => void exportAll("csv")}
          >
            <Download size={15} /> Export CSV · up to 5k
          </button>
          <button
            className="screen-button"
            disabled={!snapshot || busy}
            onClick={() => void exportAll("json")}
          >
            <FileJson2 size={15} /> Research packet
          </button>
        </div>
      </header>

      {namingView && (
        <form
          className="filter-builder"
          onSubmit={(event) => {
            event.preventDefault();
            saveView();
          }}
        >
          <label htmlFor="saved-view-name">View name</label>
          <input
            id="saved-view-name"
            value={viewName}
            maxLength={60}
            autoFocus
            onChange={(event) => setViewName(event.target.value)}
          />
          <button
            className="screen-button primary"
            disabled={!viewName.trim()}
            type="submit"
          >
            Save named view
          </button>
          <button
            className="screen-button"
            type="button"
            onClick={() => setNamingView(false)}
          >
            Cancel
          </button>
        </form>
      )}
      {storageMessage && (
        <div className="screener-notice" role="status">
          <span>{storageMessage}</span>
          <button
            aria-label="Dismiss notice"
            onClick={() => setStorageMessage(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {sharedViewUrl && (
        <label className="filter-builder">
          View link
          <input
            aria-label="Generated view link"
            readOnly
            value={sharedViewUrl}
            onFocus={(event) => event.target.select()}
          />
          <button
            className="screen-button"
            onClick={() => setSharedViewUrl(null)}
          >
            Close link
          </button>
        </label>
      )}
      {!server && (
        <div className="screener-state">
          <Activity />
          <strong>Select a server</strong>
          <span>
            Choose a connected native V2 server to read its registered screener
            source.
          </span>
        </div>
      )}
      {server && capabilities?.availability === "unavailable" && (
        <div className="screener-state">
          <Activity />
          <strong>Screener source unavailable</strong>
          <span>
            {(capabilities.reason_codes || []).join(" · ") ||
              "This server has no qualified recorded candle source."}
          </span>
        </div>
      )}
      {server && registryBots.length === 0 && !busy && (
        <div className="screener-state">
          <Activity />
          <strong>No eligible registered screener owner</strong>
          <span>
            The selected native registry has no owner with an admitted OKX spot
            USDC candle source.{" "}
            {ownerReasons.includes("source_row_budget_exceeded")
              ? "The registered universe exceeds this source’s full-history capacity."
              : ownerReasons.join(" · ")}
          </span>
        </div>
      )}
      {server && !capabilities && busy && (
        <div className="screener-loading" role="status">
          <RefreshCw className="spin" size={16} /> Checking screener source…
        </div>
      )}
      {(viewError ||
        (server &&
          (error || capabilities?.availability === "unavailable"))) && (
        <button
          className="screen-button"
          disabled={busy}
          onClick={() => setRetryVersion((value) => value + 1)}
        >
          <RefreshCw size={15} /> Retry source
        </button>
      )}
      {error && (
        <div className="screener-alert" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {viewError && (
        <div className="screener-alert" role="alert">
          {viewError}
          <a href="/screener">Reset shared view</a>
        </div>
      )}
      {server &&
        scopeValidated &&
        !viewError &&
        capabilities?.availability === "available" &&
        loadedScope === storageScope && (
          <>
            <section className="source-ribbon" aria-label="Source and coverage">
              <div className="source-main">
                <span
                  className={`source-status-dot ${freshness === "Recorded candles" ? "current" : "not-current"}`}
                />
                <span>
                  <strong>
                    {capabilities.venue?.toUpperCase()} {capabilities.lane}
                  </strong>
                  <small>
                    {bot} · {capabilities.quote_asset} quote
                  </small>
                </span>
              </div>
              <label className="source-owner">
                Registered owner
                <select
                  aria-label="Registered V2 owner"
                  value={bot || ""}
                  onChange={(event) => setBot(event.target.value)}
                >
                  {registryBots.map((item) => (
                    <option key={item.bot_name} value={item.bot_name}>
                      {item.bot_name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="source-stat">
                <small>Coverage</small>
                <strong>
                  {snapshot?.counts.ready ?? "—"}
                  <i> ready</i> / {snapshot?.counts.subscribed ?? "—"}
                  <i> subscribed</i>
                </strong>
              </div>
              <div className="source-stat">
                <small>Quality</small>
                <strong>{freshness}</strong>
              </div>
              <div className="source-stat">
                <small>Observed</small>
                <strong>
                  {age === null || !Number.isFinite(age)
                    ? "—"
                    : age < 60
                      ? `${age}s ago`
                      : `${Math.floor(age / 60)}m ago`}
                </strong>
              </div>
              <div className="source-stat">
                <small>Snapshot</small>
                <strong className="mono">
                  {snapshot?.snapshot_id?.slice(0, 12) || "waiting"}
                </strong>
              </div>
            </section>

            <div className="screener-controls">
              <label className="screen-search">
                <Search size={15} />
                <input
                  disabled={isFrozen}
                  value={draftSearch}
                  onChange={(event) => {
                    setDraftSearch(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      resetQuerySnapshot();
                      setSearch(draftSearch.slice(0, 80));
                    }
                  }}
                  placeholder="Search pair or instrument"
                />
                <button
                  disabled={isFrozen}
                  onClick={() => {
                    resetQuerySnapshot();
                    setSearch(draftSearch.slice(0, 80));
                  }}
                >
                  Search
                </button>
              </label>
              <select
                aria-label="Screen preset"
                disabled={isFrozen}
                value={screen}
                onChange={(event) => {
                  resetQuerySnapshot();
                  setScreen(event.target.value);
                  setFilters(null);
                }}
              >
                {SCREENS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Candle interval"
                disabled={isFrozen}
                value={interval}
                onChange={(event) => {
                  resetQuerySnapshot();
                  setInterval(event.target.value);
                }}
              >
                {(capabilities.supported_intervals || INTERVALS).map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ),
                )}
              </select>
              <button
                className={`screen-button ${filterOpen ? "active" : ""}`}
                disabled={isFrozen}
                onClick={() => setFilterOpen((value) => !value)}
              >
                <Filter size={15} /> Filters
                {filters?.predicates.length
                  ? ` · ${filters.predicates.length}`
                  : ""}
              </button>
              <button
                className="screen-button"
                onClick={() => setShowColumns((value) => !value)}
              >
                <Table2 size={15} /> Columns
              </button>
              <button
                className="screen-button"
                onClick={() => setIsHeatmap((value) => !value)}
              >
                <Waves size={15} />
                {isHeatmap ? "Table" : "Heatmap"}
              </button>
              <button
                className={`screen-button ${isFrozen ? "active" : ""}`}
                onClick={() => {
                  setIsFrozen((value) => !value);
                  if (!isFrozen) setFrozenAt(Date.now());
                }}
                aria-pressed={isFrozen}
              >
                {isFrozen ? <Play size={15} /> : <Pause size={15} />}{" "}
                {isFrozen ? "Resume" : "Freeze"}
              </button>
            </div>

            {storageData.views.length > 0 && (
              <div className="saved-views" aria-label="Saved views">
                <span>Saved</span>
                {storageData.views.map((view) => (
                  <button
                    key={view.name}
                    disabled={isFrozen}
                    onClick={() => loadView(view)}
                  >
                    {view.name}
                  </button>
                ))}
              </div>
            )}
            {showColumns && (
              <div className="column-picker">
                {sourceColumns.map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={columns.includes(id)}
                      onChange={(event) =>
                        setColumns((current) =>
                          event.target.checked
                            ? [...current, id]
                            : current.filter((item) => item !== id),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {filterOpen && (
              <div className="filter-builder">
                <strong>Filter results</strong>
                <select
                  disabled={isFrozen}
                  aria-label="Filter metric"
                  value={filterDraft.metric}
                  onChange={(event) =>
                    setFilterDraft((value) => ({
                      ...value,
                      metric: event.target.value,
                    }))
                  }
                >
                  {metrics.map((metric) => (
                    <option key={metric.id} value={metric.id}>
                      {metric.id} · {metric.unit}
                    </option>
                  ))}
                </select>
                <select
                  disabled={isFrozen}
                  aria-label="Filter operator"
                  value={filterDraft.operator}
                  onChange={(event) =>
                    setFilterDraft((value) => ({
                      ...value,
                      operator: event.target
                        .value as ScreenPredicate["operator"],
                    }))
                  }
                >
                  {["lt", "lte", "eq", "gte", "gt", "is_unavailable"].map(
                    (op) => (
                      <option key={op} value={op}>
                        {op === "is_unavailable" ? "is unavailable" : op}
                      </option>
                    ),
                  )}
                </select>
                {filterDraft.operator !== "is_unavailable" && (
                  <input
                    disabled={isFrozen}
                    aria-label="Filter value"
                    value={filterDraft.value || ""}
                    onChange={(event) =>
                      setFilterDraft((value) => ({
                        ...value,
                        value: event.target.value,
                      }))
                    }
                    placeholder="Decimal value"
                  />
                )}
                <select
                  disabled={isFrozen}
                  aria-label="Filter match mode"
                  value={filters?.op || "and"}
                  onChange={(event) => {
                    resetQuerySnapshot();
                    setFilters((value) => ({
                      op: event.target.value as "and" | "or",
                      predicates: value?.predicates || [],
                    }));
                  }}
                >
                  <option value="and">Match all</option>
                  <option value="or">Match any</option>
                </select>
                <button
                  disabled={isFrozen}
                  className="screen-button primary"
                  onClick={addFilter}
                >
                  <Plus size={14} /> Add filter
                </button>
              </div>
            )}
            {!!filters?.predicates.length && (
              <div className="active-filters">
                {filters.op.toUpperCase()}
                {filters.predicates.map((predicate, index) => (
                  <span key={`${predicate.metric}-${index}`}>
                    {predicate.metric} {predicate.operator}{" "}
                    {predicate.value || ""}
                    <button
                      aria-label="Remove filter"
                      disabled={isFrozen}
                      onClick={() => removeFilter(index)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <button
                  className="text-button"
                  disabled={isFrozen}
                  onClick={() => {
                    resetQuerySnapshot();
                    setFilters(null);
                  }}
                >
                  Clear all
                </button>
              </div>
            )}

            <div className="screen-summary">
              <div>
                <strong>{snapshot?.counts.matched ?? "—"}</strong>
                <span>matched</span>
              </div>
              <div>
                <strong>{snapshot?.counts.warming ?? "—"}</strong>
                <span>warming</span>
              </div>
              <div>
                <strong>{snapshot?.counts.stale ?? "—"}</strong>
                <span>stale</span>
              </div>
              <div>
                <strong>{snapshot?.counts.excluded ?? "—"}</strong>
                <span>excluded</span>
              </div>
              <div className="summary-definition">
                <span>
                  {SCREENS.find(([id]) => id === screen)?.[1]} · {interval}{" "}
                  closed bars ·{" "}
                  {snapshot?.feature_set_version || "feature set pending"}
                </span>
                <span>
                  Numeric sort is stable; unavailable values stay last in either
                  direction.
                </span>
              </div>
            </div>
            {isFrozen && (
              <div className="frozen-banner">
                <Clock3 size={14} /> Frozen at{" "}
                {new Date(frozenAt || Date.now()).toLocaleTimeString()} · values
                remain pinned; age continues to advance.
              </div>
            )}
            {pendingSnapshot && !isFrozen && (
              <div className="updates-banner">
                <span>
                  <RefreshCw size={14} /> Updated snapshot available ·{" "}
                  {pendingSnapshot.counts.matched} matches
                </span>
                <button
                  className="screen-button primary"
                  onClick={applyPending}
                >
                  Apply updates
                </button>
              </div>
            )}
            {matchChanges.length > 0 && (
              <div className="screener-notice" role="status">
                <span>
                  In-app match changes:{" "}
                  {matchChanges
                    .slice(0, 6)
                    .map((item) => `${item.symbol} ${item.kind}`)
                    .join(" · ")}
                  {matchChanges.length > 6
                    ? ` · +${matchChanges.length - 6} more`
                    : ""}
                  . Outage recovery is silent until a fresh baseline is
                  established.
                </span>
                <button
                  aria-label="Dismiss match changes"
                  onClick={() => setMatchChanges([])}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {snapshot?.completeness === "partial" && (
              <div className="screener-notice">
                <span>
                  Partial universe ·{" "}
                  {snapshot.reason_codes.join(" · ") ||
                    "some registered instruments lack usable candles"}
                </span>
              </div>
            )}
            {!snapshot && !busy && (
              <div className="screener-state">
                <Activity />
                <strong>Waiting for qualified candles</strong>
                <span>
                  The native source has not returned a complete screen snapshot.
                </span>
              </div>
            )}

            <div
              className={`screener-grid ${selected ? "with-inspector" : ""}`}
            >
              <div className="result-panel">
                <div className="result-head">
                  <div>
                    <strong>
                      {snapshot?.venue?.toUpperCase() || "OKX"} spot · USDC
                    </strong>
                    <span>
                      {snapshot?.counts.matched ?? 0} matches · source revision{" "}
                      {snapshot?.source_revision || "—"}
                    </span>
                  </div>
                  <div className="sort-control">
                    <label htmlFor="sortMetric">Sort</label>
                    <select
                      id="sortMetric"
                      value={sortMetric}
                      disabled={isFrozen}
                      onChange={(event) => {
                        resetQuerySnapshot();
                        setSortMetric(event.target.value);
                      }}
                    >
                      <option value="server">Screen ranking</option>
                      {metrics.map((metric) => (
                        <option key={metric.id} value={metric.id}>
                          {metric.id}
                        </option>
                      ))}
                    </select>
                    {sortMetric !== "server" && (
                      <button
                        aria-label="Toggle sort direction"
                        disabled={isFrozen}
                        onClick={() => {
                          resetQuerySnapshot();
                          setSortDirection((value) =>
                            value === "asc" ? "desc" : "asc",
                          );
                        }}
                      >
                        {sortDirection === "asc" ? "↑" : "↓"}
                      </button>
                    )}
                  </div>
                </div>
                {!isHeatmap ? (
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label="Screener results"
                    tabIndex={0}
                  >
                    <table className="screener-table">
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">Instrument</th>
                          {selectedColumns.map(([id, label]) => (
                            <th key={id} scope="col">
                              {label}
                            </th>
                          ))}
                          <th scope="col">Match evidence</th>
                          <th scope="col">Quality</th>
                          <th scope="col">Watch</th>
                          <th scope="col">Compare</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr
                            key={row.instrument_id}
                            data-screener-instrument={row.instrument_id}
                            tabIndex={0}
                            aria-selected={row.instrument_id === selectedId}
                            className={
                              row.instrument_id === selectedId ? "selected" : ""
                            }
                            onKeyDown={(event) => onRowKey(event, index)}
                            onClick={() => setSelectedId(row.instrument_id)}
                          >
                            <td className="rank">{row.rank ?? "—"}</td>
                            <td>
                              <strong>{row.exchange_symbol}</strong>
                              <small>
                                {row.venue} · {row.lane} · {row.instrument_id}
                              </small>
                            </td>
                            {selectedColumns.map(([id, , aliases]) => {
                              const metric = metricFor(row, aliases);
                              const shown = metricDisplay(metric);
                              return (
                                <td key={id} title={shown.title}>
                                  <span
                                    className={`metric-value status-${shown.status}`}
                                  >
                                    {shown.text}
                                  </span>
                                  {id === "turnover_24h" &&
                                    metric?.status === "valid" && (
                                      <small>
                                        {metric.unit} · {metric.definition_id}
                                      </small>
                                    )}
                                </td>
                              );
                            })}
                            <td className="match-cell">
                              {row.match_reasons.length ? (
                                row.match_reasons.map((reason) => (
                                  <span key={reason} className="reason-chip">
                                    {reason}
                                  </span>
                                ))
                              ) : (
                                <span className="muted">
                                  No positive reason supplied
                                </span>
                              )}
                            </td>
                            <td>
                              <span
                                className={`quality quality-${row.metrics.rsi_14?.status || "unavailable"}`}
                              >
                                {row.metrics.rsi_14?.status || "unavailable"}
                              </span>
                            </td>
                            <td>
                              <button
                                className={`icon-button ${storageData.watchlist.includes(row.instrument_id) ? "watching" : ""}`}
                                disabled={isFrozen && screen === "watchlist"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleWatch(row.instrument_id);
                                }}
                                aria-label={
                                  storageData.watchlist.includes(
                                    row.instrument_id,
                                  )
                                    ? "Remove from watchlist"
                                    : "Add to watchlist"
                                }
                              >
                                <Star
                                  size={14}
                                  fill={
                                    storageData.watchlist.includes(
                                      row.instrument_id,
                                    )
                                      ? "currentColor"
                                      : "none"
                                  }
                                />
                              </button>
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Compare ${row.exchange_symbol}`}
                                checked={compareIds.includes(row.instrument_id)}
                                disabled={
                                  !compareIds.includes(row.instrument_id) &&
                                  compareIds.length >= 4
                                }
                                onClick={(event) => event.stopPropagation()}
                                onChange={() =>
                                  toggleCompare(row.instrument_id)
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!rows.length && snapshot && (
                      <div className="empty-results">
                        <Search size={20} />
                        <strong>
                          {snapshot.completeness === "unavailable"
                            ? "Source unavailable"
                            : "No matches"}
                        </strong>
                        <span>
                          {snapshot.completeness === "unavailable"
                            ? snapshot.reason_codes.join(" · ")
                            : "No qualified rows match the current screen. Check coverage and active predicates."}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="heatmap-legend">
                      RSI 14: cool ≤30 · neutral 30–70 · hot ≥70 · unavailable
                      uncolored
                    </p>
                    <div className="heatmap-grid">
                      {rows.map((row) => {
                        const metric = metricDisplay(row.metrics.rsi_14);
                        const numeric = metricSortValue(row.metrics.rsi_14);
                        const tone =
                          numeric == null
                            ? "unknown"
                            : numeric >= 70
                              ? "hot"
                              : numeric <= 30
                                ? "cool"
                                : "neutral";
                        return (
                          <button
                            key={row.instrument_id}
                            className={`heatmap-cell tone-${tone}`}
                            onClick={() => setSelectedId(row.instrument_id)}
                          >
                            <strong>{row.exchange_symbol}</strong>
                            <span>RSI {metric.text}</span>
                            <small>
                              {row.rank ?? "—"} ·{" "}
                              {row.metrics.rsi_14?.status || "unavailable"}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="result-footer">
                  <span>
                    {isFrozen
                      ? "Frozen snapshot · observation age continues"
                      : busy
                        ? "Refreshing…"
                        : "Recorded closed candles · 5 second visible refresh"}
                  </span>
                  {pageCursor && (
                    <button
                      className="screen-button"
                      disabled={busy}
                      onClick={() => void loadMore()}
                    >
                      <ChevronDown size={14} /> Load more
                    </button>
                  )}
                </div>
              </div>

              {selected && (
                <aside
                  role={isCompact ? "dialog" : undefined}
                  aria-modal={isCompact ? true : undefined}
                  ref={inspectorRef}
                  className="instrument-inspector"
                  aria-label={`${selected.exchange_symbol} instrument details`}
                >
                  <header className="inspector-head">
                    <div>
                      <small>
                        {selected.venue} · {selected.lane} ·{" "}
                        {selected.quote_asset}
                      </small>
                      <h2>{selected.exchange_symbol}</h2>
                      <span className="mono">{selected.instrument_id}</span>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Close instrument details"
                      onClick={closeInspector}
                    >
                      <X size={16} />
                    </button>
                  </header>
                  <div className="inspector-source">
                    <span>Snapshot {snapshot?.snapshot_id.slice(0, 14)}</span>
                    <span>
                      Source{" "}
                      {candles?.source_revision ||
                        snapshot?.source_revision ||
                        "—"}
                    </span>
                  </div>
                  <CandleChart candles={candles} />
                  <nav
                    className="inspector-tabs"
                    aria-label="Instrument detail tabs"
                  >
                    {(["signals", "context", "history", "notes"] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          className={detailTab === tab ? "selected" : ""}
                          onClick={() => setDetailTab(tab)}
                        >
                          {tab === "context"
                            ? "Liquidity & context"
                            : tab[0]!.toUpperCase() + tab.slice(1)}
                        </button>
                      ),
                    )}
                  </nav>
                  {detailTab === "signals" && (
                    <div className="metric-grid">
                      {metrics.map((meta) => {
                        const shown = metricDisplay(
                          instrument?.metrics[meta.id],
                        );
                        return (
                          <div
                            className="metric-card"
                            key={meta.id}
                            title={shown.title}
                          >
                            <small>{meta.id.replaceAll("_", " ")}</small>
                            <strong>{shown.text}</strong>
                            <span className={`status-${shown.status}`}>
                              {shown.status}
                              {instrument?.metrics[meta.id]?.sample_count
                                ? ` · ${instrument.metrics[meta.id].sample_count}/${instrument.metrics[meta.id].required_samples}`
                                : ""}
                            </span>
                          </div>
                        );
                      })}
                      <div className="provenance-card">
                        <strong>Descriptors</strong>
                        {Object.entries(instrument?.descriptors || {}).map(
                          ([id, descriptor]) => (
                            <small key={id}>
                              {id.replaceAll("_", " ")}:{" "}
                              {descriptor.status === "valid"
                                ? String(descriptor.value)
                                : descriptor.status}{" "}
                              {descriptor.reason_codes.join(" · ")}
                            </small>
                          ),
                        )}
                      </div>
                      <div className="provenance-card">
                        <strong>Why it matched</strong>
                        {selected.match_reasons.length ? (
                          <ul>
                            {selected.match_reasons.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        ) : (
                          <span>
                            No matching predicate reason was returned for this
                            row.
                          </span>
                        )}
                        <small>
                          Screen rank {selected.rank ?? "Unavailable"} ·
                          definition set {snapshot?.feature_set_version}
                        </small>
                      </div>
                    </div>
                  )}
                  {detailTab === "context" && (
                    <div className="context-list">
                      <h3>Available observations</h3>
                      <p>
                        Values come from the registered V2 source. Feature
                        availability follows the current server capability
                        response.
                      </p>
                      {metrics
                        .filter(
                          (item) =>
                            ![
                              "price",
                              "return_5m",
                              "return_15m",
                              "return_1h",
                              "return_24h",
                              "rsi_14",
                              "atr_pct_14",
                              "rvol_20",
                              "turnover_24h",
                            ].includes(item.id),
                        )
                        .map((item) => (
                          <div key={item.id}>
                            <span>{item.id.replaceAll("_", " ")}</span>
                            <strong>{item.availability}</strong>
                            <small>
                              {[
                                ...(item.reason_codes || []),
                                item.definition_id,
                                item.unit,
                              ].join(" · ")}
                            </small>
                          </div>
                        ))}
                      {ADVANCED_CAPABILITIES.slice(0, 5).map(
                        ([title, key, reason]) => (
                          <div key={key}>
                            <span>{title}</span>
                            <strong>Not advertised</strong>
                            <small>{reason}</small>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {detailTab === "history" && (
                    <div className="context-list">
                      <h3>Reconstructed history</h3>
                      <p>
                        Each record replays candle-only features as of that bar
                        close. These are not originally captured screener
                        rankings.
                      </p>
                      <span className="history-label">
                        <History size={14} />{" "}
                        {history?.kind || "candle_reconstruction"} ·{" "}
                        {history?.completeness || "unavailable"}
                      </span>
                      {history?.reason_codes?.length ? (
                        <small>{history.reason_codes.join(" · ")}</small>
                      ) : null}
                      {(history?.records || []).slice(-8).map((record) => (
                        <div key={record.record_id}>
                          <span>{new Date(record.as_of).toLocaleString()}</span>
                          <strong>{record.availability}</strong>
                          <small>
                            {Object.entries(record.metrics)
                              .filter(([id]) =>
                                ["price", "return_1h", "rsi_14"].includes(id),
                              )
                              .map(
                                ([id, value]) =>
                                  `${id}: ${metricDisplay(value).text}`,
                              )
                              .join(" · ") || "Metrics unavailable"}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                  {detailTab === "notes" && (
                    <div className="context-list">
                      <h3>Local note</h3>
                      <p>
                        Stored only in this browser for this user, server and
                        market scope.
                      </p>
                      <textarea
                        value={newNote}
                        onChange={(event) => setNewNote(event.target.value)}
                        maxLength={500}
                        placeholder="Add a private observation"
                      />
                      <label>
                        <input
                          type="checkbox"
                          checked={includeNotes}
                          onChange={(event) =>
                            setIncludeNotes(event.target.checked)
                          }
                        />{" "}
                        Include local notes in the research packet
                      </label>
                      <button
                        className="screen-button primary"
                        onClick={addNote}
                        disabled={
                          newNote.trim() ===
                          (storageData.notes.find(
                            (note) =>
                              note.instrument_id === selected.instrument_id,
                          )?.text || "")
                        }
                      >
                        Save note
                      </button>
                    </div>
                  )}
                  <footer className="inspector-footer">
                    {selected.native_registry_reference?.bot_name === bot &&
                    selected.native_registry_reference.controller_id ===
                      selected.controller_id &&
                    selected.native_registry_reference.source_id ===
                      snapshot?.source_id ? (
                      <Link
                        className="screen-button"
                        to={`/bots/${encodeURIComponent(bot || "")}`}
                      >
                        <ExternalLink size={13} /> Open registered bot
                      </Link>
                    ) : (
                      <span>
                        Bot destination unavailable: exact native registry
                        reference is missing.
                      </span>
                    )}
                    <button
                      className="screen-button"
                      disabled={isFrozen}
                      onClick={() => toggleWatch(selected.instrument_id)}
                    >
                      <Star size={14} />{" "}
                      {storageData.watchlist.includes(selected.instrument_id)
                        ? "Watching"
                        : "Add to watchlist"}
                    </button>
                    {visualSources.some(
                      (source) =>
                        source.bot === bot && source.server === server,
                    ) ? (
                      <Link
                        className="screen-button"
                        to={`/trading-visuals?${new URLSearchParams({ bot: bot || "", server: server || "", view: "charts", pair: selected.exchange_symbol })}`}
                      >
                        <ExternalLink size={13} /> Open pair chart
                      </Link>
                    ) : (
                      <span>
                        Pair chart unavailable: no exact Trading Visuals source
                        is registered for this owner and server.
                      </span>
                    )}
                  </footer>
                </aside>
              )}
            </div>

            {compareIds.length > 0 && (
              <section className="compare-panel">
                <header>
                  <div>
                    <strong>Compare instruments</strong>
                    <span>
                      Aligned screen snapshot · max 4 exact identities
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setCompareIds([])}
                    aria-label="Clear compare tray"
                  >
                    <X size={15} />
                  </button>
                </header>
                {normalizedComparison ? (
                  <div className="compare-chart">
                    <svg
                      viewBox="0 0 400 100"
                      role="img"
                      aria-label={`Common-time normalized comparison across ${normalizedComparison.timestamps.length} closed bars, rebased to 100`}
                    >
                      <line x1="0" y1="88" x2="400" y2="88" />
                      {normalizedComparison.values.map((values, index) => (
                        <polyline
                          key={compareIds[index]}
                          className={`compare-line compare-line-${index}`}
                          points={values
                            .map(
                              (y, point) =>
                                `${(point / Math.max(1, values.length - 1)) * 400},${y}`,
                            )
                            .join(" ")}
                        />
                      ))}
                    </svg>
                    <div>
                      {compareIds.map((id, index) => (
                        <span
                          key={id}
                          className={`compare-legend compare-line-${index}`}
                        >
                          {rows.find((row) => row.instrument_id === id)
                            ?.exchange_symbol || id}
                        </span>
                      ))}
                    </div>
                    <small>
                      Common timestamps only · each close rebased to 100 ·
                      source {snapshot?.source_revision}
                    </small>
                  </div>
                ) : (
                  compareIds.length > 1 && (
                    <p className="compare-wait">
                      Loading common-time candles, or fewer than two aligned
                      closed bars are available.
                    </p>
                  )
                )}
                <div className="compare-grid">
                  <div className="compare-labels">
                    <strong>Instrument</strong>
                    {metrics
                      .filter((item) =>
                        [
                          "price",
                          "return_5m",
                          "return_15m",
                          "return_1h",
                          "rsi_14",
                          "atr_pct_14",
                          "rvol_20",
                        ].includes(item.id),
                      )
                      .map((item) => (
                        <span key={item.id}>{item.id}</span>
                      ))}
                  </div>
                  {compareIds.map((id) => {
                    const row = rows.find((item) => item.instrument_id === id);
                    return row ? (
                      <div className="compare-column" key={id}>
                        <strong>{row.exchange_symbol}</strong>
                        {metrics
                          .filter((item) =>
                            [
                              "price",
                              "return_5m",
                              "return_15m",
                              "return_1h",
                              "rsi_14",
                              "atr_pct_14",
                              "rvol_20",
                            ].includes(item.id),
                          )
                          .map((item) => (
                            <span
                              key={item.id}
                              title={row.metrics[item.id]?.definition_id}
                            >
                              {metricDisplay(row.metrics[item.id]).text}
                            </span>
                          ))}
                      </div>
                    ) : null;
                  })}
                </div>
                <small>
                  Values remain independent by venue, quote asset, interval and
                  source lineage. No correlation is inferred without a qualified
                  aligned history sample.
                </small>
              </section>
            )}

            <section className="capability-catalog">
              <header>
                <div>
                  <strong>Source capability catalog</strong>
                  <span>
                    Each status is taken from the selected native source
                    contract.
                  </span>
                </div>
                <ChevronRight size={15} />
              </header>
              <div className="capability-grid">
                {metrics.find((item) => item.id === "breadth_positive_24h") && (
                  <article>
                    <div>
                      <Waves size={14} />
                      <strong>Same-source return breadth</strong>
                    </div>
                    <span>
                      {
                        metrics.find(
                          (item) => item.id === "breadth_positive_24h",
                        )?.availability
                      }
                    </span>
                    <p>
                      Fraction of this exact subscribed OKX/USDC universe with a
                      valid positive 24h return; not exchange-wide breadth.
                    </p>
                  </article>
                )}
                {ADVANCED_CAPABILITIES.map(([title, key, reason]) => {
                  const metricId =
                    key === "requires_book_trade" ? "spread_bps" : key;
                  const advertised = metrics.find(
                    (metric) => metric.id === metricId,
                  );
                  return (
                    <article key={key}>
                      <div>
                        <Eye size={14} />
                        <strong>{title}</strong>
                      </div>
                      <span>
                        {advertised?.availability || "Not advertised"}
                      </span>
                      <p>{advertised?.reason_codes?.join(" · ") || reason}</p>
                    </article>
                  );
                })}
              </div>
            </section>
            {busy && !snapshot && (
              <div className="screener-loading" role="status">
                <RefreshCw className="spin" size={16} /> Loading recorded market
                observations…
              </div>
            )}
            {capabilities && (
              <p className="screener-disclaimer">
                Screen matches describe recorded market observations; they do
                not represent a controller decision or permission to trade.{" "}
                <ExternalLink size={12} />
              </p>
            )}
          </>
        )}
    </section>
  );
}
