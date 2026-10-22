"""Pure push detectors: what is announced, once, and what is deliberately silent."""

from decimal import Decimal

import pytest

from condor.push import events as ev
from tests.push_support import executor_row, fill_row

NOW = 1_790_001_000.0
STARTED = 1_790_000_000.0
V2 = ev.SourceInfo("k" * 64, "rsi_modular_v2", "V2", "USDT")
V1 = ev.SourceInfo("j" * 64, "ok_rsi", "V1", "USDT")
NEVER = lambda key: False  # noqa: E731


# ------------------------------------------------------------------ labels, links, contract


def test_bot_tags_use_v1_v2_v3_labels_then_version_suffix_then_display_name():
    assert ev.bot_tag("ok_rsi") == "V1"
    assert ev.bot_tag("rsi_modular_v2") == "V2"
    assert ev.bot_tag("meridian_v3") == "V3"
    assert ev.bot_tag("breakout_v4") == "V4"
    assert ev.bot_tag("breakout", "Breakout Paper") == "Breakout Paper"
    assert ev.bot_tag("breakout", labels={"breakout": "BRK"}) == "BRK"


def test_paper_bot_tags_always_say_paper_whatever_the_label_source():
    assert ev.bot_tag("meridian_v4_paper") == "V4 PAPER"
    assert ev.bot_tag("meridian_v4_paper", "V4 paper") == "V4 PAPER"
    assert ev.bot_tag("meridian_v4_d2h_paper", "V4 D2h paper") == "V4 D2h PAPER"
    assert ev.bot_tag("meridian_v4_d2h_paper") == "meridian_v4_d2h PAPER"
    # A configured label cannot hide the paper mark.
    assert (
        ev.bot_tag("meridian_v4_paper", labels={"meridian_v4_paper": "V4"})
        == "V4 PAPER"
    )
    assert ev.bot_tag("paper") == "Bot PAPER"
    # Only a whole "paper" token marks a bot paper.
    assert ev.bot_tag("papermill_v2") == "V2"


def test_a_paper_bots_fill_push_is_titled_paper():
    paper = ev.SourceInfo(
        "p" * 64,
        "meridian_v4_paper",
        ev.bot_tag("meridian_v4_paper", "V4 paper"),
        "USDT",
        paper=True,
    )
    detection = ev.detect_fills(
        paper, [fill_row("f1", "o1", side="buy")], started=STARTED, seen=NEVER
    )
    (entry,) = detection.events
    assert entry.title == "V4 PAPER · BUY BNB-USDT" and entry.bot_tag == "V4 PAPER"


def test_deep_links_are_validated_not_interpolated():
    assert ev.link("fills", "meridian_v3") == "rsibot://bot/meridian_v3/fills"
    assert ev.link("operations") == "rsibot://operations"
    for bad_bot in ("../x", "a/b", "", "a b"):
        with pytest.raises(ValueError):
            ev.link("fills", bad_bot)
    with pytest.raises(ValueError):
        ev.link("trade", "ok_rsi")  # no trading section exists


def test_interruption_levels_never_use_critical_alerts():
    levels = {s: ev.interruption_level(s) for s in ev.SEVERITIES}
    assert levels == {
        "info": "passive",
        "notice": "active",
        "warning": "time-sensitive",
        "critical": "time-sensitive",
    }
    assert "critical" not in set(levels.values())


def test_event_contract_rejects_oversized_collapse_key_and_foreign_links():
    base = dict(
        id="x",
        cls="fill_entry",
        severity="notice",
        title="t",
        body="b",
        deep_link="rsibot://operations",
        collapse_key="c",
        thread_id="t",
        occurred_at=1.0,
    )
    ev.AlertEvent(**base)
    for change in (
        {"collapse_key": "c" * 65},
        {"deep_link": "https://evil.example"},
        {"cls": "trade"},
        {"severity": "urgent"},
    ):
        with pytest.raises(ValueError):
            ev.AlertEvent(**{**base, **change})
    event = ev.AlertEvent(**base)
    assert ev.AlertEvent.from_dict(event.to_dict()) == event


def test_default_classes_make_summary_and_market_opt_in():
    defaults = ev.default_classes()
    assert defaults["summary"] is False and defaults["market"] is False
    assert all(
        defaults[c]
        for c in ("fill_entry", "fill_exit", "bag", "risk", "health", "incident")
    )


# ------------------------------------------------------------------ fills


def test_buy_and_sell_fills_are_distinct_classes_with_bot_tag_and_thread():
    rows = [
        fill_row("f1", "o1", side="buy"),
        fill_row("f2", "o2", side="sell", amount="0.25", price="610"),
    ]
    detection = ev.detect_fills(V2, rows, started=STARTED, seen=NEVER)
    by_kind = {e.kind: e for e in detection.events}
    assert by_kind["entry"].cls == "fill_entry" and by_kind["exit"].cls == "fill_exit"
    entry = by_kind["entry"]
    assert entry.title == "V2 · BUY BNB-USDT"
    assert entry.body == "Entry filled 0.5 BNB @ 600 · 300.00 USDT · fee 0.3 USDT"
    assert entry.thread_id == "bot:rsi_modular_v2" and entry.bot_tag == "V2"
    assert entry.deep_link == "rsibot://bot/rsi_modular_v2/fills"
    assert by_kind["exit"].body.startswith("Exit filled 0.25 BNB @ 610")
    assert len(detection.seen) == 2


def test_partial_fills_of_one_order_group_and_share_a_collapse_key():
    first = ev.detect_fills(
        V2, [fill_row("f1", "o1", amount="0.2")], started=STARTED, seen=NEVER
    )
    both = ev.detect_fills(
        V2,
        [
            fill_row("f1", "o1", amount="0.2"),
            fill_row("f2", "o1", amount="0.3", timestamp=1_790_000_101.0),
        ],
        started=STARTED,
        seen=NEVER,
    )
    assert len(both.events) == 1 and "0.5 BNB" in both.events[0].body
    later = ev.detect_fills(
        V2,
        [fill_row("f2", "o1", amount="0.3")],
        started=STARTED,
        seen=lambda k: k in set(first.seen),
    )
    assert len(later.events) == 1
    assert (
        first.events[0].collapse_key == later.events[0].collapse_key
    )  # replaces on the device
    assert first.events[0].id != later.events[0].id


def test_a_seen_fill_is_never_announced_again():
    rows = [fill_row("f1", "o1")]
    first = ev.detect_fills(V2, rows, started=STARTED, seen=NEVER)
    again = ev.detect_fills(
        V2, rows, started=STARTED, seen=lambda k: k in set(first.seen)
    )
    assert again.events == () and again.seen == ()


def test_history_older_than_activation_is_recorded_but_never_announced():
    old = fill_row("old", "o0", timestamp=STARTED - 5)
    detection = ev.detect_fills(
        V2, [old, fill_row("new", "o1")], started=STARTED, seen=NEVER
    )
    assert [e.kind for e in detection.events] == ["entry"] and len(detection.seen) == 2


def test_v1_legacy_rows_before_activation_cannot_block_new_fills():
    legacy = fill_row("l1", "o0", bot="ok_rsi", timestamp=STARTED - 86400)
    legacy.update(
        exact_amount=None,
        exact_price=None,
        exact_trade_fee_in_quote=None,
        amount_base=0.5,
        price_quote=600.0,
    )
    detection = ev.detect_fills(
        V1, [legacy, fill_row("n1", "o9", bot="ok_rsi")], started=STARTED, seen=NEVER
    )
    assert len(detection.events) == 1 and detection.events[0].title.startswith(
        "V1 · BUY"
    )


def test_a_post_activation_row_without_exact_economics_fails_closed():
    bad = fill_row("f1", "o1")
    bad.update(exact_amount=None, exact_price=None)
    with pytest.raises(ValueError):
        ev.detect_fills(V2, [fill_row("ok", "o0"), bad], started=STARTED, seen=NEVER)


@pytest.mark.parametrize(
    "field",
    ["fill_id", "order_id", "bot_name", "connector_name", "source_db_id", "pair"],
)
def test_an_incomplete_fill_identity_rejects_the_whole_batch(field):
    bad = fill_row("f1", "o1")
    bad[field] = ""
    with pytest.raises(ValueError):
        ev.detect_fills(V2, [fill_row("ok", "o0"), bad], started=STARTED, seen=NEVER)


def test_a_full_history_that_never_reaches_activation_is_a_coverage_gap():
    rows = [fill_row(f"f{i}", f"o{i}", timestamp=STARTED + 10 + i) for i in range(5)]
    with pytest.raises(ValueError, match="coverage"):
        ev.detect_fills(V2, rows, started=STARTED, seen=NEVER, limit=5)
    # A known fill inside the window proves continuity.
    first = ev.detect_fills(V2, rows[:1], started=STARTED, seen=NEVER)
    ev.detect_fills(
        V2, rows, started=STARTED, seen=lambda k: k in set(first.seen), limit=5
    )


def test_missing_fee_is_omitted_not_invented():
    detection = ev.detect_fills(V2, [fill_row(fee=None)], started=STARTED, seen=NEVER)
    assert "fee" not in detection.events[0].body


def test_duplicate_rows_in_one_batch_count_once():
    row = fill_row()
    detection = ev.detect_fills(V2, [row, dict(row)], started=STARTED, seen=NEVER)
    assert len(detection.events) == 1 and len(detection.seen) == 1


# ------------------------------------------------------------------ bags


def test_new_held_bag_after_activation_is_announced_once():
    rows = [executor_row("e1", close_type="10", closed_at=STARTED + 50)]
    first = ev.detect_executors(V2, rows, started=STARTED, seen=NEVER, primed=True)
    assert [e.kind for e in first.events] == ["held"]
    assert (
        first.events[0].cls == "bag"
        and "retained as a held bag" in first.events[0].body
    )
    again = ev.detect_executors(
        V2, rows, started=STARTED, seen=lambda k: k in set(first.seen), primed=True
    )
    assert again.events == ()


def test_bags_held_before_activation_are_silent_but_recorded():
    rows = [executor_row("old", close_type="POSITION_HOLD", closed_at=STARTED - 10)]
    detection = ev.detect_executors(V2, rows, started=STARTED, seen=NEVER, primed=True)
    assert detection.events == () and detection.seen == ("bag:old",)


def test_trailing_armed_is_silent_on_the_first_snapshot_then_announces_transitions():
    armed = executor_row("e1", status="active", close_type=None, trailing_state="armed")
    first = ev.detect_executors(V2, [armed], started=STARTED, seen=NEVER, primed=False)
    assert first.events == () and first.seen == ("trail:e1",) and first.primed
    known = set(first.seen)
    waiting = executor_row(
        "e2", status="active", close_type=None, trailing_state="pending"
    )
    quiet = ev.detect_executors(
        V2, [armed, waiting], started=STARTED, seen=known.__contains__, primed=True
    )
    assert (
        quiet.events == () and quiet.seen == ()
    )  # pending is not armed; e1 is already known
    now_armed = executor_row(
        "e2", status="active", close_type=None, trailing_state="armed"
    )
    announced = ev.detect_executors(
        V2, [armed, now_armed], started=STARTED, seen=known.__contains__, primed=True
    )
    assert [e.kind for e in announced.events] == ["trailing_armed"]
    assert "Trigger 612.5" in announced.events[0].body


def test_executor_rows_without_a_safe_identity_are_skipped_not_guessed():
    rows = [
        executor_row(""),
        {**executor_row("e9"), "pair": "BNBUSDT"},
        executor_row("e1", closed_at=STARTED + 5),
    ]
    detection = ev.detect_executors(V2, rows, started=STARTED, seen=NEVER, primed=True)
    assert detection.skipped == 2 and len(detection.events) == 1


def test_close_type_names_follow_the_native_enum():
    assert ev.close_type_name("10") == "POSITION_HOLD"
    assert ev.close_type_name("CloseType.POSITION_HOLD") == "POSITION_HOLD"
    assert ev.close_type_name(None) is None and ev.close_type_name(True) is None


# ------------------------------------------------------------------ risk rails


def _runtime(**daily):
    return {
        "runtime_status": {
            "updated_at": NOW - 5,
            "daily_entry_risk": {
                "limit_quote": "50",
                "baseline_quote": "10",
                "last_pnl_quote": "-45",
                "utc_day": ev._today_number(
                    NOW
                ),  # the engine publishes an integer day number
                **daily,
            },
        }
    }


def test_utc_day_is_an_integer_day_number_and_iso_dates_are_accepted_too():
    assert ev.day_number(20720) == 20720 and ev.day_number(20720.0) == 20720
    assert ev.day_number("2026-09-24") == 20720 and ev.day_number("20720") == 20720
    for bad in (None, True, "tomorrow", 1.5, [], "99999999"):
        assert ev.day_number(bad) is None
    assert ev._day_label(20720) == "2026-09-24"


def test_daily_loss_pause_announces_once_per_utc_day_with_usage():
    day = ev._today_number(NOW)
    payload = _runtime(paused=True, utc_day=day)
    detection = ev.detect_risk(V2, payload, now=NOW, seen=NEVER, stale_seconds=300)
    event = detection.events[0]
    assert (
        event.cls == "risk"
        and event.severity == "warning"
        and "entries are paused" in event.body
    )
    assert (
        "Used 55.00 of 50.00 USDT" in event.body
        and f"UTC {ev._day_label(day)}" in event.body
    )
    again = ev.detect_risk(
        V2, payload, now=NOW, seen=lambda k: k in set(detection.seen), stale_seconds=300
    )
    assert again.events == ()


def test_risk_rail_is_silent_for_old_days_stale_status_or_malformed_data():
    day = ev._today_number(NOW)
    assert (
        ev.detect_risk(
            V2,
            _runtime(paused=True, utc_day=day - 1),
            now=NOW,
            seen=NEVER,
            stale_seconds=300,
        ).events
        == ()
    )
    stale = _runtime(paused=True, utc_day=day)
    stale["runtime_status"]["updated_at"] = NOW - 900
    assert (
        ev.detect_risk(V2, stale, now=NOW, seen=NEVER, stale_seconds=300).events == ()
    )
    assert (
        ev.detect_risk(
            V2,
            {"runtime_status": {"updated_at": NOW}},
            now=NOW,
            seen=NEVER,
            stale_seconds=300,
        ).events
        == ()
    )
    assert (
        ev.detect_risk(
            V2,
            _runtime(paused=False, breach_day=None, utc_day=day),
            now=NOW,
            seen=NEVER,
            stale_seconds=300,
        ).events
        == ()
    )
    assert ev.detect_risk(V2, None, now=NOW, seen=NEVER, stale_seconds=300).events == ()


def test_risk_rail_accepts_an_iso_day_and_a_breach_day_without_a_pause_flag():
    iso = _runtime(paused=True, utc_day=ev._utc_day(NOW))
    assert (
        len(ev.detect_risk(V2, iso, now=NOW, seen=NEVER, stale_seconds=300).events) == 1
    )
    breached = _runtime(paused=False, breach_day=ev._today_number(NOW))
    event = ev.detect_risk(V2, breached, now=NOW, seen=NEVER, stale_seconds=300).events[
        0
    ]
    assert (
        "paused" not in event.body
    )  # the rail was breached; do not claim entries are paused
    unknown_day = _runtime(paused=True, utc_day="someday")
    assert (
        ev.detect_risk(V2, unknown_day, now=NOW, seen=NEVER, stale_seconds=300).events
        == ()
    )


# ------------------------------------------------------------------ health conditions


def test_a_condition_opens_only_after_confirmation_and_resolves_only_after_recovery():
    state, change = ev.step_condition(
        None, "k", True, 0, confirm_seconds=60, recover_seconds=30
    )
    assert change is None and state is not None and not state.open
    state, change = ev.step_condition(
        state, "k", True, 59, confirm_seconds=60, recover_seconds=30
    )
    assert change is None
    state, change = ev.step_condition(
        state, "k", True, 60, confirm_seconds=60, recover_seconds=30
    )
    assert change == "opened" and state.open
    state, change = ev.step_condition(
        state, "k", True, 90, confirm_seconds=60, recover_seconds=30
    )
    assert change is None  # one episode, one alert
    state, change = ev.step_condition(
        state, "k", False, 100, confirm_seconds=60, recover_seconds=30
    )
    assert change is None and state.clear_since == 100
    state, change = ev.step_condition(
        state, "k", True, 110, confirm_seconds=60, recover_seconds=30
    )
    assert change is None and state.clear_since is None  # a relapse restarts recovery
    state, change = ev.step_condition(
        state, "k", False, 120, confirm_seconds=60, recover_seconds=30
    )
    state, change = ev.step_condition(
        state, "k", False, 150, confirm_seconds=60, recover_seconds=30
    )
    assert change == "resolved" and state is None


def test_a_blip_that_clears_before_confirmation_never_alerts():
    state, _ = ev.step_condition(
        None, "k", True, 0, confirm_seconds=60, recover_seconds=30
    )
    state, change = ev.step_condition(
        state, "k", False, 10, confirm_seconds=60, recover_seconds=30
    )
    assert state is None and change is None


def _health(
    now,
    *,
    conditions,
    runtime_age=0,
    runtime_ok=True,
    status=None,
    thresholds=ev.HealthThresholds(confirm_seconds=60),
):
    runtime = (
        {"runtime_status": {"updated_at": now - runtime_age}} if runtime_ok else None
    )
    payload = {"status": status} if status else None
    events, changes = ev.evaluate_health(
        V2,
        now=now,
        thresholds=thresholds,
        runtime_payload=runtime,
        runtime_ok=runtime_ok,
        status_payload=payload,
        conditions=conditions,
    )
    merged = dict(conditions)
    for key, value in changes.items():
        merged.pop(key, None) if value is None else merged.__setitem__(key, value)
    return events, merged


def test_owner_offline_is_critical_after_confirmation_then_recovers_and_replaces_the_alert():
    conditions: dict = {}
    events, conditions = _health(1000, conditions=conditions, status="disconnected")
    assert events == ()
    events, conditions = _health(1061, conditions=conditions, status="disconnected")
    opened = events[0]
    assert (opened.cls, opened.severity, opened.kind) == (
        "health",
        "critical",
        "offline",
    )
    assert opened.title == "V2 · Owner offline" and opened.deep_link.endswith("/health")
    events, conditions = _health(1100, conditions=conditions, status="running")
    assert events == ()
    events, conditions = _health(1230, conditions=conditions, status="running")
    recovered = events[0]
    assert recovered.severity == "info" and recovered.kind == "offline_resolved"
    assert recovered.collapse_key == opened.collapse_key and recovered.id != opened.id
    assert conditions == {}


def test_lifecycle_invalid_and_stale_status_are_warnings_and_unknown_status_is_silent():
    conditions: dict = {}
    _, conditions = _health(
        1000, conditions=conditions, status="lifecycle_unavailable", runtime_age=900
    )
    events, conditions = _health(
        1100, conditions=conditions, status="lifecycle_unavailable", runtime_age=900
    )
    kinds = {e.kind: e.severity for e in events}
    assert kinds == {"lifecycle": "warning", "stale": "warning"}
    quiet, _ = _health(5000, conditions={}, status="something_new")
    quiet2, _ = _health(5100, conditions={}, status="something_new")
    assert quiet == () and quiet2 == ()


def test_an_unreadable_source_is_its_own_condition_and_never_reads_as_stale_or_healthy():
    thresholds = ev.HealthThresholds(confirm_seconds=60, unreadable_seconds=120)
    conditions: dict = {}
    _, conditions = _health(
        1000, conditions=conditions, runtime_ok=False, thresholds=thresholds
    )
    events, conditions = _health(
        1119, conditions=conditions, runtime_ok=False, thresholds=thresholds
    )
    assert events == ()
    events, conditions = _health(
        1121, conditions=conditions, runtime_ok=False, thresholds=thresholds
    )
    assert [e.kind for e in events] == ["unreadable"]


def test_future_dated_owner_clock_is_not_staleness():
    events, conditions = _health(1000, conditions={}, runtime_age=-400)
    assert events == () and not any("stale" in k for k in conditions)


# ------------------------------------------------------------------ incidents


def _store(*incidents, state="available"):
    return {"state": state, "incidents": list(incidents)}


def _incident(
    id="inc1", severity="critical", state="open", first=STARTED + 10, **extra
):
    base = {
        "id": id,
        "service": "execution-rsi",
        "severity": severity,
        "state": state,
        "code": "service_unhealthy",
        "title": "execution-rsi unhealthy",
        "detail": "container restarting",
        "first_seen_at": _iso(first),
        "last_seen_at": _iso(first),
        "resolved_at": None,
        "count": 1,
        "notification_status": "sent",
        "acknowledged": False,
    }
    return {**base, **extra}


def _iso(epoch):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def test_open_critical_incident_announces_once_and_recovery_replaces_it():
    store = _store(_incident())
    first = ev.detect_incidents(store, started=STARTED, seen=NEVER)
    opened = first.events[0]
    assert (opened.cls, opened.severity, opened.deep_link) == (
        "incident",
        "critical",
        "rsibot://operations",
    )
    assert (
        opened.title == "execution-rsi · execution-rsi unhealthy"
        and opened.thread_id == "stack"
    )
    seen = set(first.seen)
    assert (
        ev.detect_incidents(store, started=STARTED, seen=seen.__contains__).events == ()
    )
    resolved = _store(_incident(state="resolved", resolved_at=_iso(STARTED + 100)))
    done = ev.detect_incidents(resolved, started=STARTED, seen=seen.__contains__)
    assert (
        done.events[0].kind == "incident_resolved"
        and done.events[0].collapse_key == opened.collapse_key
    )
    seen.update(done.seen)
    assert (
        ev.detect_incidents(resolved, started=STARTED, seen=seen.__contains__).events
        == ()
    )


def test_incidents_below_floor_or_before_activation_or_unannounced_recoveries_stay_silent():
    warning = _store(_incident("w1", severity="warning"))
    assert ev.detect_incidents(warning, started=STARTED, seen=NEVER).events == ()
    assert [
        e.severity
        for e in ev.detect_incidents(
            warning, started=STARTED, seen=NEVER, min_severity="warning"
        ).events
    ] == ["warning"]
    old = _store(_incident("o1", first=STARTED - 100))
    assert ev.detect_incidents(old, started=STARTED, seen=NEVER).events == ()
    unseen_recovery = _store(
        _incident("r1", state="resolved", resolved_at=_iso(STARTED + 5))
    )
    assert (
        ev.detect_incidents(unseen_recovery, started=STARTED, seen=NEVER).events == ()
    )


def test_a_stale_or_malformed_incident_store_is_not_acted_on():
    assert (
        ev.detect_incidents(
            _store(_incident(), state="unavailable"), started=STARTED, seen=NEVER
        ).events
        == ()
    )
    assert (
        ev.detect_incidents(
            {"state": "available", "incidents": "nope"}, started=STARTED, seen=NEVER
        ).events
        == ()
    )
    assert ev.detect_incidents(None, started=STARTED, seen=NEVER).events == ()
    assert (
        ev.detect_incidents(_store({"id": "x"}), started=STARTED, seen=NEVER).events
        == ()
    )


# ------------------------------------------------------------------ summary


def _bot_day(
    tag, pnl, *, quote="USDT", fresh=True, held=2, active=1, wallet=None, paper=False
):
    return ev.BotDay(
        tag,
        quote,
        fresh,
        None if pnl is None else Decimal(pnl),
        held,
        active,
        None if wallet is None else Decimal(wallet),
        None if wallet is None else quote,
        paper=paper,
    )


def test_daily_summary_totals_only_when_quote_currencies_match_and_data_is_fresh():
    event = ev.fleet_summary(
        [_bot_day("V2", "12.5", wallet="2500"), _bot_day("V3", "-2", wallet="2500")],
        now=NOW,
    )
    assert (
        event.cls == "summary"
        and event.severity == "info"
        and event.id == "summary:" + ev._utc_day(NOW)
    )
    assert event.body.splitlines() == [
        "V2: +12.50 USDT today · 2 held · 1 active · wallet 2,500.00 USDT",
        "V3: -2.00 USDT today · 2 held · 1 active · wallet 2,500.00 USDT",
        "Fleet today: +10.50 USDT",
    ]  # the shared wallet is shown per bot and never summed
    mixed = ev.fleet_summary(
        [_bot_day("V2", "1"), _bot_day("V3", "1", quote="BTC")], now=NOW
    )
    assert "UNAVAILABLE" in mixed.body
    stale = ev.fleet_summary(
        [_bot_day("V2", "1"), _bot_day("V3", None, fresh=False)], now=NOW
    )
    assert "V3: status unavailable" in stale.body and "UNAVAILABLE" in stale.body
    with pytest.raises(ValueError):
        ev.fleet_summary([], now=NOW)


def test_daily_summary_never_adds_a_paper_bot_to_the_live_fleet_total():
    event = ev.fleet_summary(
        [
            _bot_day("V2", "12.5"),
            _bot_day("V4 PAPER", "1000", paper=True),
            _bot_day("V4 D2h PAPER", None, fresh=False, paper=True),
        ],
        now=NOW,
    )
    assert event.body.splitlines() == [
        "V2: +12.50 USDT today · 2 held · 1 active",
        "V4 PAPER: +1,000.00 USDT today · 2 held · 1 active",
        "V4 D2h PAPER: status unavailable",
        "Fleet today: +12.50 USDT (paper excluded)",
    ]
    only_paper = ev.fleet_summary([_bot_day("V4 PAPER", "5", paper=True)], now=NOW)
    assert only_paper.body.splitlines()[-1] == "Fleet today: UNAVAILABLE (no live bots)"
    paper_src = ev.SourceInfo(
        "p" * 64, "meridian_v4_paper", "V4 PAPER", "USDT", paper=True
    )
    assert ev.summarize_bot(paper_src, None, now=NOW, stale_seconds=300).paper is True


def test_summarize_bot_takes_day_pnl_from_the_owners_daily_baseline():
    day = ev._today_number(NOW)
    payload = {
        "runtime_status": {
            "updated_at": NOW - 10,
            "summary": {
                "positions_held_count": 3,
                "active_executor_count": 2,
                "balance_value_quote": 20691.94,
                "balance_value_status": "AVAILABLE",
                "balance_value_currency": "USDT",
            },
            "daily_entry_risk": {
                "utc_day": day,
                "baseline_quote": "100",
                "last_pnl_quote": "112.5",
            },
        }
    }
    bot = ev.summarize_bot(V2, payload, now=NOW, stale_seconds=300)
    assert (bot.fresh, bot.pnl_day, bot.held, bot.active) == (
        True,
        Decimal("12.5"),
        3,
        2,
    )
    assert (bot.wallet, bot.wallet_currency) == (Decimal("20691.94"), "USDT")
    unavailable = {
        "runtime_status": {
            **payload["runtime_status"],
            "summary": {
                "balance_value_quote": 5,
                "balance_value_status": "UNAVAILABLE",
                "balance_value_currency": "USDT",
            },
        }
    }
    assert ev.summarize_bot(V2, unavailable, now=NOW, stale_seconds=300).wallet is None
    no_currency = {
        "runtime_status": {
            **payload["runtime_status"],
            "summary": {"balance_value_quote": 5},
        }
    }
    assert ev.summarize_bot(V2, no_currency, now=NOW, stale_seconds=300).wallet is None
    other_day = {
        **payload,
        "runtime_status": {
            **payload["runtime_status"],
            "daily_entry_risk": {"utc_day": day - 1},
        },
    }
    assert ev.summarize_bot(V2, other_day, now=NOW, stale_seconds=300).pnl_day is None
    assert ev.summarize_bot(V2, None, now=NOW, stale_seconds=300).fresh is False


def test_summary_is_due_once_per_day_inside_its_window():
    from datetime import datetime, timezone

    midnight = (
        datetime.fromtimestamp(NOW, timezone.utc)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .timestamp()
    )
    at = midnight + 20 * 3600
    day = ev._utc_day(at)
    assert ev.summary_due(at - 1, hour_utc=20, minute=0, last_date=None) is None
    assert ev.summary_due(at + 60, hour_utc=20, minute=0, last_date=None) == day
    assert ev.summary_due(at + 60, hour_utc=20, minute=0, last_date=day) is None
    assert (
        ev.summary_due(at + 7 * 3600, hour_utc=20, minute=0, last_date=None) is None
    )  # too late to be useful


# ------------------------------------------------------------------ market verdict


def test_verdict_matches_the_dashboard_thresholds_and_hold_band():
    assert ev.next_verdict_state(None, 0.25) == "risk-on"
    assert ev.next_verdict_state(None, 0.24) == "mixed"
    assert ev.next_verdict_state("risk-on", 0.11) == "risk-on"  # held
    assert ev.next_verdict_state("risk-on", 0.10) == "mixed"
    assert ev.next_verdict_state("risk-off", -0.11) == "risk-off"
    assert ev.next_verdict_state("mixed", -0.25) == "risk-off"


def test_only_a_flip_between_extremes_announces_and_the_first_extreme_is_a_baseline():
    state = ev.VerdictState()
    events = []
    for minute, score in enumerate(
        [0.0, 0.30, 0.20, 0.15, 0.05, -0.05, -0.30, -0.20, -0.11, 0.0, 0.26]
    ):
        state, event = ev.step_verdict(state, score, NOW + minute * 60)
        if event:
            events.append((minute, event.kind))
    # risk-on baseline at 1; hold band keeps it through 0.20/0.15; mixed at 0.05/-0.05; risk-off at 6 flips; back on at 10.
    assert events == [(6, "risk-off"), (10, "risk-on")]


def test_verdict_ignores_missing_scores_and_describes_the_flip():
    state = ev.VerdictState("risk-on", "risk-on")
    assert ev.step_verdict(state, None, NOW) == (state, None)
    assert ev.step_verdict(state, float("nan"), NOW) == (state, None)
    _, event = ev.step_verdict(state, -0.4, NOW)
    assert (
        event.title == "Market verdict: Risk-off"
        and "from Risk-on to Risk-off" in event.body
    )
    assert event.collapse_key == "market:verdict" and event.cls == "market"


def test_smoothed_score_is_a_trailing_mean_inside_the_window():
    samples = [(NOW - 20 * 60, 1.0), (NOW - 10 * 60, 0.2), (NOW - 60, 0.4)]
    assert ev.smoothed_score(samples, NOW) == pytest.approx(0.3)
    assert ev.smoothed_score([], NOW) is None


def test_test_event_is_stable_per_request():
    event = ev.make_test_event("abc123", now=NOW)
    assert (
        event.id == "test:abc123"
        and event.cls == "test"
        and event.deep_link == "rsibot://settings/push"
    )
    assert ev.make_test_event("abc123", now=NOW + 5).collapse_key == event.collapse_key


def test_clean_text_strips_controls_and_bounds_length():
    assert ev.clean_text("a\x00b\n c\t", 20) == "a b c"
    assert len(ev.clean_text("x" * 500, 40)) == 40
    assert ev.clean_text(None, 10) == "" and ev.clean_text(True, 10) == ""
    assert ev.clean_text("a\nb\n\n c", 20, multiline=True) == "a\nb\n\nc"


# --------------------------------------------------------------------------- trading capability

from datetime import datetime as _dt, timezone as _tz

TRADING = ev.TradingThresholds(confirm_seconds=60, funds_confirm_seconds=900, recover_seconds=120,
                               max_age_seconds=300)
T0 = 1_792_675_000.0
ETH_ISSUE = {
    "pair": "ETH-USDC",
    "side": "buy",
    "state": "restricted",
    "reason_code": "entry_decision_unavailable",
    "since": "2026-10-22T10:37:23+00:00",
    "detail": "OperationalError: database is locked [SQL: UPDATE ...]",
    "alert": True,
}


def _iso(epoch):
    return _dt.fromtimestamp(epoch, _tz.utc).isoformat()


def _capability_payload(restrictions, *, at, evidence="fresh"):
    return {
        "runtime_status": {
            "updated_at": _iso(at),
            "trading_capability": {
                "schema_version": 1,
                "observed_at": _iso(at),
                "evidence": evidence,
                "buy": "restricted" if restrictions else "can_trade",
                "sell": "can_trade",
                "restrictions": restrictions,
            },
        }
    }


def _run_trading(steps, src=V1):
    """Feed (seconds after T0, payload-or-builder, runtime_ok) through evaluate_trading, persisting conditions.

    A list as the payload means "a fresh report with these restrictions at that moment".
    """
    conditions: dict = {}
    out = []
    for t, payload, ok in steps:
        now = T0 + t
        if isinstance(payload, list):
            payload = _capability_payload(payload, at=now)
        events, changes = ev.evaluate_trading(
            src, now=now, thresholds=TRADING, runtime_payload=payload, runtime_ok=ok,
            conditions=conditions,
        )
        for key, value in changes.items():
            if value is None:
                conditions.pop(key, None)
            else:
                conditions[key] = value
        out.append(events)
    return out, conditions


def test_v1_eth_admission_issue_alerts_once_after_confirmation_and_once_on_recovery():
    """Live V1, 2026-10-22: the latched ETH admission error produced no push event before this."""
    out, conditions = _run_trading(
        [(0, [ETH_ISSUE], True), (30, [ETH_ISSUE], True), (60, [ETH_ISSUE], True), (90, [ETH_ISSUE], True),
         (120, [], True), (200, [], True), (260, [], True)]
    )
    assert [len(e) for e in out] == [0, 0, 1, 0, 0, 0, 1]
    opened, resolved = out[2][0], out[6][0]
    assert opened.cls == "health" and opened.kind == "trading_blocked" and opened.severity == "warning"
    assert opened.title == "V1 · ETH-USDC buying restricted"
    assert opened.body == "ETH-USDC buying: buy decision could not be stored."
    assert opened.deep_link == "rsibot://bot/ok_rsi/health"
    assert resolved.kind == "trading_resolved" and resolved.severity == "info"
    assert resolved.title == "V1 · ETH-USDC buying available again"
    assert resolved.body == "ETH-USDC buying is available again."
    assert resolved.collapse_key == opened.collapse_key
    assert conditions == {}


def test_trading_events_use_a_class_that_older_workers_can_deliver():
    """Review 2026-10-22: an unknown class in the outbox makes the rollback worker's due() raise."""
    out, _ = _run_trading([(0, [ETH_ISSUE], True), (60, [ETH_ISSUE], True)])
    assert out[1][0].cls in {"fill_entry", "fill_exit", "bag", "risk", "health", "incident", "summary", "market", "test"}
    assert "trading" not in ev.ALERT_CLASSES


def test_one_cause_across_pairs_is_one_notification_per_transition():
    """Live V2, 2026-10-22: two reasons on each of SOL and XRP produced four notifications."""
    rows = [
        dict(ETH_ISSUE, pair=pair, reason_code=code, detail=detail)
        for pair in ("SOL-USDC", "XRP-USDC")
        for code, detail in (("native_buy_create_refused", "controller_permission_changed"),
                             ("native_funding_reconciliation_required", "Candidate funding allocation exhausted"))
    ]
    out, conditions = _run_trading([(0, rows, True), (60, rows, True), (90, [], True), (210, [], True)])
    assert [len(e) for e in out] == [0, 1, 0, 1]
    [opened], [resolved] = out[1], out[3]
    assert opened.title == "V1 · Buying restricted: SOL, XRP"
    assert opened.body == ("SOL-USDC buying: buy order refused; not enough USDC allocated. "
                           "XRP-USDC buying: buy order refused; not enough USDC allocated.")
    assert resolved.title == "V1 · Buying SOL, XRP available again"
    assert opened.collapse_key == resolved.collapse_key
    assert len(conditions) == 0


def _row(pair, code="native_funding_reconciliation_required", side="buy", **extra):
    return dict(ETH_ISSUE, pair=pair, side=side, reason_code=code, detail=None, **extra)


def test_partial_recovery_reports_what_is_still_blocked_never_available_again():
    """Review round 4: SOL clearing while XRP stayed open sent 'SOL available again' over XRP's block."""
    sol, xrp = _row("SOL-USDC"), _row("XRP-USDC")
    out, conditions = _run_trading([(0, [sol, xrp], True), (60, [sol, xrp], True),
                                    (90, [xrp], True), (210, [xrp], True)])
    assert [len(e) for e in out] == [0, 1, 0, 1]
    [update] = out[3]
    assert update.kind == "trading_blocked" and "available again" not in update.title
    assert update.title == "V1 · XRP-USDC buying restricted"
    assert update.body == "XRP-USDC buying: not enough USDC allocated."
    assert update.collapse_key == out[1][0].collapse_key


def test_one_reason_clearing_on_a_pair_with_another_open_is_not_availability():
    both = [_row("SOL-USDC", "native_buy_create_refused"), _row("SOL-USDC")]
    out, _ = _run_trading([(0, both, True), (60, both, True), (90, both[1:], True), (210, both[1:], True)])
    [update] = out[3]
    assert update.kind == "trading_blocked"
    assert update.body == "SOL-USDC buying: not enough USDC allocated."


def test_a_recovery_and_a_new_block_in_one_cycle_are_one_critical_summary():
    sol, xrp_sell = _row("SOL-USDC"), _row("XRP-USDC", "inventory_unavailable", side="sell")
    # SOL clears from 90 (recovers at 210); XRP's sell restriction appears at 150 (confirms at 210).
    out, _ = _run_trading([(0, [sol], True), (60, [sol], True), (90, [], True),
                           (150, [xrp_sell], True), (210, [xrp_sell], True)])
    assert [len(e) for e in out] == [0, 1, 0, 0, 1]
    [final] = out[4]
    assert final.kind == "trading_blocked" and final.severity == "critical"
    assert final.title == "V1 · XRP-USDC selling restricted"


def test_a_new_buy_warning_keeps_an_open_sell_block_in_the_summary():
    xrp_sell = _row("XRP-USDC", "manual_kill_switch", side="sell", state="blocked")
    sol = _row("SOL-USDC")
    out, _ = _run_trading([(0, [xrp_sell], True), (60, [xrp_sell], True),
                           (90, [xrp_sell, sol], True), (150, [xrp_sell, sol], True)])
    [summary] = out[3]
    assert summary.severity == "critical"
    assert summary.title == "V1 · Trading blocked: SOL, XRP"
    assert summary.body == "SOL-USDC buying: not enough USDC allocated. XRP-USDC selling: kill switch on."


def test_a_pair_restricted_on_both_sides_is_named_once():
    rows = [_row("SOL-USDC"), _row("SOL-USDC", "base_balance_low", side="sell")]
    out, _ = _run_trading([(0, rows, True), (900, rows, True)])
    [event] = out[1]
    assert event.title == "V1 · Trading restricted: SOL"


def test_an_unknown_reason_carries_the_owner_detail():
    odd = _row("BTC-USDC", "brand_new_code")
    odd["detail"] = "engine said so"
    out, _ = _run_trading([(0, [odd], True), (60, [odd], True)])
    [event] = out[1]
    assert event.body == "BTC-USDC buying: brand new code (engine said so)."


def test_gaps_never_open_or_clear_a_trading_condition():
    out, conditions = _run_trading(
        [(0, [ETH_ISSUE], True), (60, [ETH_ISSUE], True),
         (100, None, False),
         (300, _capability_payload([], at=T0 + 300, evidence="stale"), True),
         (500, {"runtime_status": {"updated_at": "x"}}, True)]
    )
    assert [len(e) for e in out] == [0, 1, 0, 0, 0]
    assert len(conditions) == 1 and next(iter(conditions.values())).open


def test_a_frozen_report_neither_opens_nor_clears():
    """Review 2026-10-22: identical timestamp-frozen reports opened at T+3600 and cleared conditions."""
    frozen_blocked = _capability_payload([ETH_ISSUE], at=T0)
    out, conditions = _run_trading([(0, frozen_blocked, True), (3600, frozen_blocked, True)])
    # Fresh at T0 starts a pending condition; the frozen copy an hour later must not confirm it.
    assert not any(out) and not any(c.open for c in conditions.values())
    frozen_clear = _capability_payload([], at=T0 + 60)
    out, conditions = _run_trading(
        [(0, [ETH_ISSUE], True), (60, [ETH_ISSUE], True), (900, frozen_clear, True), (1100, frozen_clear, True)])
    assert [len(e) for e in out] == [0, 1, 0, 0]
    assert next(iter(conditions.values())).open


def test_a_malformed_row_is_a_gap_not_a_recovery():
    """Review 2026-10-22: a malformed copy of an open restriction resolved it."""
    broken = dict(ETH_ISSUE, pair="broken")
    out, conditions = _run_trading(
        [(0, [ETH_ISSUE], True), (60, [ETH_ISSUE], True), (90, [broken], True), (210, [broken], True)])
    assert [len(e) for e in out] == [0, 1, 0, 0]
    assert next(iter(conditions.values())).open


def test_unhashable_or_mistyped_fields_are_a_gap_not_an_exception():
    """Review round 2: side=[] raised TypeError and stopped the cycle before delivery."""
    for bad in (dict(ETH_ISSUE, side=[], alert=False), dict(ETH_ISSUE, side={}), dict(ETH_ISSUE, state=[]),
                dict(ETH_ISSUE, reason_code=7), dict(ETH_ISSUE, pair=["ETH-USDC"])):
        out, conditions = _run_trading([(0, [ETH_ISSUE], True), (60, [ETH_ISSUE], True), (90, [bad], True),
                                        (300, [bad], True)])
        assert [len(e) for e in out] == [0, 1, 0, 0]
        assert next(iter(conditions.values())).open


def test_a_malformed_report_never_claims_incident_ownership():
    """Review round 2: a rejected report still suppressed the fallback host incident."""
    broken = _capability_payload([dict(ETH_ISSUE, pair="broken")], at=T0)
    assert not ev.capability_reported(broken, now=T0 + 5, max_age_seconds=300)


def test_policy_restrictions_and_expected_waits_never_page():
    quiet = dict(ETH_ISSUE, reason_code="trade_mode_sell_only", alert=False)
    out, conditions = _run_trading([(t, [quiet], True) for t in range(0, 4000, 30)])
    assert not any(out) and conditions == {}


def test_low_balance_must_persist_fifteen_minutes_and_sell_side_is_critical():
    funds = dict(ETH_ISSUE, side="sell", reason_code="base_balance_low", detail=None)
    out, _ = _run_trading([(t, [funds], True) for t in range(0, 1000, 60)])
    opened = [e for events in out for e in events]
    assert len(opened) == 1 and list(out[15]) == opened  # opened at t=900
    assert opened[0].severity == "critical"
    assert opened[0].body == "ETH-USDC selling: not enough of the coin to sell."


def test_unknown_reason_carries_the_owner_detail_and_bot_wide_scope_reads_plainly():
    odd = {"pair": None, "side": "both", "state": "blocked", "reason_code": "symbol_runtime_fault",
           "detail": "BTC-USDC runtime fault", "alert": True}
    out, _ = _run_trading([(0, [odd], True), (60, [odd], True)])
    [event] = out[1]
    assert event.title == "V1 · Trading blocked"
    assert event.body == "Trading: symbol fault."
    assert event.severity == "critical"


def test_malformed_restrictions_are_ignored_not_alerted():
    bad = [dict(ETH_ISSUE, pair="eth"), dict(ETH_ISSUE, side="up"), dict(ETH_ISSUE, reason_code="Bad Code"),
           dict(ETH_ISSUE, alert="yes"), "text"]
    for row in bad:
        out, conditions = _run_trading([(0, [row], True), (90, [row], True)])
        assert not any(out) and conditions == {}


def test_admission_incidents_are_owned_by_trading_only_while_capability_is_reported():
    store = {
        "state": "available",
        "incidents": [
            {"id": "execution-main/buy_admission_issue", "severity": "critical", "state": "open",
             "first_seen_at": "2026-10-22T10:40:00+00:00", "service": "execution-main", "title": "BUY admission"},
            {"id": "execution-main/container_down", "severity": "critical", "state": "open",
             "first_seen_at": "2026-10-22T10:40:00+00:00", "service": "execution-main", "title": "Down"},
        ],
    }
    seen = set()
    owned = ev.detect_incidents(store, started=0, seen=seen.__contains__,
                                owned_suffixes=ev.TRADING_OWNED_INCIDENT_SUFFIXES)
    assert [e.title for e in owned.events] == ["execution-main · Down"]
    assert not any("buy_admission_issue" in key for key in owned.seen), "ownership must not be permanent"
    seen.update(owned.seen)
    lapsed = ev.detect_incidents(store, started=0, seen=seen.__contains__)
    assert [e.title for e in lapsed.events] == ["execution-main · BUY admission"]


def test_capability_reported_requires_a_fresh_young_versioned_body():
    now = T0 + 10
    assert ev.capability_reported(_capability_payload([], at=T0), now=now, max_age_seconds=300)
    assert not ev.capability_reported(_capability_payload([], at=T0, evidence="stale"), now=now, max_age_seconds=300)
    assert not ev.capability_reported(_capability_payload([], at=T0 - 600), now=now, max_age_seconds=300)
    assert not ev.capability_reported({"runtime_status": {}}, now=now, max_age_seconds=300)
    assert not ev.capability_reported(None, now=now, max_age_seconds=300)
