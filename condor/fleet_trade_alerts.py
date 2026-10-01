"""Durable, owner-scoped fill notification outbox. Never places orders."""

import hashlib
import json
from collections import defaultdict
from decimal import Decimal

from condor import fleet_telegram_views as views


def normalize(row):
    required = (
        "fill_id",
        "order_id",
        "bot_name",
        "connector_name",
        "source_db_id",
        "pair",
    )
    if any(
        not isinstance(row.get(k), str) or not row[k] or len(row[k]) > 200
        for k in required
    ):
        raise ValueError("Fill identity incomplete")
    if row.get("side") not in ("buy", "sell") or len(row["pair"].split("-")) != 2:
        raise ValueError("Fill side or pair unavailable")
    amount = views.decimal(row.get("exact_amount", row.get("amount_base")))
    price = views.decimal(row.get("exact_price", row.get("price_quote")))
    if amount is None or price is None or amount <= 0 or price <= 0:
        raise ValueError("Fill economics invalid")
    raw_fee = row.get("exact_trade_fee_in_quote", row.get("fee_quote"))
    fee = views.decimal(raw_fee)
    if raw_fee is not None and fee is None:
        raise ValueError("Fill fee invalid")
    occurred = views.stamp(row.get("timestamp"))
    if occurred <= 0:
        raise ValueError("Fill timestamp invalid")
    return amount, price, fee, occurred


def fill_key(row):
    return json.dumps(
        [
            row[k]
            for k in (
                "bot_name",
                "source_db_id",
                "connector_name",
                "order_id",
                "fill_id",
            )
        ],
        separators=(",", ":"),
    )


def render_fill_alert(label, rows):
    if not rows:
        raise ValueError("Empty fill group")
    values = [normalize(row) for row in rows]
    first = rows[0]
    if any(
        (r["order_id"], r["pair"], r["side"], r["bot_name"])
        != (first["order_id"], first["pair"], first["side"], first["bot_name"])
        for r in rows
    ):
        raise ValueError("Mixed fill group")
    amount = sum((v[0] for v in values), Decimal(0))
    gross = sum((v[0] * v[1] for v in values), Decimal(0))
    fee = (
        sum((v[2] for v in values), Decimal(0))
        if all(v[2] is not None for v in values)
        else None
    )
    base, quote = first["pair"].split("-")
    side = first["side"].upper()
    from datetime import datetime, timezone

    stamp = datetime.fromtimestamp(max(v[3] for v in values), timezone.utc).strftime(
        "%d %b %H:%M:%S UTC"
    )
    lines = [
        f"{'🟢' if side == 'BUY' else '🔴'} <b>{side} · {views.clean(first['pair'])}</b>",
        f"🤖 {views.clean(label)} · confirmed execution",
        "",
        f"📦 Filled: <b>{views.number(amount)} {views.clean(base)}</b>",
        f"💵 Average price: {views.number(gross / amount)} {views.clean(quote)}",
        f"💰 Value: <b>{views.number(gross, money=True)} {views.clean(quote)}</b>",
        f"🧾 Fee: {views.number(fee) + ' ' + views.clean(quote) if fee is not None else 'unavailable'}",
    ]
    if side == "SELL":
        lines.append(
            "📈 Realized PnL: unavailable · fill feed has no verified cost basis"
        )
    lines += [
        "",
        f"🕒 {stamp}",
        f"🔖 Order <code>{views.clean(first['order_id'], 200)}</code>",
        f"✅ {len(rows)} fill{'s' if len(rows) != 1 else ''} in this update · may be part of a larger order",
    ]
    return "\n".join(lines)


class TradeAlerts:
    def __init__(self, db):
        self.db = db
        db.executescript("""
        CREATE TABLE IF NOT EXISTS trade_sources (source TEXT PRIMARY KEY, started REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS trade_seen (source TEXT NOT NULL, fill TEXT NOT NULL, PRIMARY KEY(source,fill));
        CREATE TABLE IF NOT EXISTS trade_outbox (id INTEGER PRIMARY KEY, source TEXT NOT NULL, recipient INTEGER NOT NULL, rows_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
        """)

    def start(self, source, now):
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO trade_sources VALUES (?,?)", (source, now)
            )

    def has_coverage(self, source, rows, limit=1000):
        if len(rows) < limit:
            return True
        started = self.db.execute(
            "SELECT started FROM trade_sources WHERE source=?", (source,)
        ).fetchone()[0]
        if min(normalize(row)[3] for row in rows) <= started:
            return True
        return any(
            self.db.execute(
                "SELECT 1 FROM trade_seen WHERE source=? AND fill=?",
                (source, fill_key(row)),
            ).fetchone()
            for row in rows
        )

    def ingest(self, source, rows, recipients):
        # Validate the whole batch before advancing any checkpoint.
        parsed = [(row, normalize(row), fill_key(row)) for row in rows]
        started = self.db.execute(
            "SELECT started FROM trade_sources WHERE source=?", (source,)
        ).fetchone()[0]
        groups = defaultdict(list)
        with self.db:
            for row, values, key in parsed:
                new = self.db.execute(
                    "INSERT OR IGNORE INTO trade_seen VALUES (?,?)", (source, key)
                ).rowcount
                if new and values[3] >= started:
                    groups[
                        (row["source_db_id"], row["order_id"], row["side"], row["pair"])
                    ].append(row)
            for group in groups.values():
                for recipient in recipients:
                    self.db.execute(
                        "INSERT INTO trade_outbox(source,recipient,rows_json) VALUES (?,?,?)",
                        (source, recipient, json.dumps(group)),
                    )
        return len(groups) * len(recipients)

    def pending(self, recipients, sources=None):
        # Apply authorization before LIMIT; revoked users cannot block new deliveries.
        if not recipients or sources is not None and not sources:
            return []
        args = list(recipients)
        sql = (
            "SELECT id,source,recipient,rows_json FROM trade_outbox WHERE delivered=0 AND recipient IN ("
            + ",".join("?" for _ in args)
            + ")"
        )
        if sources is not None:
            sql += " AND source IN (" + ",".join("?" for _ in sources) + ")"
            args += list(sources)
        return [
            (r[0], r[1], r[2], json.loads(r[3]))
            for r in self.db.execute(sql + " ORDER BY id LIMIT 100", args)
        ]

    def sent(self, identity):
        with self.db:
            self.db.execute(
                "UPDATE trade_outbox SET delivered=1 WHERE id=?", (identity,)
            )


def source_key(source):
    return hashlib.sha256(
        json.dumps(
            [
                source.id,
                source.native_bot_name,
                source.api_base_url,
                source.endpoints["fills"],
            ]
        ).encode()
    ).hexdigest()
