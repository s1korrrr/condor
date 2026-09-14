---
name: hyperliquid_tokenized_perps
description: On hyperliquid_perpetual, tokenized perp contracts (equities/pre-IPO
  names like SPCX-USD) are issued by a provider and require an issuer prefix in the
  trading pair (e.g. XYZ:SPCX-USD, not SPCX-USD).
when_to_use: A user asks to trade / quote / deploy on a tokenized perp on hyperliquid_perpetual
  and the plain pair can't be found or looks unavailable — typically equity or pre-IPO
  names (e.g. SPCX, and other stock-like tickers) rather than crypto majors. Triggers
  — "trade SPCX on hyperliquid", "can't find <TICKER>-USD on hyperliquid", "is <stock>
  available on hyperliquid perp"; ES — "no encuentro <TICKER>-USD en hyperliquid",
  "puedo operar <acción> en hyperliquid perp".
created: 2026-07-02
source: builtin
---

On `hyperliquid_perpetual`, **tokenized perpetual contracts** (equities / pre-IPO
names such as `SPCX-USD`) are **not listed directly**. They are issued by a
provider, and the issuer's prefix is part of the trading pair symbol.

## The rule

Prepend the issuer prefix to the pair, **UPPERCASE**:

```
XYZ:SPCX-USD      ✅ correct
xyz:SPCX-USD      ❌ KeyError at trade time (see below)
SPCX-USD          ❌ not found
```

`XYZ:` is an example issuer. Discover current canonical pairs and issuer prefixes
from the installed connector; do not guess an issuer from the underlying ticker.

## Case matters — use UPPERCASE, and don't trust the price endpoint

The issuer prefix **must be uppercase** (`XYZ:`, not `xyz:`). The exchange returns the
symbol lowercase (`xyz:SPCX`), but the connector builds its trading-pair symbol map by
uppercasing it — the canonical hummingbot pair is `XYZ:SPCX-USD`. A lowercase pair is
**not** in the map, so `exchange_symbol_associated_to_pair` throws `KeyError`, the
order-book subscription fails on a loop, and a deployed bot silently stops **without
placing a single order**.

⚠️ **The `market-data/prices` and `candles` endpoints accept BOTH cases and return the
same price** — that layer normalizes case. This is a FALSE "case-insensitive" signal. Do
NOT use a successful price/candle lookup to conclude lowercase is fine. Only the actual
trading connector's symbol map is authoritative, and it is **case-sensitive**. Always
deploy / quote / order with the **uppercase** `XYZ:<TICKER>-USD`. (Learned the hard way
2026-07-23: a lowercase deploy passed the price check, then KeyError-looped and never
quoted; the prior working run used `XYZ:SPCX-USD` and filled cleanly.)

## When to apply

When a user asks to trade a tokenized perp on `hyperliquid_perpetual` and the
plain pair (e.g. `SPCX-USD`) can't be found:

1. Check whether the underlying is a **tokenized asset** (equity / pre-IPO
   ticker, not a native crypto).
2. Discover the actual issuer and canonical pair from the connector symbol map;
   use its exact case, rather than assuming `XYZ:`.
3. If discovery or lookup fails, report the searched symbols and capability
   limitation; failure for one issuer does not prove venue-wide unavailability.

This applies anywhere a hyperliquid perp pair is resolved — quoting, placing an
order, or deploying an executor/controller. Use the uppercase prefix everywhere,
including the controller config and bot deploy.

## Operating rule (host deployments)

For a deployed Condor instance, use connected `mcp__condor__*` tools for runtime
operations. If unavailable, report that limitation rather than changing runtime
files. Authorized repository instruction/skill maintenance may inspect and edit
source files locally without operating the deployed instance.
