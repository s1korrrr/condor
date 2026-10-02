"""The ``condor-push`` worker: observe the fleet, detect events, deliver pushes.

One process, one replica (an exclusive lock on the outbox enforces it). It
reads the registered bots through the same fixed GET routes the Telegram fleet
worker uses, with the same sources and credentials (``push.fleet_config`` names
the Telegram worker's private JSON), and calls nothing else: no trading,
lifecycle or control route.

A cycle: refresh sources, read every bot concurrently, run the pure detectors,
commit events and dedup keys atomically, deliver due notifications, publish a
heartbeat. A failed read never advances a checkpoint, so nothing is skipped and
nothing is announced twice.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Sequence
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from condor.fleet_telegram import (
    BotSource,
    ConfigError,
    NativeReadClient,
    NativeReadError,
    WorkerConfig,
    _catalogue_source_rows,
    _extract_rows,
    _validate_owner_identity,
)
from condor.fleet_telegram import load_config as load_fleet_config
from condor.fleet_telegram import (
    safe_native_read_error,
)
from condor.fleet_trade_alerts import source_key
from condor.push import events as ev
from condor.push.apns import ApnsClient, HttpxApnsTransport, ProviderTokens
from condor.push.config import PushConfig, PushConfigError
from condor.push.delivery import Deliverer
from condor.push.heartbeat import ExternalPing
from condor.push.heartbeat import healthcheck as heartbeat_healthcheck
from condor.push.heartbeat import write_heartbeat_file
from condor.push.store import Device, Outbox, Registry

logger = logging.getLogger("condor.push")

MAX_READ_CONCURRENCY = 8
FILL_LIMIT = 1000
EXECUTOR_LIMIT = 500
PRUNE_EVERY_SECONDS = 3600.0
BACKLOG_ALARM_SECONDS = 900.0
VERSION = 1
GLOBAL_SOURCES = ("stack", "test", "summary", "market")


# --------------------------------------------------------------------------- reading


def with_limit(path: str, limit: int) -> str:
    parts = urlsplit(path)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k != "limit"] + [
        ("limit", str(limit))
    ]
    return urlunsplit(("", "", parts.path, urlencode(query), ""))


class NativeFleetReader:
    """GET-only reads over the fleet worker's own validated client."""

    def __init__(self, fleet: WorkerConfig):
        self._client = NativeReadClient(fleet)

    async def __aenter__(self) -> "NativeFleetReader":
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._client.__aexit__(*exc)

    async def get(self, source: BotSource, path: str) -> Any:
        return await self._client.get_url(
            source.api_base_url, source.api_username, source.api_password, path
        )

    async def catalogue(self) -> Any:
        return await self._client.get_catalogue()


@dataclass
class SourceReads:
    runtime: Any = None
    runtime_ok: bool = False
    runtime_error: str | None = None
    fills: list | None = None
    fills_error: str | None = None
    executors: list | None = None
    executors_error: str | None = None
    native_status: Any = None
    operations: Any = None


def read_error_reason(exc: Exception) -> str:
    if isinstance(exc, NativeReadError):
        details = safe_native_read_error(exc)
        return str(details["reason"]) + (
            f" HTTP {details['http_status']}" if details["http_status"] else ""
        )
    return exc.__class__.__name__


class FleetSources:
    """Seed sources plus catalogue discovery; the last good catalogue survives an outage."""

    def __init__(self, fleet: WorkerConfig, outbox: Outbox):
        self._fleet, self._outbox = fleet, outbox
        self._seeds = {s.native_bot_name: s for s in fleet.bots}
        self._discovered: dict[str, BotSource] = {}
        self._next_refresh = 0.0
        self.error: str | None = None
        cached = outbox.get_kv("catalogue") if fleet.discovery else None
        if cached is not None:
            self._adopt(cached)

    def _adopt(self, payload: Any) -> list[BotSource]:
        found = {
            s.native_bot_name: s for s in _catalogue_source_rows(payload, self._fleet)
        }
        taken = {s.id: s.native_bot_name for s in self._seeds.values()}
        merged = {}
        for name, source in found.items():
            if name in self._seeds:
                continue  # an established seed keeps its URLs and dedup identity
            if taken.get(source.id, name) != name:
                raise ConfigError("catalogue alias conflicts with a configured source")
            merged[name] = source
        added = [s for n, s in merged.items() if n not in self._discovered]
        self._discovered = merged
        return added

    @property
    def sources(self) -> list[BotSource]:
        merged = {**self._seeds, **self._discovered}
        return [merged[name] for name in sorted(merged, key=lambda n: merged[n].id)]

    async def refresh(self, reader: NativeFleetReader, now: float) -> list[BotSource]:
        discovery = self._fleet.discovery
        if discovery is None or now < self._next_refresh:
            return []
        self._next_refresh = now + discovery.refresh_seconds
        try:
            payload = await reader.catalogue()
            added = self._adopt(payload)
            self._outbox.set_kv("catalogue", payload)
            self.error = None
            return added
        except Exception as exc:  # noqa: BLE001 - keep serving the last good catalogue
            self.error = (
                "catalogue_invalid"
                if isinstance(exc, ConfigError)
                else read_error_reason(exc)
            )
            logger.warning(
                "catalogue refresh failed reason=%s; keeping %d source(s)",
                self.error,
                len(self.sources),
            )
            return []


# --------------------------------------------------------------------------- worker


class PushWorker:
    def __init__(
        self,
        config: PushConfig,
        fleet: WorkerConfig,
        *,
        registry: Registry,
        outbox: Outbox,
        deliverer: Deliverer,
        reader: NativeFleetReader,
        ping: ExternalPing,
        clock: Callable[[], float] = time.time,
        market_score: Callable[[], Awaitable[float | None]] | None = None,
    ):
        self.config, self.registry, self.outbox, self.deliverer = (
            config,
            registry,
            outbox,
            deliverer,
        )
        self.reader, self.ping, self._clock, self._market_score = (
            reader,
            ping,
            clock,
            market_score,
        )
        self.fleet_sources = FleetSources(fleet, outbox)
        self._stopping = asyncio.Event()
        self._last_prune = 0.0
        self.last_cycle_at: float | None = None
        self.last_cycle_error: str | None = None
        self.source_status: dict[str, dict[str, str]] = {}
        self._all_unreadable = False
        now = clock()
        for name in GLOBAL_SOURCES:
            outbox.start_source(name, now)
        for source in self.fleet_sources.sources:
            outbox.start_source(source_key(source), now)

    # ---- reading

    async def _read_source(
        self, source: BotSource, semaphore: asyncio.Semaphore
    ) -> SourceReads:
        reads = SourceReads()
        name = source.native_bot_name
        async with semaphore:
            try:
                payload = await self.reader.get(source, source.endpoints["status"])
                _validate_owner_identity(payload, source)
                reads.runtime, reads.runtime_ok = payload, True
            except (NativeReadError, ValueError) as exc:
                reads.runtime_error = read_error_reason(exc)
            try:
                payload = await self.reader.get(
                    source, with_limit(source.endpoints["fills"], FILL_LIMIT)
                )
                _validate_owner_identity(payload, source, require_rows=True)
                reads.fills = _extract_rows(payload, "fills")
            except (NativeReadError, ValueError) as exc:
                reads.fills_error = read_error_reason(exc)
            try:
                payload = await self.reader.get(
                    source, with_limit(source.endpoints["executors"], EXECUTOR_LIMIT)
                )
                _validate_owner_identity(payload, source, require_rows=True)
                reads.executors = _extract_rows(payload, "executors")
            except (NativeReadError, ValueError) as exc:
                reads.executors_error = read_error_reason(exc)
            # Best effort: the orchestration status and the Operations workspace are
            # extra evidence. Their absence is never read as health or as a fault.
            try:
                status = await self.reader.get(
                    source, f"/bot-orchestration/{quote(name, safe='')}/status"
                )
                inner = ev.native_status(status)
                if inner is not None and inner.get("bot_name") in (None, name):
                    reads.native_status = status
            except (NativeReadError, ValueError):
                pass
            try:
                reads.operations = await self.reader.get(
                    source, f"/trading-visuals/operations?bot={quote(name, safe='')}"
                )
            except (NativeReadError, ValueError):
                pass
        return reads

    # ---- one cycle

    async def cycle(self) -> None:
        now = self._clock()
        for source in await self.fleet_sources.refresh(self.reader, now):
            self.outbox.start_source(source_key(source), now)
        sources = self.fleet_sources.sources
        semaphore = asyncio.Semaphore(MAX_READ_CONCURRENCY)
        results = await asyncio.gather(
            *(self._read_source(s, semaphore) for s in sources)
        )
        devices = self.registry.active_devices()
        self.source_status = {}
        infos: list[tuple[ev.SourceInfo, SourceReads]] = []
        for source, reads in zip(sources, results, strict=True):
            info = self._info(source)
            infos.append((info, reads))
            self.source_status[info.tag] = self._ingest(info, reads, devices, now)
        self._all_unreadable = bool(infos) and not any(r.runtime_ok for _, r in infos)
        self._incidents(infos, devices, now)
        self._test_requests(now)
        self._summary(infos, devices, now)
        await self._market(devices, now)
        await self.deliverer.deliver_due()
        self._finish_test_requests()
        if now - self._last_prune >= PRUNE_EVERY_SECONDS:
            self._last_prune = now
            self.outbox.prune(now, self.config.retention_days * 86400.0)
            self.registry.prune_requests(now - 7 * 86400.0)
        self.last_cycle_at = self._clock()
        self.last_cycle_error = None

    def _info(self, source: BotSource) -> ev.SourceInfo:
        quote_currency = self.config.quote_currencies.get(
            source.native_bot_name, source.quote_currency
        )
        return ev.SourceInfo(
            source_key(source),
            source.native_bot_name,
            ev.bot_tag(source.native_bot_name, source.label, self.config.labels),
            quote_currency,
        )

    def _ingest(
        self,
        info: ev.SourceInfo,
        reads: SourceReads,
        devices: Sequence[Device],
        now: float,
    ) -> dict[str, str]:
        status: dict[str, str] = {}
        started = self.outbox.started(info.key)
        assert started is not None
        seen = self.outbox.seen_checker(info.key)

        def run(kind: str, produce: Callable[[], ev.Detection]) -> None:
            try:
                detection = produce()
                self.outbox.commit(
                    info.key,
                    seen=detection.seen,
                    events=detection.events,
                    devices=devices,
                    now=now,
                    primed=kind if kind == "executors" and detection.primed else None,
                )
                status[kind] = "ok"
            except ValueError as exc:
                # An unsafe batch (bad identity, missing exact economics, coverage gap) holds
                # this source's checkpoint; the next cycle reads the same rows again.
                status[kind] = "held: " + str(exc)[:80]
                logger.warning(
                    "push %s held source=%s reason=%s", kind, info.tag, str(exc)[:80]
                )

        if reads.fills is not None:
            run(
                "fills",
                lambda: ev.detect_fills(info, reads.fills, started=started, seen=seen),
            )
        else:
            status["fills"] = "unreadable: " + (reads.fills_error or "")
        if reads.executors is not None:
            primed = self.outbox.is_primed(info.key, "executors")
            run(
                "executors",
                lambda: ev.detect_executors(
                    info, reads.executors, started=started, seen=seen, primed=primed
                ),
            )
        else:
            status["executors"] = "unreadable: " + (reads.executors_error or "")
        if reads.runtime_ok:
            run(
                "risk",
                lambda: ev.detect_risk(
                    info,
                    reads.runtime,
                    now=now,
                    seen=seen,
                    stale_seconds=self.config.thresholds.stale_seconds,
                ),
            )
        else:
            status["runtime"] = "unreadable: " + (reads.runtime_error or "")
        conditions = self.outbox.conditions()
        events, changes = ev.evaluate_health(
            info,
            now=now,
            thresholds=self.config.thresholds,
            runtime_payload=reads.runtime,
            runtime_ok=reads.runtime_ok,
            status_payload=reads.native_status,
            conditions=conditions,
        )
        if events or changes:
            self.outbox.commit(
                info.key, events=events, devices=devices, conditions=changes, now=now
            )
        return status

    def _incidents(
        self,
        infos: Sequence[tuple[ev.SourceInfo, SourceReads]],
        devices: Sequence[Device],
        now: float,
    ) -> None:
        started = self.outbox.started("stack")
        assert started is not None
        for _, reads in infos:
            store = (
                reads.operations.get("incident_store")
                if isinstance(reads.operations, Mapping)
                else None
            )
            detection = ev.detect_incidents(
                store,
                started=started,
                seen=self.outbox.seen_checker("stack"),
                min_severity=self.config.incident_min_severity,
            )
            if detection.events or detection.seen:
                self.outbox.commit(
                    "stack",
                    seen=detection.seen,
                    events=detection.events,
                    devices=devices,
                    now=now,
                )

    def _test_requests(self, now: float) -> None:
        for request in self.registry.requests("pending"):
            wanted = set(request["device_ids"])
            targets = [
                d
                for d in self.registry.devices_for_user(request["user_id"])
                if d.active and (not wanted or d.device_id in wanted)
            ]
            event = ev.make_test_event(request["id"], now=now)
            if not targets:
                self.registry.set_request(
                    request["id"], "done", {"error": "no active device to send to"}
                )
                continue
            self.outbox.commit("test", events=[event], devices=targets, now=now)
            self.registry.set_request(
                request["id"], "queued", {"event": event.id, "devices": len(targets)}
            )

    def _finish_test_requests(self) -> None:
        for request in self.registry.requests("queued"):
            event_id = "test:" + request["id"]
            rows = self.outbox.deliveries_for(event_id)
            if rows and all(r["state"] != "pending" for r in rows):
                self.registry.set_request(
                    request["id"],
                    "done",
                    {
                        "deliveries": [
                            {
                                "device_id": r["device_id"],
                                "state": r["state"],
                                "error": r["last_error"],
                            }
                            for r in rows
                        ]
                    },
                )

    def _summary(
        self,
        infos: Sequence[tuple[ev.SourceInfo, SourceReads]],
        devices: Sequence[Device],
        now: float,
    ) -> None:
        cfg = self.config.summary
        if not cfg.enabled or not infos:
            return
        date = ev.summary_due(
            now,
            hour_utc=cfg.hour_utc,
            minute=cfg.minute,
            last_date=self.outbox.get_kv("summary_last_date"),
        )
        if date is None:
            return
        days = [
            ev.summarize_bot(
                info,
                reads.runtime,
                now=now,
                stale_seconds=self.config.thresholds.stale_seconds,
            )
            for info, reads in infos
        ]
        self.outbox.commit(
            "summary",
            events=[ev.fleet_summary(days, now=now)],
            devices=devices,
            now=now,
        )
        self.outbox.set_kv("summary_last_date", date)

    async def _market(self, devices: Sequence[Device], now: float) -> None:
        if self._market_score is None:
            return
        try:
            score = await self._market_score()
        except (
            Exception
        ) as exc:  # noqa: BLE001 - an optional class must never stop the cycle
            logger.warning("market score unavailable error=%s", exc.__class__.__name__)
            return
        raw = self.outbox.get_kv("verdict") or {}
        state, event = ev.step_verdict(
            ev.VerdictState(raw.get("state"), raw.get("last_extreme")), score, now
        )
        self.outbox.set_kv(
            "verdict", {"state": state.state, "last_extreme": state.last_extreme}
        )
        if event is not None:
            self.outbox.commit("market", events=[event], devices=devices, now=now)

    # ---- heartbeat

    def degraded_reasons(self, now: float) -> list[str]:
        reasons = []
        apns = self.deliverer.apns
        if apns.auth_ok is False or (apns.consecutive_failures >= 5):
            reasons.append("apns")
        if self._all_unreadable:
            reasons.append("sources_unreadable")
        if self.last_cycle_error:
            reasons.append("cycle_error")
        oldest = self.outbox.db.execute(
            "SELECT MIN(created) FROM deliveries WHERE state='pending'"
        ).fetchone()[0]
        if oldest is not None and now - oldest > BACKLOG_ALARM_SECONDS:
            reasons.append("delivery_backlog")
        return reasons

    def heartbeat_payload(self, now: float) -> dict[str, Any]:
        reasons = self.degraded_reasons(now)
        apns = self.deliverer.apns
        return {
            "version": VERSION,
            "status": "degraded" if reasons else "running",
            "degraded_reasons": reasons,
            "updated_at": now,
            "last_cycle_at": self.last_cycle_at,
            "pending_deliveries": self.outbox.counts().get("pending", 0),
            "apns": {
                "last_success_at": apns.last_success_at,
                "last_error": apns.last_error,
                "consecutive_failures": apns.consecutive_failures,
                "auth_ok": apns.auth_ok,
            },
            "sources": self.source_status,
            "external_ping": {
                "configured": self.ping.configured,
                "last_success_at": self.ping.last_success_at,
            },
        }

    async def beat(self) -> None:
        now = self._clock()
        payload = self.heartbeat_payload(now)
        write_heartbeat_file(self.config.heartbeat_path, payload)
        try:
            self.registry.set_meta("worker_heartbeat", payload)
        except (
            Exception
        ) as exc:  # noqa: BLE001 - the heartbeat file and the ping still go out
            logger.warning(
                "heartbeat registry write failed error=%s", exc.__class__.__name__
            )
        if self.ping.configured:
            await self.ping.ping(payload["status"] == "running")

    # ---- loops

    async def _cycle_loop(self) -> None:
        delay = float(self.config.poll_seconds)
        while not self._stopping.is_set():
            try:
                await self.cycle()
                delay = float(self.config.poll_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - never die on one bad cycle
                self.last_cycle_error = exc.__class__.__name__
                delay = min(60.0, max(delay, 5.0) * 2)
                logger.warning(
                    "push cycle failed error=%s; retrying in %.0fs",
                    exc.__class__.__name__,
                    delay,
                )
            await self._sleep(delay)

    async def _beat_loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.beat()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("heartbeat failed error=%s", exc.__class__.__name__)
            await self._sleep(float(self.config.heartbeat_interval_seconds))

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def run(self) -> None:
        logger.info(
            "push worker started sources=%d environment=%s heartbeat_host=%s",
            len(self.fleet_sources.sources),
            self.config.environment,
            self.ping.host or "none",
        )
        tasks = [
            asyncio.create_task(self._cycle_loop()),
            asyncio.create_task(self._beat_loop()),
        ]
        try:
            await self._stopping.wait()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def stop(self) -> None:
        self._stopping.set()


# --------------------------------------------------------------------------- entry


async def run_worker(config: PushConfig) -> None:
    if not config.enabled:
        raise PushConfigError("push is disabled in the private configuration")
    configure_logging()
    fleet = load_fleet_config(str(config.fleet_config))
    registry = Registry(config.registry_path)
    outbox = Outbox(config.outbox_path)
    transport = HttpxApnsTransport()
    apns = ApnsClient(
        ProviderTokens(config.key_path, config.key_id, config.team_id), transport
    )
    deliverer = Deliverer(outbox, registry, apns, config)
    ping = ExternalPing(config.heartbeat_url)
    try:
        async with NativeFleetReader(fleet) as reader:
            worker = PushWorker(
                config,
                fleet,
                registry=registry,
                outbox=outbox,
                deliverer=deliverer,
                reader=reader,
                ping=ping,
            )
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, worker.stop)
            await worker.run()
    finally:
        await transport.close()
        outbox.close()


def configure_logging() -> None:
    import os

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # httpx logs every request URL, and an APNs URL contains the device token.
    for noisy in ("httpx", "httpcore", "h2", "hpack", "hyperframe"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def healthcheck(state_dir: str, *, now: float | None = None) -> bool:
    from pathlib import Path

    from condor.push.config import HEARTBEAT_FILE

    return heartbeat_healthcheck(Path(state_dir) / HEARTBEAT_FILE, now=now)
