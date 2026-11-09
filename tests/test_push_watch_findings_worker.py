"""The worker end to end for the ``watch`` source: a file in, pushes out, honest heartbeat."""

import json
from datetime import datetime, timezone

import pytest

from condor.push.config import PushConfigError, parse_push_config
from condor.push.heartbeat import evaluate_heartbeat
from tests.test_push_config import BASE
from tests.test_push_worker import Rig


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Watch:
    """The watch's incident log for one rig: append what ``always_on.py`` would."""

    def __init__(self, rig, path):
        self.rig, self.path, self.number = rig, path, 0

    def incident(self, *findings, since=None, kind="watch"):
        now = self.rig.clock()
        self.number += 1
        keys = [f"{rule}:{subject}" for rule, subject in findings]
        record = {
            "kind": kind,
            "utc": iso(now),
            "file": f"/state/incidents/{self.number}-{kind}.json",
            "verdict": {
                "status": "FAIL",
                "utc": iso(now),
                "findings": [{"rule": r, "bot": s} for r, s in findings],
            },
            "finding_since": {key: (since or {}).get(key, iso(now)) for key in keys},
        }
        self.append(json.dumps(record) + "\n")
        return record

    def resolved(self, last, kind="watch"):
        self.append(
            json.dumps({"kind": kind, "utc": iso(self.rig.clock()), "verdict": "RESOLVED", "file": last["file"]}) + "\n"
        )

    def append(self, text):
        with self.path.open("a") as stream:
            stream.write(text)


@pytest.fixture
def watch_rig(tmp_path):
    folder = tmp_path / "watch-state"
    folder.mkdir()
    path = folder / "incidents.jsonl"
    rig = Rig(tmp_path, extra={"watch_incidents_path": str(path)})
    rig.devices()
    rig.watch = Watch(rig, path)
    yield rig
    rig.close()


def watch_pushes(rig):
    return [(t, c) for t, c, _ in rig.pushes() if t.startswith(("V1", "V2", "razer"))]


def test_a_new_finding_pushes_to_every_device_once_and_a_repeat_does_not(watch_rig):
    rig = watch_rig
    rig.cycle()
    assert watch_pushes(rig) == []  # no incidents yet: a missing file is a quiet watch
    record = rig.watch.incident(("NOT_RUNNING", "v1"))
    rig.cycle()
    assert watch_pushes(rig) == [("V1 · container is not running", "incident")] * 2  # phone and watch
    rig.cycle(60)
    rig.cycle(60)
    assert len(watch_pushes(rig)) == 2
    assert rig.worker.heartbeat_payload(rig.clock())["status"] == "running"
    rig.watch.resolved(record)
    rig.cycle()
    assert ("razer watch · Recovered", "incident") in watch_pushes(rig)


def test_a_second_fault_alerts_while_the_first_is_still_open(watch_rig):
    """The point of the whole source: hc-ping is already down, a different fault must still reach the phone."""
    rig = watch_rig
    first = rig.watch.incident(("NOT_RUNNING", "v1"))
    rig.cycle()
    rig.clock.advance(300)
    rig.watch.incident(
        ("NOT_RUNNING", "v1"), ("LOSS_RAIL_PAUSED", "v2"), since=first["finding_since"]
    )
    rig.cycle()
    assert [t for t, _ in watch_pushes(rig)] == [
        "V1 · container is not running",
        "V1 · container is not running",
        "V2 · daily-loss rail paused new entries",
        "V2 · daily-loss rail paused new entries",
    ]


def test_a_restart_of_the_worker_repeats_nothing(watch_rig):
    rig = watch_rig
    rig.watch.incident(("DISK_BELOW_FLOOR", ""))
    rig.cycle()
    sent = len(rig.pushes())
    rig.restart()
    rig.cycle()
    rig.cycle(600)
    assert len(rig.pushes()) == sent


def test_history_before_the_worker_was_activated_is_silent(tmp_path):
    folder = tmp_path / "watch-state"
    folder.mkdir()
    path = folder / "incidents.jsonl"
    old = {
        "kind": "watch", "utc": "2026-01-01T00:00:00Z", "file": "x.json",
        "verdict": {"findings": [{"rule": "NOT_RUNNING", "bot": "v1"}]},
        "finding_since": {"NOT_RUNNING:v1": "2026-01-01T00:00:00Z"},
    }
    path.write_text(json.dumps(old) + "\n")
    rig = Rig(tmp_path, extra={"watch_incidents_path": str(path)})
    try:
        rig.devices()
        rig.cycle()
        assert watch_pushes(rig) == []
    finally:
        rig.close()


def test_an_unreadable_file_degrades_the_heartbeat_keeps_the_checkpoint_and_catches_up(watch_rig):
    rig = watch_rig
    rig.watch.incident(("NOT_RUNNING", "v1"))
    rig.watch.path.chmod(0)
    try:
        if rig.watch.path.stat().st_uid == 0:
            pytest.skip("root ignores file modes")
        rig.cycle()
        beat = rig.worker.heartbeat_payload(rig.clock())
        assert beat["status"] == "degraded" and "watch_findings_unreadable" in beat["degraded_reasons"]
        assert beat["watch_findings"]["state"] == "unreadable"
        assert watch_pushes(rig) == []
    finally:
        rig.watch.path.chmod(0o600)
    rig.cycle()
    assert len(watch_pushes(rig)) == 2  # nothing was skipped
    assert rig.worker.heartbeat_payload(rig.clock())["status"] == "running"


def test_a_missing_mount_is_degraded_not_quiet(watch_rig):
    rig = watch_rig
    rig.watch.path.parent.rmdir()
    rig.cycle()
    beat = rig.worker.heartbeat_payload(rig.clock())
    assert "watch_findings_unreadable" in beat["degraded_reasons"]
    assert beat["watch_findings"] == {"state": "unreadable", "error": "mount_missing"}


def test_a_corrupt_line_degrades_the_heartbeat_but_the_good_records_still_alert(watch_rig):
    rig = watch_rig
    rig.watch.append("this is not json\n")
    rig.watch.incident(("NOT_HEALTHY", "v2"))
    rig.cycle()
    beat = rig.worker.heartbeat_payload(rig.clock())
    assert "watch_findings_corrupt" in beat["degraded_reasons"] and beat["watch_findings"]["bad_records"] == 1
    assert [t for t, _ in watch_pushes(rig)] == ["V2 · container is not healthy"] * 2
    # the app sees the degraded reason through the existing heartbeat route
    assert "watch_findings_corrupt" in evaluate_heartbeat(beat, rig.clock())["degraded_reasons"]


def test_an_unexpected_error_in_the_source_degrades_and_the_rest_of_the_cycle_carries_on(watch_rig, monkeypatch):
    rig = watch_rig
    rig.watch.incident(("NOT_RUNNING", "v1"))

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("condor.push.events.detect_watch_findings", boom)
    rig.cycle()
    beat = rig.worker.heartbeat_payload(rig.clock())
    assert "watch_findings_error" in beat["degraded_reasons"] and rig.worker.last_cycle_error is None


def test_without_the_config_key_the_source_is_off(tmp_path):
    rig = Rig(tmp_path)
    try:
        rig.devices()
        rig.cycle()
        beat = rig.worker.heartbeat_payload(rig.clock())
        assert "watch_findings" not in beat and rig.outbox.started("watch") is None
    finally:
        rig.close()


def test_the_worker_only_reads_the_file(watch_rig):
    rig = watch_rig
    rig.watch.incident(("NOT_RUNNING", "v1"))
    before = rig.watch.path.read_bytes()
    stat_before = rig.watch.path.stat()
    rig.cycle()
    assert rig.watch.path.read_bytes() == before
    assert rig.watch.path.stat().st_mtime_ns == stat_before.st_mtime_ns
    assert sorted(p.name for p in rig.watch.path.parent.iterdir()) == ["incidents.jsonl"]


# ------------------------------------------------------------------ round 1 (torn tail, rotation, activation)


def torn(rig, stamp="2026-11-09T07:00:00Z"):
    record = {"kind": "watch", "utc": stamp, "file": "t.json",
              "verdict": {"findings": [{"rule": "NOT_RUNNING", "bot": "v1"}]}}
    return json.dumps(record).encode()[:-20]


def test_a_record_that_stays_unfinished_is_degraded_after_one_watch_period(watch_rig):
    """Sol F4 / Kestrel 5: a torn last line (no newline) is retried, then reported; never healthy forever."""
    rig = watch_rig
    rig.watch.path.write_bytes(torn(rig))
    rig.cycle()
    assert rig.worker.heartbeat_payload(rig.clock())["watch_findings"]["state"] == "ok"  # may still be in progress
    rig.cycle(300)  # one watch period: still waiting
    assert rig.worker.heartbeat_payload(rig.clock())["watch_findings"]["state"] == "ok"
    rig.cycle(301)  # unchanged for more than 10 minutes
    beat = rig.worker.heartbeat_payload(rig.clock())
    assert beat["watch_findings"] == {"state": "corrupt", "bad_records": 1, "stalled_tail": True}
    assert "watch_findings_corrupt" in beat["degraded_reasons"] and beat["status"] == "degraded"
    assert watch_pushes(rig) == []


def test_a_record_still_being_written_is_not_called_torn_while_it_grows(watch_rig):
    rig = watch_rig
    text = torn(rig)
    for end in (10, 40, 70, 100):
        rig.watch.path.write_bytes(text[:end])
        rig.cycle(400)  # each cycle is later than the period, but the fragment is different every time
        assert rig.worker.heartbeat_payload(rig.clock())["watch_findings"]["state"] == "ok"


def test_the_stalled_tail_clock_survives_a_restart_and_a_finished_record_clears_it(watch_rig):
    rig = watch_rig
    rig.watch.path.write_bytes(torn(rig))
    rig.cycle()
    rig.restart()
    rig.cycle(700)
    assert rig.worker.heartbeat_payload(rig.clock())["watch_findings"]["state"] == "corrupt"  # the clock was kept
    rig.watch.path.write_bytes(b"")  # the file is repaired by hand
    rig.cycle()
    assert rig.worker.heartbeat_payload(rig.clock())["watch_findings"] == {"state": "ok", "bad_records": 0}
    rig.cycle(60)
    assert rig.worker.heartbeat_payload(rig.clock())["status"] == "running"


def test_a_legacy_episode_is_not_announced_again_when_the_first_record_rotates_out(watch_rig):
    rig = watch_rig
    now = rig.clock()
    first = {"kind": "watch", "utc": iso(now), "file": "1.json",
             "verdict": {"findings": [{"rule": "NOT_RUNNING", "bot": "v1"}]}}
    repeat = dict(first, utc=iso(now + 3600), file="2.json")
    rig.watch.append(json.dumps(first) + "\n")
    rig.cycle()
    rig.clock.advance(3600)
    rig.watch.append(json.dumps(repeat) + "\n")
    rig.cycle()
    sent = len(rig.pushes())
    assert sent == 2  # phone and watch, once
    rig.watch.path.write_text(json.dumps(repeat) + "\n")  # the log rotated: only the repeat is left
    rig.cycle()
    rig.restart()
    rig.cycle(60)
    assert len(rig.pushes()) == sent


def test_an_episode_that_began_before_the_worker_was_activated_stays_silent_at_its_repeat_and_recovery(tmp_path):
    folder = tmp_path / "watch-state"
    folder.mkdir()
    path = folder / "incidents.jsonl"
    rig = Rig(tmp_path, extra={"watch_incidents_path": str(path)})
    try:
        rig.devices()
        old = iso(rig.clock() - 7200)
        record = {"kind": "watch", "utc": old, "file": "old.json",
                  "verdict": {"findings": [{"rule": "NOT_RUNNING", "bot": "v1"}]},
                  "finding_since": {"NOT_RUNNING:v1": old}}
        path.write_text(json.dumps(record) + "\n")
        rig.cycle()  # activation: history is recorded as seen
        rig.clock.advance(3600)
        repeat = dict(record, utc=iso(rig.clock()), file="repeat.json")
        path.write_text(path.read_text() + json.dumps(repeat) + "\n")
        rig.cycle()
        rig.watch = Watch(rig, path)
        rig.watch.resolved(repeat)
        rig.cycle()
        assert watch_pushes(rig) == []
    finally:
        rig.close()


# ------------------------------------------------------------------ config


def test_the_path_is_optional_absolute_and_validated():
    assert parse_push_config(BASE).watch_incidents_path is None
    config = parse_push_config({**BASE, "watch_incidents_path": "/watch/incidents.jsonl"})
    assert config.watch_incidents_path.as_posix() == "/watch/incidents.jsonl"
    for bad in ("incidents.jsonl", "/watch/../etc/x", "", 5, "/x\x00y"):
        with pytest.raises(PushConfigError):
            parse_push_config({**BASE, "watch_incidents_path": bad})
