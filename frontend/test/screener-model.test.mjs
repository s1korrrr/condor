import test from "node:test";
import assert from "node:assert/strict";
import {
  csvEscape,
  makeResearchPacket,
  makeViewUrl,
  metricSortValue,
  parseViewParams,
  scopeKey,
  snapshotCsv,
  storageRead,
  storageScopeKey,
  storageWrite,
  matchTransitions,
  formatDisplayNumber,
  removeFilterPredicate,
} from "../src/features/screener/model.mjs";

const metric = (value, status = "valid") => ({
  value,
  status,
  unit: "percent",
  definition_id: "return_1h",
  definition_version: "1",
  source_id: "reader",
  observed_at: "2026-09-28T12:00:00Z",
});
const row = (id, value, status = "valid") => ({
  instrument_id: `okx:spot:${id}-USDC`,
  metrics: { return_1h: metric(value, status) },
});

test("nonzero small prices and ratios are never displayed as a measured zero", () => {
  assert.notEqual(formatDisplayNumber("0.000000123"), "0");
  assert.notEqual(formatDisplayNumber("-0.000000123"), "0");
  assert.equal(formatDisplayNumber("0"), "0");
  assert.equal(formatDisplayNumber(null), "—");
  assert.equal(formatDisplayNumber("NaN"), "—");
});

test("heatmap metric values exclude nonfinite and unavailable measurements", () => {
  assert.equal(metricSortValue(metric("NaN")), null);
  assert.equal(metricSortValue(metric("2", "stale")), null);
  assert.equal(metricSortValue(metric("0")), 0);
});

test("saved state validates every row and malformed persisted values never reach rendering", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(
    storageWrite(storage, "scope", {
      views: [],
      watchlist: ["okx:spot:BTC-USDC"],
      notes: [],
    }),
    null,
  );
  assert.equal(
    storageRead(storage, "scope").value.watchlist[0],
    "okx:spot:BTC-USDC",
  );
  store.set(
    "scope",
    JSON.stringify({ version: 1, views: [null], watchlist: [], notes: [] }),
  );
  assert.equal(storageRead(storage, "scope").value, null);
  assert.match(
    storageRead(
      {
        getItem() {
          throw Error("denied");
        },
        setItem() {},
      },
      "scope",
    ).error,
    /unavailable/i,
  );
});

test("removing the final screener predicate restores the unfiltered query", () => {
  assert.equal(removeFilterPredicate({ op: "and", predicates: [{ metric: "rsi_14", operator: "lte", value: "30" }] }, 0), null);
  assert.deepEqual(removeFilterPredicate({ op: "or", predicates: [1, 2] }, 0), { op: "or", predicates: [2] });
});

test("local storage is isolated by user, server, owner, lane, quote and interval", () => {
  assert.notEqual(
    scopeKey("u1", "server", "owner", "spot", "USDC", "1m"),
    scopeKey("u2", "server", "owner", "spot", "USDC", "1m"),
  );
  assert.notEqual(
    scopeKey("u1", "server", "owner", "spot", "USDC", "1m"),
    scopeKey("u1", "server", "owner", "spot", "USDC", "5m"),
  );
  assert.notEqual(
    scopeKey("u1", "server", "owner", "spot", "USDC", "1m"),
    scopeKey("u1", "server", "owner", "spot", "USDT", "1m"),
  );
});

test("saved state uses one user and source scope across observation intervals", () => {
  assert.equal(
    storageScopeKey("u", "server", "owner", "spot", "USDC"),
    storageScopeKey("u", "server", "owner", "spot", "USDC"),
  );
  assert.notEqual(
    storageScopeKey("u", "server", "owner", "spot", "USDC"),
    storageScopeKey("u", "server", "other-owner", "spot", "USDC"),
  );
});

test("share links are bounded and reject unknown metrics, operators and malformed JSON", () => {
  const url = makeViewUrl({
    screen: "rsi_low",
    interval: "5m",
    search: "BTC",
    filters: {
      op: "and",
      predicates: [{ metric: "rsi_14", operator: "lte", value: "30" }],
    },
  });
  assert.deepEqual(parseViewParams(url.slice(url.indexOf("?"))).value, {
    screen: "rsi_low",
    interval: "5m",
    search: "BTC",
    filters: {
      op: "and",
      predicates: [{ metric: "rsi_14", operator: "lte", value: "30" }],
    },
  });
  assert.ok(parseViewParams("?screen=unknown").error);
  assert.ok(parseViewParams("?filters=%7B").error);
  const bad = new URLSearchParams({
    filters: JSON.stringify({
      op: "and",
      predicates: [{ metric: "sql", operator: "execute", value: "1" }],
    }),
  });
  assert.ok(parseViewParams(`?${bad}`).error);
});

test("CSV protects formula-leading text and preserves signed decimal cells", () => {
  assert.equal(csvEscape("=1+1"), '"\'=1+1"');
  assert.equal(csvEscape("-12.5"), '\"-12.5\"');
  assert.equal(csvEscape("-cmd"), '\"\'-cmd\"');
  const csv = snapshotCsv({
    rows: [
      {
        rank: 1,
        instrument_id: "okx:spot:BTC-USDC",
        venue: "okx",
        lane: "spot",
        exchange_symbol: "BTC-USDC",
        base_asset: "BTC",
        quote_asset: "USDC",
        match_reasons: [],
        metrics: { return_1h: metric("-2.5") },
      },
    ],
  });
  assert.match(csv, /"-2\.5"/);
  assert.match(csv, /source_id/);
});

test("research packet declares descriptive intent and excludes personal notes", () => {
  const packet = makeResearchPacket(
    {
      snapshot_id: "s1",
      query_hash: "q",
      source_id: "reader",
      source_revision: "r1",
      universe_id: "u",
      universe_revision: "u1",
      generated_at: "t",
      observed_at: "t",
      counts: { matched: 1 },
      market_context: {
        source: { subscribed_count: 5 },
        breadth: { denominator: 5 },
      },
      rows: [],
    },
    { screen: "all", interval: "1m" },
    { instrument_id: "okx:spot:BTC-USDC", note: "private" },
  );
  assert.equal(packet.execution_authorized, false);
  assert.equal(packet.intent, "descriptive_screen_export_only");
  assert.equal("personal_notes" in packet, false);
  assert.equal(packet.selected_instrument, null);
  assert.deepEqual(packet.market_context, {
    source: { subscribed_count: 5 },
    breadth: { denominator: 5 },
  });
});

test("research export preserves the complete query and only explicitly included annotations", () => {
  const selected = {
    instrument_id: "okx:spot:BTC-USDC",
    metrics: { price: metric("123.000000000000000001") },
  };
  const snapshot = {
    snapshot_id: "s",
    feature_set_version: "v1",
    rows: [selected],
  };
  const query = {
    server: "V2",
    bot: "owner",
    screen: "watchlist",
    interval: "5m",
    search: "BTC",
    sort: "price",
    direction: "asc",
    filters: null,
    watchlist_ids: [selected.instrument_id],
  };
  const result = makeResearchPacket(snapshot, query, selected, [
    { instrument_id: selected.instrument_id, text: "explicitly included" },
  ]);
  assert.deepEqual(result.query, query);
  assert.equal(result.feature_set_version, "v1");
  assert.equal(
    result.selected_instrument.metrics.price.value,
    "123.000000000000000001",
  );
  assert.equal(result.annotations[0].text, "explicitly included");
});

test("shared views preserve exact source and sort and reject widening malformed scope", () => {
  const view = {
    screen: "all",
    interval: "1m",
    search: "",
    filters: null,
    server: "Screener verification",
    bot: "rsi_modular_v2",
    sort: "price",
    direction: "asc",
  };
  assert.deepEqual(
    parseViewParams(makeViewUrl(view).split("?")[1]).value,
    view,
  );
  assert.ok(parseViewParams("?screen=all&screen=rsi_low").error);
  assert.ok(parseViewParams("?server=V2&bot=../owner").error);
  assert.ok(parseViewParams("?url=https://example.com").error);
  assert.ok(parseViewParams("?interval=1h").error);
});

test("local transitions never call outages, incomplete pages or stale rows market exits", () => {
  const before = {
    source_id: "reader",
    query_hash: "q",
    completeness: "complete",
    counts: { matched: 2, stale: 0 },
    rows: [
      { ...row("AA", "1"), exchange_symbol: "AA-USDC" },
      { ...row("BB", "1"), exchange_symbol: "BB-USDC" },
    ],
  };
  const after = {
    ...before,
    counts: { matched: 1, stale: 0 },
    rows: before.rows.slice(0, 1),
  };
  assert.deepEqual(matchTransitions(before, after), [
    { kind: "left", instrumentId: "okx:spot:BB-USDC", symbol: "BB-USDC" },
  ]);
  assert.deepEqual(
    matchTransitions(before, { ...after, completeness: "partial" }),
    [],
  );
  assert.deepEqual(
    matchTransitions(before, { ...after, next_cursor: "more" }),
    [],
  );
  assert.deepEqual(
    matchTransitions(before, { ...after, counts: { matched: 500, stale: 0 } }),
    [],
  );
  assert.deepEqual(
    matchTransitions(before, { ...after, counts: { matched: 1, stale: 1 } }),
    [],
  );
});

test("missing timestamps and outages cannot claim current observations", async () => {
  const { snapshotFreshness } =
    await import("../src/features/screener/model.mjs");
  const now = Date.parse("2026-09-28T15:00:00Z");
  const row = { completeness: "complete", observed_at: null };
  assert.match(snapshotFreshness(row, now, 60000), /Freshness unavailable/);
  assert.match(
    snapshotFreshness({ ...row, observed_at: "invalid" }, now, 60000),
    /Freshness unavailable/,
  );
  assert.equal(
    snapshotFreshness(
      { ...row, observed_at: "2026-09-28T15:00:00Z" },
      now,
      60000,
    ),
    "Recorded candles",
  );
  assert.match(
    snapshotFreshness(
      { ...row, observed_at: "2026-09-28T15:00:00Z" },
      now,
      60000,
      true,
    ),
    /Read failed/,
  );
  assert.equal(
    snapshotFreshness(
      { ...row, observed_at: "2026-09-28T14:58:49Z" },
      now,
      60000,
    ),
    "Stale",
  );
  assert.match(
    snapshotFreshness(
      { ...row, observed_at: "2026-09-28T14:57:59Z" },
      now,
      60000,
    ),
    /aged out/,
  );
  assert.equal(
    snapshotFreshness(
      { completeness: "partial", observed_at: "2026-09-28T14:58:49Z" },
      now,
      60000,
    ),
    "Stale · partial coverage",
  );
});

test("loss of source quality is never reported as a match transition", () => {
  const before = {
    source_id: "reader",
    query_hash: "q",
    completeness: "complete",
    counts: { matched: 1, stale: 0, warming: 0, invalid: 0, unavailable: 0 },
    rows: [{ ...row("BTC", "1"), exchange_symbol: "BTC-USDC" }],
  };
  for (const status of ["unavailable", "invalid", "warming"]) {
    const after = {
      ...before,
      counts: { ...before.counts, matched: 0, [status]: 1 },
      rows: [],
    };
    assert.deepEqual(matchTransitions(before, after), [], status);
    assert.deepEqual(matchTransitions(after, before), [], status + " recovery");
  }
});

test("persisted state rejects oversized collections and foreign quote identities", () => {
  const read = (value) =>
    storageRead(
      {
        getItem: () =>
          JSON.stringify({
            version: 1,
            views: [],
            watchlist: [],
            notes: [],
            ...value,
          }),
      },
      "scope",
    );
  assert.equal(
    read({
      watchlist: Array.from({ length: 251 }, (_, i) => `okx:spot:T${i}-USDC`),
    }).value,
    null,
  );
  assert.equal(read({ watchlist: ["okx:spot:BTC-USDT"] }).value, null);
  assert.equal(
    read({
      notes: [
        {
          instrument_id: "okx:spot:BTC-USDC",
          text: "x".repeat(501),
          updated_at: "2026-09-28T12:00:00Z",
        },
      ],
    }).value,
    null,
  );
  assert.equal(
    read({ watchlist: ["okx:spot:A-USDC"] }).value.watchlist[0],
    "okx:spot:A-USDC",
  );
});
