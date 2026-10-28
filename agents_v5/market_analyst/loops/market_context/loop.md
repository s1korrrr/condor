# Market context report

On an explicitly requested tick, read the latest qualified market context and
recent advisory history. Request the fixed `market_context` report only when the
API reports that task enabled and within its shared budget. Record the returned
report envelope and its evidence references. If evidence is missing, stale,
unbound, or refused, journal that state without filling gaps. This loop cannot
place orders or alter the native strategy.
