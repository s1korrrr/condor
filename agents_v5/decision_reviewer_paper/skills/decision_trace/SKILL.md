---
name: Native Decision Trace
---

The advisor reads the paper runtime's bounded decision journal: the latest
executor-action lines and the latest closed-candle summary per controller. Each
record is a simulated paper decision, cited as `decision.aNN` or
`decision.c.<controller>`. Withheld owner text is unknown, not evidence. Market
context alone does not establish strategy performance, and a paper decision is
not a live order.
