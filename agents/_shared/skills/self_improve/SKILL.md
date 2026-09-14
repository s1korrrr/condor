---
name: self_improve
description: Save explicitly requested durable preferences or reusable workflow skills
  in the appropriate Condor library.
when_to_use: When the user explicitly asks to remember a preference or fact, or to
  create or update a reusable skill. Ordinary feedback steers the current task.
created: '2026-08-05T09:16:13Z'
source: chat
---

## Save requested memories and skills

Use this checklist for an explicit persistence request. Apply feedback immediately
to the current task without automatically writing memory or skills. A request to
update a skill does not authorize memory writes, or vice versa. For Codex-managed
memory, use its prescribed memory mechanism rather than Condor memory tools.

### Checklist

**1. Is this a user preference or stable fact?**
- e.g. "always show controllers before asking for params", "use 3 months as default backtest window"
- → `manage_memory(action="write", ...)` — one memory per fact, type=preference
- **Memory is YOURS ALONE** — keyed by (assistant, user), so what you write here
  is invisible to the chat and to every other agent, and there is no way to
  publish it. Write it only under the explicit memory request. If the preference should
  govern how *everything* behaves, say so to the user — a cross-cutting rule
  belongs in a shared skill (below), not in one agent's memory.

**2. Is this a workflow pattern or missed step?**
- e.g. "when asked to backtest, list available controllers first"
- → First: `manage_skill(action="list")` — check if an existing skill covers it
  - If yes: `manage_skill(action="read", name=...)` to confirm it is the same
    pattern, then `manage_skill(action="edit", ...)` — update the existing one
    - **If the read returns `inherited: true`**, the playbook lives in the
      shared library and is read-only for you. `edit` will fail. To specialize
      it, `create` a skill with the SAME name — it shadows the shared one for
      you only. If the improvement is good for everyone, ask the user to have
      the chat edit the published version instead of shadowing it.
  - If no: `manage_skill(action="create", ...)` — create a new one
- **Whose library?** A skill is written to the CALLER's library. Before creating,
  decide who the pattern belongs to:
  - It is about how *you* work → create it normally (no `agent` argument).
  - You are the chat and the pattern belongs to a domain agent → pass
    `agent="<agent_slug>"` so it lands in that agent's library. Skipping this is
    the #1 cause of skills ending up on the wrong agent.
  - It should apply to ALL agents → only the chat can publish: create it with
    `shared=True`, which puts it in the shared library every assistant reads.

**3. Is this a one-off or session-specific detail?**
- → Skip it. Don't pollute memory/skills with ephemeral context.

### Rules
- Save only the durable information or skill change explicitly requested
- One memory = one fact (no bundling)
- Always check existing skills before creating a new one
- Decide the OWNER before writing: memory is per-agent and cannot be shared;
  skills are per-agent but the chat can publish one to all with `shared=True`
- Shared skills land in every agent's context — publish deliberately
