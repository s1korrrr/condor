"""The razer watch's incident log as a push source: one notification per new finding key and episode.

The fixture is what the watch's own ``always_on.py`` wrote in the rsibot repo's test of the same name
(``deploy/rsibot-stack/razer/fixtures/watch-incidents-episodes.jsonl``). Both repos pin its bytes.
"""

import ast
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from condor.push import events as ev
from condor.push.watch_source import MAX_BYTES, read_watch_records

FIXTURE = Path(__file__).parent / "fixtures" / "watch_incidents_episodes.jsonl"
FIXTURE_SHA256 = "38385aea8f5af02c85bf4fb3b7774d2fe88fa11ff5adb8cbb6801eee5ebacf1a"
NEVER = lambda key: False  # noqa: E731
BEFORE_ALL = 0.0


def epoch(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def fixture_records():
    return [json.loads(line) for line in FIXTURE.read_text().splitlines()]


class Seen:
    """What the outbox's ``seen`` table does: remembers committed keys between cycles."""

    def __init__(self):
        self.keys = set()

    def __call__(self, key):
        return key in self.keys

    def commit(self, detection):
        self.keys.update(detection.seen)


def titles(detection):
    return [(e.title, e.severity, e.kind) for e in detection.events]


# ------------------------------------------------------------------ the shared fixture


def test_the_fixture_is_the_bytes_both_repos_pin():
    assert hashlib.sha256(FIXTURE.read_bytes()).hexdigest() == FIXTURE_SHA256


def test_the_key_format_matches_what_the_watch_wrote():
    """``watch_finding_key`` is ``always_on.finding_key``: every record's keys are those of its findings."""
    for record in fixture_records():
        if isinstance(record["verdict"], str):
            continue
        derived = {ev.watch_finding_key(f) for f in record["verdict"]["findings"]}
        assert None not in derived and derived == set(record["finding_since"])


def test_each_episode_alerts_once_and_a_key_that_came_back_alerts_again():
    seen = Seen()
    detection = ev.detect_watch_findings(fixture_records(), started=BEFORE_ALL, seen=seen)
    assert titles(detection) == [
        ("V1 · status file is stale", "critical", "watch_finding"),
        ("V2 · container is not healthy", "critical", "watch_finding"),  # 06:10
        ("V2 · container is not healthy", "critical", "watch_finding"),  # 06:25: absent at 06:20, a new episode
        ("razer watch · Recovered", "info", "watch_resolved"),
        ("V1 · daily-loss rail paused new entries", "critical", "watch_finding"),
    ]  # in file order, then by key
    ids = [e.id for e in detection.events]
    assert len(ids) == len(set(ids)) == 5
    assert detection.skipped == 0


def test_a_replay_of_the_same_file_announces_nothing():
    seen = Seen()
    first = ev.detect_watch_findings(fixture_records(), started=BEFORE_ALL, seen=seen)
    seen.commit(first)
    again = ev.detect_watch_findings(fixture_records(), started=BEFORE_ALL, seen=seen)
    assert again.events == () and again.seen == ()


def test_the_same_key_after_the_watch_passed_is_a_new_episode():
    records = fixture_records()
    stale = records[0]
    later = json.loads(json.dumps(stale))
    later["utc"] = "2026-11-09T07:05:00Z"
    later["file"] = "20261109T070500Z-watch.json"
    later["finding_since"] = {"STATUS_STALE:v1": "2026-11-09T07:00:00Z"}
    detection = ev.detect_watch_findings([*records, later], started=BEFORE_ALL, seen=NEVER)
    assert [e.title for e in detection.events].count("V1 · status file is stale") == 2


# ------------------------------------------------------------------ activation


def test_history_before_activation_is_silent_and_an_ongoing_episode_is_announced_by_its_next_record():
    records = fixture_records()
    # Activated at 06:20: records at 06:05 and 06:15 are history.
    detection = ev.detect_watch_findings(records, started=epoch("2026-11-09T06:20:00Z"), seen=NEVER)
    assert detection.events[0].occurred_at == epoch("2026-11-09T06:30:00Z")
    got = {(e.title, e.kind) for e in detection.events}
    # The 06:30 record repeats the open STATUS_STALE episode (begun 06:00): the phone has not heard of it yet.
    assert ("V1 · status file is stale", "watch_finding") in got
    assert ("V2 · container is not healthy", "watch_finding") in got
    # Its RESOLVED (06:35) closes an incident that was announced.
    assert ("razer watch · Recovered", "watch_resolved") in got
    # Nothing from before activation was recorded as seen: nothing was announced for it, nothing to replay.
    assert all("06:05" not in key for key in detection.seen)


def test_a_recovery_of_an_incident_the_phone_never_heard_of_is_silent():
    detection = ev.detect_watch_findings(
        fixture_records()[:4], started=epoch("2026-11-09T06:34:00Z"), seen=NEVER
    )
    assert detection.events == ()  # only the RESOLVED (06:35) is after activation, and its incident was history


def test_everything_before_activation_is_silent():
    detection = ev.detect_watch_findings(fixture_records(), started=epoch("2026-11-09T09:00:00Z"), seen=NEVER)
    assert detection.events == () and detection.seen == ()


# ------------------------------------------------------------------ old and odd records


def legacy(utc, *rules, file="f.json", kind="watch"):
    findings = [{"rule": rule, "bot": bot, "error": "x"} for rule, bot in rules]
    return {
        "kind": kind,
        "utc": utc,
        "file": file,
        "verdict": {"status": "FAIL", "utc": utc, "findings": findings, "bots": {}},
    }


def test_records_written_before_finding_since_existed_still_alert_once_per_run_of_records():
    a, b = ("NOT_RUNNING", "v1"), ("DISK_UNKNOWN", "")
    records = [
        legacy("2026-11-09T06:05:00Z", a, file="1.json"),
        legacy("2026-11-09T07:05:00Z", a, file="2.json"),  # the hourly repeat: the same episode
        legacy("2026-11-09T08:05:00Z", a, b, file="3.json"),  # b is new
        legacy("2026-11-09T09:05:00Z", b, file="4.json"),  # a is gone
        legacy("2026-11-09T10:05:00Z", a, file="5.json"),  # a is back
    ]
    detection = ev.detect_watch_findings(records, started=BEFORE_ALL, seen=NEVER)
    assert [e.title for e in detection.events] == [
        "V1 · container is not running",
        "razer watch · free disk space cannot be read",
        "V1 · container is not running",
    ]


def test_a_crash_record_without_episodes_continues_the_run_before_it():
    crash = {"kind": "watch", "utc": "2026-11-09T06:10:00Z", "file": "c.json",
             "verdict": {"status": "FAIL", "findings": [{"rule": "UNEXPECTED_ERROR", "item": "watch", "error": "E"}]}}
    again = dict(crash, utc="2026-11-09T06:15:00Z", file="d.json")
    detection = ev.detect_watch_findings([crash, again], started=BEFORE_ALL, seen=NEVER)
    assert [(e.severity, e.title) for e in detection.events] == [
        ("warning", "watch · unexpected error"),
    ]


def test_rebaseline_notes_and_unreadable_records_are_not_alerts_and_the_rest_still_alert():
    good = legacy("2026-11-09T06:05:00Z", ("NOT_RUNNING", "v1"))
    note = {"kind": "rebaseline", "utc": "2026-11-09T06:00:00Z", "verdict": "REBASELINED", "service": "v1"}
    broken = [
        {"kind": "watch", "utc": "yesterday", "verdict": {"findings": []}},
        {"kind": "Watch!", "utc": "2026-11-09T06:00:00Z", "verdict": {"findings": []}},
        {"kind": "watch", "utc": "2026-11-09T06:00:00Z", "verdict": "OPEN"},
        {"kind": "watch", "utc": "2026-11-09T06:00:00Z", "verdict": {"findings": "no"}},
        {"kind": "watch", "utc": "2026-11-09T06:00:00Z", "finding_since": {"bad key": "2026-11-09T06:00:00Z"},
         "verdict": {"findings": []}},
        {"kind": "watch", "utc": "2026-11-09T06:00:00Z", "finding_since": {"NOT_RUNNING:v1": "later"},
         "verdict": {"findings": []}},
        {"kind": "watch", "utc": "2026-11-09T06:00:00Z", "verdict": {"findings": [{"rule": "x", "bot": 5}]}},
    ]
    detection = ev.detect_watch_findings([note, *broken, good], started=BEFORE_ALL, seen=NEVER)
    assert detection.skipped == len(broken) and len(detection.events) == 1


# ------------------------------------------------------------------ severity and payload


@pytest.mark.parametrize(
    "rule",
    ["NOT_RUNNING", "NOT_HEALTHY", "CONTAINER_MISSING", "RESTARTED_SINCE_BASELINE", "LOSS_RAIL_PAUSED",
     "LOSS_RAIL_UNKNOWN", "DISK_BELOW_FLOOR", "DISK_UNKNOWN", "STATUS_STALE", "MAC_TWIN_RUNNING",
     "WATCH_SILENT", "WATCH_NEVER_RAN", "DOCKER_UNAVAILABLE", "SOME_FUTURE_RULE"],
)
def test_faults_about_bots_containers_the_rail_and_the_disk_are_critical_and_unknown_rules_too(rule):
    assert ev.watch_finding_severity(rule) == "critical"


@pytest.mark.parametrize(
    "rule",
    ["CONFIG_INVALID", "STATE_INVALID", "STATE_DIR_MISMATCH", "CHECK_ERROR", "UNEXPECTED_ERROR", "WATCHDOG_TIMEOUT",
     "LOGS_UNAVAILABLE", "MAC_READ_FAILED", "MAC_DISK_LOW"],
)
def test_findings_about_the_watch_itself_are_warnings(rule):
    assert ev.watch_finding_severity(rule) == "warning"


def test_an_alert_carries_no_action_no_secret_and_none_of_the_findings_free_text():
    record = legacy("2026-11-09T06:05:00Z", ("STATUS_STALE", "v1"))
    record["verdict"]["findings"][0]["error"] = "https://hc-ping.example/00000000-secret-check-id token=abc"
    detection = ev.detect_watch_findings([record], started=BEFORE_ALL, seen=NEVER)
    (event,) = detection.events
    blob = json.dumps(event.to_dict())
    assert "secret" not in blob and "http" not in blob and "token" not in blob
    assert event.cls == "incident" and ev.ALERT_CLASSES["incident"].category == "RSIBOT_INCIDENT"
    assert event.deep_link == "rsibot://operations" and event.thread_id == "stack"
    assert len(event.id) <= 120 and len(event.collapse_key.encode()) <= 64
    assert ev.interruption_level(event.severity) == "time-sensitive"


def test_the_source_module_is_read_only():
    tree = ast.parse((Path(ev.__file__).parent / "watch_source.py").read_text())
    tree.body.pop(0)  # the docstring talks about what the module does not do
    code = ast.unparse(tree)
    for forbidden in ("write", "unlink", "rename", "replace", "O_WRONLY", "O_RDWR", "O_CREAT", "O_APPEND", "O_TRUNC",
                      "chmod", "flock", "truncate", "mkdir", "subprocess", "socket"):
        assert forbidden not in code, forbidden
    assert "O_RDONLY" in code and "O_NOFOLLOW" in code


# ------------------------------------------------------------------ the file reader


def lines(*records, tail=""):
    return "".join(json.dumps(r) + "\n" for r in records) + tail


def test_a_missing_file_in_a_mounted_folder_is_a_watch_without_incidents(tmp_path):
    read = read_watch_records(tmp_path / "incidents.jsonl")
    assert (read.records, read.bad_lines, read.error) == ([], 0, None)


def test_a_missing_folder_is_a_missing_mount_and_visible(tmp_path):
    assert read_watch_records(tmp_path / "no-such" / "incidents.jsonl").error == "mount_missing"


def test_something_that_is_not_a_file_is_unreadable(tmp_path):
    (tmp_path / "incidents.jsonl").mkdir()
    assert read_watch_records(tmp_path / "incidents.jsonl").error == "not_a_file"


def test_a_symlink_is_refused(tmp_path):
    target = tmp_path / "real.jsonl"
    target.write_text(lines({"a": 1}))
    (tmp_path / "incidents.jsonl").symlink_to(target)
    assert read_watch_records(tmp_path / "incidents.jsonl").error.startswith("open_failed:")


def test_an_unreadable_file_is_an_error_not_an_empty_read(tmp_path):
    path = tmp_path / "incidents.jsonl"
    path.write_text(lines({"a": 1}))
    path.chmod(0)
    try:
        if path.stat().st_uid == 0:
            pytest.skip("root ignores file modes")
        assert read_watch_records(path).error == "open_failed:PermissionError"
    finally:
        path.chmod(0o600)


def test_a_line_still_being_written_is_left_for_the_next_read(tmp_path):
    path = tmp_path / "incidents.jsonl"
    path.write_text(lines({"a": 1}, tail='{"b": '))
    read = read_watch_records(path)
    assert (read.records, read.bad_lines, read.error) == ([{"a": 1}], 0, None)
    path.write_text(lines({"a": 1}, {"b": 2}))
    assert read_watch_records(path).records == [{"a": 1}, {"b": 2}]


def test_lines_that_are_not_records_are_counted_not_dropped_quietly(tmp_path):
    path = tmp_path / "incidents.jsonl"
    path.write_bytes(b'{"a": 1}\nnot json\n[1, 2]\n\xff\xfe\n"text"\n\n{"b": 2}\n')
    read = read_watch_records(path)
    assert read.records == [{"a": 1}, {"b": 2}] and read.bad_lines == 4 and read.error is None


def test_a_huge_file_is_read_from_its_tail_without_its_cut_first_line(tmp_path):
    path = tmp_path / "incidents.jsonl"
    filler = json.dumps({"pad": "x" * 1000}) + "\n"
    count = MAX_BYTES // len(filler) + 50
    path.write_text(filler * count + lines({"last": True}))
    read = read_watch_records(path)
    assert read.error is None and read.bad_lines == 0 and read.records[-1] == {"last": True}
    assert len(read.records) < count


def test_the_real_fixture_reads_clean():
    read = read_watch_records(FIXTURE)
    assert len(read.records) == 5 and read.bad_lines == 0 and read.error is None
