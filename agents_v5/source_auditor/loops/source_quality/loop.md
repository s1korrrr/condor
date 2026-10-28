# Source quality report

On an explicitly requested tick, inspect the latest market context identity and
recent report history. Request the fixed `source_quality` report only when the
API reports that task enabled and within its shared budget. Preserve source and
availability metadata. If identity, coverage, or freshness cannot be checked,
record the missing evidence and stop.
