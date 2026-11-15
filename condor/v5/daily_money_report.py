"""Export the existing record: python -m condor.v5.daily_money_report --help."""

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .daily_money import daily_report
from .money import DAY_MS


def main() -> None:
    parser = argparse.ArgumentParser(description="Export V5 and Helm simulated spot money; reads samples.jsonl only.")
    parser.add_argument("--input", type=Path, required=True, help="Existing V5_RUNTIME_ROOT/money/samples.jsonl (never creates it)")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--day", type=date.fromisoformat, default=datetime.now(timezone.utc).date() - timedelta(days=1),
                        help="UTC date YYYY-MM-DD; default yesterday")
    args = parser.parse_args()
    start = int(datetime.combine(args.day, datetime.min.time(), timezone.utc).timestamp()) * 1000
    rows, malformed = [], 0
    try:
        lines = args.input.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        # Explicitly report an absent record, without creating sampler state.
        lines = []
        source_state = "UNAVAILABLE: input record missing"
    else:
        source_state = "read"
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            malformed += 1
            continue
        if not isinstance(row, dict) or type(row.get("at_ms")) is not int or row.get("bot") not in ("v5", "helm"):
            malformed += 1
        else:
            rows.append(row)
    report = daily_report(rows, start, start + DAY_MS, int(datetime.now(timezone.utc).timestamp()) * 1000)
    payload = {"schema": "daily-paper-money.v1", "day": args.day.isoformat(), "scope": "simulated spot only",
               "source": str(args.input.resolve()), "source_state": source_state, "malformed_lines": malformed,
               "notes": ["Changes, realized PnL and fees cover first-to-last recorded sample, not an exact midnight valuation.",
                         "Equity change includes external cash flows; it is not trading profit.",
                         "Realized PnL and fees require one stable accounting identity established before the UTC day; otherwise UNAVAILABLE.",
                         "Money is exact decimal text; percentage rounds half-even to 12 decimal places.",
                         "Cash, held value and buys/sells/fills are not recorded: UNAVAILABLE."],
               "rows": report}
    markdown = [f"# Daily simulated-money report — {args.day.isoformat()} UTC", "", "Spot only. " + source_state + ".",
                f"Malformed record lines skipped: {malformed}.", "",
                "| Bot | Unit | Start equity | End equity | Change | Change % | Realized PnL | Fees | Unrealized at end |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in report:
        markdown.append("| " + " | ".join(str(row[key]) for key in (
            "bot", "unit", "equity_start", "equity_end", "equity_change", "equity_change_pct", "realized_pnl", "fees", "unrealized_pnl_end")) + " |")
    markdown += ["", *[f"- {row['bot']}: {row['data_quality']}".replace("\n", " ") for row in report],
                 "", *payload["notes"], ""]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves earlier exports and guards against writing
    # through an existing path, including accidentally targeting the source.
    for suffix, content in (("json", json.dumps(payload, indent=2, allow_nan=False) + "\n"), ("md", "\n".join(markdown))):
        target = args.output_dir / f"daily-money-{args.day.isoformat()}.{suffix}"
        with target.open("x", encoding="utf-8") as handle:
            handle.write(content)


if __name__ == "__main__":
    main()
