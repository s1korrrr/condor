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
    assert project(tmp_path, value)["active_executors"] == {"count": None, "covered": 0, "of": 1}


def two_controllers(value, second="second_controller"):
    value["controllers"].append({**copy.deepcopy(value["controllers"][0]), "id": second})
    return value


def test_a_published_controller_with_no_report_is_not_zero_even_when_nothing_is_listed_unavailable(tmp_path):
    # Two published controllers, an empty executor list for the first and no report at all for the second.
    value = two_controllers(status_with([]))
    assert project(tmp_path, value)["active_executors"] == {"count": None, "covered": 1, "of": 2}
    value["unavailable_controller_ids"] = ["second_controller"]  # listed or not, the second one is not covered
    assert project(tmp_path, value)["active_executors"] == {"count": None, "covered": 1, "of": 2}


def test_every_published_controller_with_a_report_is_a_count(tmp_path):
    value = two_controllers(status_with([executor(True, "a")]))
    value["native_reports"]["second_controller"] = {"executors": [executor(True, "b"), executor(False, "c")], "positions": []}
    assert project(tmp_path, value)["active_executors"] == {"count": 2, "observed_at": NOW - 5}
    value["native_reports"]["second_controller"]["executors"] = []
    assert project(tmp_path, value)["active_executors"]["count"] == 1


def test_a_report_for_a_controller_that_is_not_in_the_roster_is_not_a_count(tmp_path):
    value = status_with([executor(True)])
    value["native_reports"]["stranger"] = {"executors": [], "positions": []}
    assert project(tmp_path, value)["active_executors"] is None


def test_without_the_coverage_marker_even_a_matching_roster_is_not_a_count(tmp_path):
    for marker in (None, "none", {"a": 1}):
        value = status_with([executor(True)])
        if marker is None:
            del value["unavailable_controller_ids"]
        else:
            value["unavailable_controller_ids"] = marker
        assert project(tmp_path, value)["active_executors"] is None


def test_a_controller_that_does_not_name_itself_makes_the_roster_unreadable(tmp_path):
    value = status_with([executor(True)])
    del value["controllers"][0]["id"]
    assert project(tmp_path, value)["active_executors"] is None


def test_a_published_roster_that_is_not_a_list_of_controllers_is_never_zero(tmp_path):
    # An empty unavailable list proves coverage only of a roster that can be read; here the first controller reports
    # no executors and the roster names a second one in a shape nobody can match against the reports.
    for roster in ({"id": CONTROLLER, "pending": "second_controller"}, {}, "second_controller", 7, True):
        value = status_with([])
        value["controllers"] = roster
        assert project(tmp_path, value)["active_executors"] is None, roster


def test_without_a_published_roster_the_marker_and_the_reports_decide(tmp_path):
    value = status_with([executor(True)])
    value["controllers"] = []
    assert project(tmp_path, value)["active_executors"] == {"count": 1, "observed_at": NOW - 5}
    value["unavailable_controller_ids"] = ["x"]
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
