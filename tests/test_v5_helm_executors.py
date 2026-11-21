"""Helm's active-executor count: published only from complete current native reports, never zero for a partial read."""

import copy

from test_v5_helm_status import NOW, helm_status, write
from condor.v5.helm import read_helm_status

CONTROLLER = "modular_spot_helm_v5_paper"


def executor(active, ident="ex-1"):
    return {"id": ident, "is_active": active, "type": "position_executor", "config": {"trading_pair": "BNB-USDC"}}


def status_with(executors, **changes):
    value = helm_status()
    value["native_reports"] = {CONTROLLER: {"executors": executors, "positions": []}}
    value["unavailable_controller_ids"] = []
    value["report_observed_at"] = NOW - 5
    value.update(changes)
    return value


def project(tmp_path, value):
    return read_helm_status(write(tmp_path, value), now=NOW)["status"]


def test_active_executors_are_counted_with_the_report_time(tmp_path):
    shown = project(tmp_path, status_with([executor(True, "a"), executor(False, "b"), executor(True, "c"), executor(True, "d")]))
    assert shown["active_executors"] == {"count": 3, "observed_at": NOW - 5}
    assert shown["withheld"] == 0


def test_zero_is_published_only_when_the_report_says_so(tmp_path):
    shown = project(tmp_path, status_with([executor(False)]))
    assert shown["active_executors"] == {"count": 0, "observed_at": NOW - 5}
    assert project(tmp_path, status_with([]))["active_executors"]["count"] == 0


def test_no_native_reports_means_not_published(tmp_path):
    # The trimmed real status in test_v5_helm_status carries no native_reports.
    assert project(tmp_path, helm_status())["active_executors"] is None


def test_a_controller_without_a_current_report_is_not_a_count(tmp_path):
    value = status_with([executor(True)], unavailable_controller_ids=[CONTROLLER])
    assert project(tmp_path, value)["active_executors"] is None


def test_a_report_without_an_executor_list_is_not_a_count(tmp_path):
    value = status_with([executor(True)])
    value["native_reports"][CONTROLLER].pop("executors")
    shown = project(tmp_path, value)
    assert shown["active_executors"] is None and shown["withheld"] == 0


def test_an_unreadable_executor_row_is_withheld_and_counted_not_skipped(tmp_path):
    for bad in ({"id": "x"}, {"id": "x", "is_active": "yes"}, "not-a-row"):
        shown = project(tmp_path, status_with([executor(True), bad]))
        assert shown["active_executors"] is None and shown["withheld"] == 1


def test_an_oversized_executor_list_is_not_truncated_into_a_count(tmp_path):
    shown = project(tmp_path, status_with([executor(True, str(i)) for i in range(513)]))
    assert shown["active_executors"] is None and shown["withheld"] == 1


def test_one_incomplete_report_among_several_is_not_a_count(tmp_path):
    value = status_with([executor(True)])
    value["native_reports"]["second_controller"] = {"positions": []}
    assert project(tmp_path, value)["active_executors"] is None


def test_report_time_missing_or_invalid_leaves_the_count_with_no_time(tmp_path):
    shown = project(tmp_path, status_with([executor(True)], report_observed_at=None))
    assert shown["active_executors"] == {"count": 1, "observed_at": None} and shown["withheld"] == 0
    shown = project(tmp_path, status_with([executor(True)], report_observed_at="yesterday"))
    assert shown["active_executors"] == {"count": 1, "observed_at": None} and shown["withheld"] == 1


def test_only_the_count_leaves_the_module(tmp_path):
    shown = project(tmp_path, status_with([executor(True, "secret-executor-id")]))
    assert "secret-executor-id" not in repr(shown) and "BNB-USDC" not in repr(shown["active_executors"])
    assert copy.deepcopy(shown["active_executors"]).keys() == {"count", "observed_at"}
