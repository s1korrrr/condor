"""Compact Condor market-picture frame fixtures exactly as the owner builder serves them."""
import json
import sys
from pathlib import Path

from services.screener_core.market_context.market_picture import builder
from services.screener_core.market_context.market_picture.frame import (
    MarketPictureFrameV1,
)

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
VARIANTS = {
    # Live frames serve microstructure as a separate companion, never embedded in the compact frame.
    "no-embedded-microstructure": lambda f: {
        k: v for k, v in f.items() if k not in ("microstructure", "microstructure_ref")
    },
    # The live failing case: an hourly anomaly with no valid instruments.
    "unavailable-anomaly": lambda f: _unavailable_anomaly(
        {
            k: v
            for k, v in f.items()
            if k not in ("microstructure", "microstructure_ref")
        }
    ),
}


def _unavailable_anomaly(frame):
    metric = frame["candle_anomalies"]["metrics"]["extreme_realized_volatility_1h_95p"]
    metric.update(
        values=[None] * len(metric["values"]),
        valid_count=0,
        high_count=None,
        share_fraction=None,
        reason_codes=["BAR_GAP", "INSUFFICIENT_HISTORY"],
    )
    return frame


for spec in sys.argv[3:]:
    name, _, variant = spec.partition(":")
    frame = json.loads((src / name).read_text())
    if variant:
        frame = VARIANTS[variant](frame)
    try:
        parsed = MarketPictureFrameV1.model_validate_json(
            json.dumps(frame, allow_nan=False)
        )
    except Exception as exc:
        print(f"SKIP {name}: owner model rejects fixture ({type(exc).__name__})")
        continue
    compact = parsed.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
    compact["flow_ref"] = parsed.flow_ref.model_dump(
        mode="json", exclude_none=True, exclude_defaults=True
    )
    compact.pop("snapshot_id", None)
    compact.pop("payload_digest", None)
    compact["snapshot_id"] = builder.frame_snapshot_id(compact)
    compact["payload_digest"] = builder.frame_payload_digest(compact)
    try:
        builder.validate_market_picture_frame(compact, for_production=False)
        verdict = "owner-valid"
    except Exception as exc:
        verdict = f"owner-INVALID {type(exc).__name__}: {str(exc)[:120]}"
    out = dst / name.replace(
        ".json", f"{'.' + variant if variant else ''}.owner-compact.json"
    )
    out.write_text(json.dumps(compact, sort_keys=True, separators=(",", ":")) + "\n")
    print(
        f"{spec}: {len(json.dumps(frame))} -> {len(json.dumps(compact))} bytes, {verdict}"
    )
