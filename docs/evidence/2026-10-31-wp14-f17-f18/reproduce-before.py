import subprocess
import pytest
import condor.v5.paper as paper
import condor.v5.dashboard as dashboard

for module, filename, start, end in (
    (paper, 'condor/v5/paper.py', 'def _validate_read_tree(', '\n\nclass PaperStatusError'),
    (dashboard, 'condor/v5/dashboard.py', 'def paper_read_route(', '\n\ndef paper_chart_boundary'),
):
    source = subprocess.check_output(['git', 'show', '8af1b1c3:' + filename], text=True)
    namespace = dict(module.__dict__)
    exec(source[source.index(start):source.index(end, source.index(start))], namespace)
    name = start.removeprefix('def ').removesuffix('(')
    setattr(module, name, namespace[name])
raise SystemExit(pytest.main(['-q', 'tests/test_v5_paper_read_contract.py', '-k', 'final3_authenticated_native_api_records_are_available or history_limit_is_capped', '--basetemp=/home/rsi/dev/rsibot/.workspace/scratch/v5-paper-dashboard/tmp/f17-red-final', '-p', 'no:cacheprovider']))
