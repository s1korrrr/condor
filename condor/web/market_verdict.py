"""Market verdict (Risk-on / Mixed / Risk-off), computed once on the server.

This is a line-for-line port of ``frontend/src/features/market-picture/pulse.mjs``
(``marketVerdict`` and the helpers it uses). It exists so the dashboard, the iPhone/Watch
app and any push text read one verdict instead of re-deriving it. The two implementations
are held together by ``tests/fixtures/fleet_summary/verdict_cases.json``: the frontend test
and ``tests/test_market_verdict.py`` replay the same frames and must agree to 1e-12.

The port deliberately uses explicit left-to-right float loops (never ``sum``: Python 3.12
compensates float sums, JavaScript does not) so both implementations perform the same
IEEE-754 operations in the same order.

A *frame* here has the display shape the browser projects from a stored Market Picture frame::

    {"pressure": {"60": {"value": 1.2}}, "distribution": {"60": {"mean": {"value": 0.4}}},
     "summary": {"realized_volatility_24h": {"value": 0.6}},
     "breadth": {"60": {"advancing": 3, "declining": 1, "unchanged": 1, "valid": 5, "expected": 5}},
     "expected": 5, "cutoff_ms": 1800000000000}

``frame_from_raw`` builds it from the validated owner wire frame; ``history_from_items`` builds
the history points (``{"time", "gapBefore", "breadth": {h: {"pressure"}}}``) from the stored
history page.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional

MINUTES_PER_YEAR = 525_600
VERDICT_THRESHOLD = 0.25
VERDICT_HOLD = 0.1
SMOOTHING_MINUTES = 15
STATE_LOOKBACK_MS = 6 * 3_600_000
PERSISTENCE_HORIZONS = ("15", "60", "240", "1440")
HORIZONS = ("1", "5", "15", "60", "240", "1440")
HORIZON_LABELS = ("1m", "5m", "15m", "1h", "4h", "24h")
DEFAULT_HORIZON = "60"
STATES = {"risk-on": "Risk-on", "risk-off": "Risk-off", "mixed": "Mixed"}


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def horizon_label(horizon: str) -> str:
    horizon = str(horizon)
    if horizon in HORIZONS:
        return HORIZON_LABELS[HORIZONS.index(horizon)]
    return "7d" if horizon == "10080" else f"{horizon}m"


def implied_move(annual_volatility: Any, minutes: float) -> Optional[float]:
    """Expected move, in percent, for ``minutes`` given an annualized volatility fraction."""
    if not _finite(annual_volatility) or annual_volatility <= 0:
        return None
    return annual_volatility * math.sqrt(minutes / MINUTES_PER_YEAR) * 100


def _mean(values: list) -> float:
    total = 0.0
    for value in values:
        total += value
    return total / len(values)


def _breadth_components(
    pressure: Callable[[str], Optional[float]], horizon: str
) -> list[dict]:
    components = []
    now = pressure(horizon)
    if now is not None:
        components.append({"id": "breadth", "score": _clamp(now / 3, -1, 1)})
    persistence = [
        v for v in (pressure(h) for h in PERSISTENCE_HORIZONS) if v is not None
    ]
    if len(persistence) >= 2:
        components.append(
            {"id": "persistence", "score": _clamp(_mean(persistence) / 3, -1, 1)}
        )
    return components


def _mean_score(components: list[dict]) -> Optional[float]:
    return _mean([c["score"] for c in components]) if components else None


def next_verdict_state(previous: str, score: float) -> str:
    """Next state under the entry threshold and the hold band."""
    if score >= VERDICT_THRESHOLD:
        return "risk-on"
    if score <= -VERDICT_THRESHOLD:
        return "risk-off"
    if previous == "risk-on" and score > VERDICT_HOLD:
        return "risk-on"
    if previous == "risk-off" and score < -VERDICT_HOLD:
        return "risk-off"
    return "mixed"


def rolling_mean(
    samples: list[dict],
    value_of: Callable[[dict], Any],
    minutes: int = SMOOTHING_MINUTES,
) -> list:
    """Trailing mean per stored point. Windows restart after a coverage break; nothing is interpolated."""
    span = minutes * 60_000
    out: list = []
    window: list[tuple[float, float]] = []
    total = 0.0
    for point in samples:
        if point.get("gapBefore"):
            window = []
            total = 0.0
        value = value_of(point)
        if _finite(value):
            window.append((point["time"], value))
            total += value
        while window and window[0][0] <= point["time"] - span:
            total -= window.pop(0)[1]
        out.append(total / len(window) if window else None)
    return out


def _stored_pressure(point: dict, horizon: str) -> Optional[float]:
    value = ((point.get("breadth") or {}).get(horizon) or {}).get("pressure")
    return value if _finite(value) else None


def _replay_state(
    history: list[dict], horizon: str, until: float, smooth: bool
) -> tuple[str, list[dict]]:
    points = [
        p
        for p in history
        if p["time"] < until and p["time"] >= until - STATE_LOOKBACK_MS
    ]
    scored = []
    for p in points:
        components = _breadth_components(lambda h, p=p: _stored_pressure(p, h), horizon)
        scored.append(
            {
                **p,
                "components": {c["id"]: c["score"] for c in components},
                "score": _mean_score(components),
            }
        )
    basis = (
        rolling_mean(scored, lambda p: p["score"])
        if smooth
        else [p["score"] for p in scored]
    )
    state = "mixed"
    for index, p in enumerate(scored):
        if p.get("gapBefore"):
            state = "mixed"
        if basis[index] is not None:
            state = next_verdict_state(state, basis[index])
    return state, scored


def _trailing_window(scored: list[dict], until: float) -> list[dict]:
    span = SMOOTHING_MINUTES * 60_000
    window = []
    for p in reversed(scored):
        if until - p["time"] >= span:
            break
        window.append(p)
        if p.get("gapBefore"):
            break
    return window


def _value(frame: dict, *path: str) -> Any:
    node: Any = frame
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return node


def market_verdict(
    frame: Optional[dict],
    horizon: str = DEFAULT_HORIZON,
    history: Optional[list] = None,
    smooth: bool = True,
) -> Optional[dict]:
    """Headline market state; ``None`` when no component can be computed.

    ``history`` is the stored breadth history (``history_from_items``); with it the breadth
    components use their trailing 15-minute mean and a hold band keeps the word from flipping.
    Without it the latest frame alone decides.
    """
    if not frame:
        return None
    horizon = str(horizon)

    def pressure(h: str) -> Optional[float]:
        value = _value(frame, "pressure", h, "value")
        return value if _finite(value) else None

    components = _breadth_components(pressure, horizon)
    mean_return = _value(frame, "distribution", horizon, "mean", "value")
    move = implied_move(
        _value(frame, "summary", "realized_volatility_24h", "value"), float(horizon)
    )
    if _finite(mean_return) and move is not None and move > 0:
        z = mean_return / move
        components.append({"id": "return", "score": _clamp(z, -2, 2) / 2})
    if not components:
        return None
    instant_score = _mean_score(components)
    has_history = history is not None
    do_smooth = smooth and has_history
    cutoff = frame.get("cutoff_ms")
    until = cutoff if _finite(cutoff) else math.inf
    state, scored = (
        _replay_state(history, horizon, until, do_smooth)
        if has_history
        else ("mixed", [])
    )
    shown = components
    smoothed_frames = 1
    if do_smooth:
        window = _trailing_window(scored, until)
        smoothed_frames = len(window) + 1
        if window:
            shown = []
            for c in components:
                if c["id"] == "return":
                    shown.append(c)
                    continue
                values = [
                    v
                    for v in (p["components"].get(c["id"]) for p in window)
                    if _finite(v)
                ] + [c["score"]]
                shown.append({"id": c["id"], "score": _mean(values)})
    score = _mean_score(shown)
    state = next_verdict_state(state, score)
    entered = (
        "risk-on"
        if score >= VERDICT_THRESHOLD
        else "risk-off" if score <= -VERDICT_THRESHOLD else "mixed"
    )
    breadth = _value(frame, "breadth", horizon) or {}
    expected = breadth.get("expected")
    return {
        "state": state,
        "label": STATES[state],
        "score": score,
        "instant_score": instant_score,
        "smoothed": smoothed_frames > 1,
        "smoothed_frames": smoothed_frames,
        "smoothing_minutes": SMOOTHING_MINUTES,
        "held": state != entered,
        "horizon": horizon,
        "horizon_label": horizon_label(horizon),
        "components": [{"id": c["id"], "score": c["score"]} for c in shown],
        "advancing": breadth.get("advancing"),
        "declining": breadth.get("declining"),
        "unchanged": breadth.get("unchanged"),
        "valid": breadth.get("valid"),
        "expected": expected if expected is not None else frame.get("expected"),
    }


# ── Wire adapters: validated owner frame / stored history page -> the shapes above ──


def _metric_value(frame: dict, ref: Any) -> Optional[float]:
    """``displayMetric(market_metrics[ref]).value``: a decimal string becomes a float, a missing value ``None``."""
    metric_id = ref if isinstance(ref, str) else (ref or {}).get("metric_id")
    metric = (frame.get("market_metrics") or {}).get(metric_id)
    if not isinstance(metric, dict) or metric.get("value") is None:
        return None
    try:
        number = float(metric["value"])
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _count(frame: dict, ref: Any) -> float:
    """Breadth counts mirror ``Number(metric.value)``: an unavailable metric reads as 0."""
    value = _metric_value(frame, ref)
    if value is None:
        return 0
    return int(value) if float(value).is_integer() else value


def frame_from_raw(raw: dict) -> dict:
    """The display frame ``projectFrame`` builds, limited to what the verdict reads."""
    breadth_rows = {str(b["horizon_minutes"]): b for b in raw.get("breadth", [])}
    breadth = {
        h: {
            "advancing": _count(raw, b["metric_refs"]["advances"]),
            "declining": _count(raw, b["metric_refs"]["declines"]),
            "unchanged": _count(raw, b["metric_refs"]["unchanged"]),
            "valid": b.get("valid_count"),
            "expected": b.get("expected_count"),
        }
        for h, b in breadth_rows.items()
    }
    distribution = {}
    for d in raw.get("distribution", []):
        b = breadth_rows.get(str(d["horizon_minutes"]))
        if b is not None:
            distribution[str(d["horizon_minutes"])] = {
                "mean": {"value": _metric_value(raw, b["metric_refs"]["mean_return"])}
            }
    summary_refs = (raw.get("summary") or {}).get("metric_refs") or {}
    return {
        "cutoff_ms": raw.get("cutoff_ms"),
        "expected": (raw.get("universe") or {}).get("expected_instrument_count"),
        "pressure": {
            str(p["horizon_minutes"]): {"value": _metric_value(raw, p["metric_id"])}
            for p in raw.get("pressure", [])
        },
        "breadth": breadth,
        "distribution": distribution,
        "summary": {
            "realized_volatility_24h": {
                "value": _metric_value(raw, summary_refs.get("realized_volatility_24h"))
            }
        },
    }


def history_from_items(
    items: list[dict], cutoff_ms: Optional[float] = None
) -> list[dict]:
    """Stored history rows as ``projectHistory`` shapes them: time-ordered, rows after the frame dropped."""
    points = []
    for row in items:
        time = row.get("cutoff_ms")
        if (
            not isinstance(time, int)
            or isinstance(time, bool)
            or (cutoff_ms is not None and time > cutoff_ms)
        ):
            continue
        breadth = {}
        for h in HORIZONS:
            raw = (row.get("breadth") or {}).get(h) or {}
            try:
                pressure = (
                    float(raw["pressure"]) if raw.get("pressure") is not None else None
                )
            except (TypeError, ValueError):
                pressure = None
            breadth[h] = {
                "pressure": (
                    pressure
                    if pressure is not None and math.isfinite(pressure)
                    else None
                )
            }
        points.append(
            {
                "time": time,
                "gapBefore": row.get("gap_before") is True,
                "breadth": breadth,
                "snapshot_id": row.get("snapshot_id"),
            }
        )
    points.sort(key=lambda p: (p["time"], str(p["snapshot_id"])))
    for p in points:
        p.pop("snapshot_id")
    return points
