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


def test_history_before_activation_is_recorded_seen_and_only_new_episodes_announce():
    records = fixture_records()
    # Activated at 06:20: the records at 06:05 and 06:15 are history, and so is the STATUS_STALE episode (begun 06:00).
    seen = Seen()
    detection = ev.detect_watch_findings(records, started=epoch("2026-11-09T06:20:00Z"), seen=seen)
    got = [(e.title, e.kind) for e in detection.events]
    # The 06:30 record repeats STATUS_STALE@06:00: silent. NOT_HEALTHY@06:25 began after activation: announced.
    assert got == [
        ("V2 · container is not healthy", "watch_finding"),
        ("razer watch · Recovered", "watch_resolved"),  # the phone heard NOT_HEALTHY, so it hears the recovery
        ("V1 · daily-loss rail paused new entries", "watch_finding"),
    ]
    assert "watch:watch:STATUS_STALE:v1@2026-11-09T06:00:00Z" in detection.seen  # recorded as seen at activation


def test_a_pre_activation_episode_stays_silent_when_the_watch_repeats_it():
    """Round 1 (Sol F3), as the reviewer's probe: an old open episode is seen at activation, silent at its hourly repeat."""
    old = "2026-11-09T06:00:00Z"
    activated = epoch("2026-11-09T06:30:00Z")
    seen = Seen()
    first = ev.detect_watch_findings([watch_record(old, old)], started=activated, seen=seen)
    assert first.events == ()
    seen.commit(first)
    repeated = ev.detect_watch_findings(
        [watch_record(old, old), watch_record("2026-11-09T07:00:00Z", old)], started=activated, seen=seen
    )
    assert repeated.events == ()
    # ... and its recovery is silent too: the phone never heard of it.
    resolved = {"kind": "watch", "utc": "2026-11-09T07:05:00Z", "file": "2026-11-09T07:00:00Z.json", "verdict": "RESOLVED"}
    seen.commit(repeated)
    assert ev.detect_watch_findings(
        [watch_record(old, old), watch_record("2026-11-09T07:00:00Z", old), resolved], started=activated, seen=seen
    ).events == ()


def test_a_recovery_of_an_incident_the_phone_never_heard_of_is_silent():
    detection = ev.detect_watch_findings(
        fixture_records()[:4], started=epoch("2026-11-09T06:34:00Z"), seen=NEVER
    )
    assert detection.events == ()  # only the RESOLVED (06:35) is after activation, and its incident was history


def test_everything_before_activation_is_silent_and_recorded_as_seen():
    detection = ev.detect_watch_findings(fixture_records(), started=epoch("2026-11-09T09:00:00Z"), seen=NEVER)
    assert detection.events == ()
    assert len(detection.seen) == 4  # the four episodes of the fixture


# ------------------------------------------------------------------ old and odd records


def watch_record(stamp, start=None):
    value = {
        "kind": "watch",
        "utc": stamp,
        "file": stamp + ".json",
        "verdict": {"status": "FAIL", "findings": [{"rule": "NOT_RUNNING", "bot": "v1"}]},
    }
    if start is not None:
        value["finding_since"] = {"NOT_RUNNING:v1": start}
    return value


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


# ------------------------------------------------------------------ recovery after a repeat, rotation (round 1)


def test_an_hourly_repeat_inherits_the_announced_marker_so_its_recovery_is_sent():
    """Sol F5: A announced; B repeats the episode under a new file; RESOLVED names B."""
    first = watch_record("2026-11-09T06:00:00Z", "2026-11-09T06:00:00Z")
    repeat = watch_record("2026-11-09T07:00:00Z", "2026-11-09T06:00:00Z")
    resolved = {"kind": "watch", "utc": "2026-11-09T07:05:00Z", "file": repeat["file"], "verdict": "RESOLVED"}
    detected = ev.detect_watch_findings([first, repeat, resolved], started=0, seen=NEVER)
    assert [e.kind for e in detected.events] == ["watch_finding", "watch_resolved"]


def test_the_same_across_scans_the_repeat_and_the_recovery_arrive_in_later_cycles():
    seen = Seen()
    first = watch_record("2026-11-09T06:00:00Z", "2026-11-09T06:00:00Z")
    one = ev.detect_watch_findings([first], started=0, seen=seen)
    seen.commit(one)
    repeat = watch_record("2026-11-09T07:00:00Z", "2026-11-09T06:00:00Z")
    two = ev.detect_watch_findings([first, repeat], started=0, seen=seen)
    assert two.events == () and any(key.startswith("watch-open:") for key in two.seen)  # the marker moves to the new file
    seen.commit(two)
    resolved = {"kind": "watch", "utc": "2026-11-09T07:05:00Z", "file": repeat["file"], "verdict": "RESOLVED"}
    three = ev.detect_watch_findings([first, repeat, resolved], started=0, seen=seen)
    assert [e.kind for e in three.events] == ["watch_resolved"]
    seen.commit(three)
    assert ev.detect_watch_findings([first, repeat, resolved], started=0, seen=seen).events == ()  # once


def test_a_legacy_episode_keeps_its_identity_when_the_first_record_rotates_out():
    """Sol F6: the same persisting key must not be announced again because the file lost its older lines."""
    first = watch_record("2026-11-09T06:00:00Z")
    repeat = watch_record("2026-11-09T07:00:00Z")
    seen = Seen()
    one = ev.detect_watch_findings([first, repeat], started=0, seen=seen)
    assert len(one.events) == 1 and one.carried == {"watch": {"NOT_RUNNING:v1": "2026-11-09T06:00:00Z"}}
    seen.commit(one)
    rotated = ev.detect_watch_findings([repeat], started=0, seen=seen, carried=one.carried)
    assert rotated.events == () and rotated.carried == one.carried
    # Without the carried state (the reviewer's probe passes none) the identity would be rebuilt from 07:00: that is
    # exactly what the outbox keeps the state for.
    assert len(ev.detect_watch_findings([repeat], started=0, seen=seen).events) == 1


def test_carried_state_never_changes_what_a_full_rescan_sees():
    records = [watch_record("2026-11-09T06:00:00Z"), watch_record("2026-11-09T07:00:00Z")]
    seen = Seen()
    one = ev.detect_watch_findings(records, started=0, seen=seen)
    seen.commit(one)
    again = ev.detect_watch_findings(records, started=0, seen=seen, carried=one.carried)
    assert again.events == () and again.seen == () and again.carried == one.carried


def test_a_start_that_would_be_after_the_record_is_never_carried_back():
    """A carried start later than the record itself (a rescan of old lines) is ignored: the record's own time stands."""
    old = watch_record("2026-11-09T06:00:00Z")
    detection = ev.detect_watch_findings(
        [old], started=0, seen=NEVER, carried={"watch": {"NOT_RUNNING:v1": "2026-11-09T09:00:00Z"}}
    )
    assert "watch:watch:NOT_RUNNING:v1@2026-11-09T06:00:00Z" in detection.seen


def test_a_crash_record_after_a_rotation_continues_the_carried_episode():
    crash = {"kind": "watch", "utc": "2026-11-09T07:10:00Z", "file": "c.json",
             "verdict": {"status": "FAIL", "findings": [{"rule": "UNEXPECTED_ERROR", "item": "watch", "error": "E"}]}}
    carried = {"watch": {"UNEXPECTED_ERROR:watch": "2026-11-09T06:55:00Z"}}
    seen = {"watch:watch:UNEXPECTED_ERROR:watch@2026-11-09T06:55:00Z"}
    assert ev.detect_watch_findings([crash], started=0, seen=seen.__contains__, carried=carried).events == ()


def test_the_reader_fingerprints_an_unfinished_last_line_and_only_that(tmp_path):
    path = tmp_path / "incidents.jsonl"
    path.write_bytes(b'{"a": 1}\n{"b": ')
    first = read_watch_records(path)
    assert first.tail_sha and first.records == [{"a": 1}] and first.bad_lines == 0
    assert read_watch_records(path).tail_sha == first.tail_sha  # unchanged fragment, same fingerprint
    path.write_bytes(b'{"a": 1}\n{"b": 2')
    assert read_watch_records(path).tail_sha != first.tail_sha  # still growing
    path.write_bytes(b'{"a": 1}\n{"b": 2}\n')
    done = read_watch_records(path)
    assert done.tail_sha is None and done.records == [{"a": 1}, {"b": 2}]
    path.write_bytes(b'{"a": 1}\n  \n')
    assert read_watch_records(path).tail_sha is None  # white space is not a record
