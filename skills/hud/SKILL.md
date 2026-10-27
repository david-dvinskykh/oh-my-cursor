---
name: hud
description: "Print an on-demand OMC status report in chat (active modes, ralph/ultragoal progress, team workers, recent subagents, context hints). Cursor has no statusline API, so there is no persistent HUD bar"
argument-hint: "[minimal|focused|full]"
---

# HUD Skill (on-demand status report)

**Cursor has no statusline/HUD API.** oh-my-cursor cannot show a persistent, auto-updating
status bar the way upstream OMC does in Claude Code. Instead, this skill makes you (the
agent) gather OMC state and print a one-off status report in chat. Run `/hud` again
whenever the user wants a fresh view.

Do not create HUD wrapper scripts or edit any settings file for a status line — there is
nothing in Cursor that would run them.

## Arguments

| Invocation | Output |
|------------|--------|
| `/hud` or `/hud focused` | Default report (all sections that have data) |
| `/hud minimal` | One summary line |
| `/hud full` | Default report plus per-agent detail, state file paths and raw counters |

Treat `setup` or `status` (upstream arguments) as `focused`, and tell the user once that
setup is not needed in Cursor.

## Step 1: Gather data (read-only)

Run independent reads in parallel. Skip a section silently when its source is absent.

1. **Active modes** — call the `omc` MCP tool `state_list_active` (current session; pass
   `all: true` for `full`). Then `state_get_status` for each active mode (or with no mode for
   `full`). If the MCP tools are unavailable, read `.omc/state/*-state.json` and
   `.omc/state/sessions/*/*-state.json` directly and note "MCP server unavailable — run `/omc-doctor`".
2. **Ralph** — from `ralph-state.json`: `iteration` / `max_iterations`, `active`, and the
   current story if a PRD exists (`prd.json` in the session state dir, `.omc/state/`,
   `.omc/` or the project root: first story without `passes: true`, plus passed/total).
3. **Ultragoal** — run `omc ultragoal status --json` (or
   `node "$OMC_PLUGIN_ROOT/bridge/cli.cjs" ultragoal status --json`); fall back to reading
   `.omc/ultragoal/goals.json` (active goal, completed/total) and the last lines of
   `.omc/ultragoal/ledger.jsonl`.
4. **Autopilot / ultrawork / ralplan / deep-interview** — phase or stage fields from their
   `*-state.json` files, if active.
5. **Team** — for each directory under `.omc/state/team/`, run `omc team status <team-name>`
   (or the `node … bridge/cli.cjs` form). Report workers (name, provider, state) and task
   counts (pending / in progress / done / failed).
6. **Subagents** — `.omc/state/sessions/<current session>/subagent-tracking-state.json` (use
   the newest session dir if the current id is unknown): running agents (`agent_type`,
   elapsed since `started_at`, description), the last few completed ones, and
   `total_spawned` / `total_completed` / `total_failed`. Mark running agents older than
   5 minutes as possibly stale. Background subagent output also lands in
   `~/.cursor/subagents/`.
7. **Last skill** — `skill-active-state.json`: active skill slots and the most recent one.
8. **Todos** — your own to-do list in this chat (completed/total).
9. **Git** — `git rev-parse --abbrev-ref HEAD` and the repo name (`basename` of
   `git rev-parse --show-toplevel`); note if inside a linked worktree.
10. **Last error** — `last-tool-error-state.json` if updated within the last hour.

## Step 2: Context hints

There is no API that reports exact context-window usage in Cursor. Do not print a
percentage. Give a qualitative hint from what you can observe — conversation length, large
files or tool outputs already read, many subagent results merged — e.g. `ctx: likely high`.
When it looks high, suggest `/summarize` (Cursor's manual compaction) or handing work to
fresh subagents.

## Step 3: Print the report

**minimal** — one line:
```
[OMC] ralph 3/10 | team fix-tests 2/3 workers | agents 2 running | todos 2/5
```
(`[OMC] idle` when no mode is active.)

**focused** (default):
```
## OMC status
branch: main (oh-my-cursor)
modes:  ralph 3/10 · story US-002 (2/5 passed) | ultragoal G-3 "auth refactor" (2/6 done)
team:   fix-tests — 3 workers: w1 cursor busy, w2 cursor idle, w3 dead · tasks 4/9 done, 1 failed
agents: 2 running — omc-executor 1m "implementing validation", omc-explore 45s "finding tests"
        last done: omc-architect (OK, 2m ago) · spawned 7 / done 5 / failed 0
skill:  ralph
todos:  2/5
ctx:    likely moderate
```

**full**: the focused report, then one line per tracked subagent (type, status, duration,
description), each active mode's state file path with its `updated_at`, and the raw counters.

Flag problems inline with `WARN:` — e.g. ralph at `max_iterations`, a mode active but not
updated for more than 2 hours, dead team workers, subagents running far longer than
expected. Point to `/cancel` for stuck modes and `/omc-doctor` for anything that looks
like a broken install.

## Configuration

Upstream's `omcHud` presets/elements config and `statusLine` settings have no effect in
Cursor. `omc hud` (the CLI statusline renderer) still exists in the runtime but is
Claude Code-oriented; you may run `omc hud --watch` in a separate terminal (for example a tmux pane)
only if the user explicitly wants a terminal view, and note that some fields may be empty
because Cursor does not feed it statusline input.

## Not available in Cursor

- Persistent, auto-refreshing status bar (no statusline/HUD API).
- Exact context-window percentage, effort level and API-key source display.
- `/hud setup`, `omc-hud.mjs` wrapper installation and `statusLine` settings.
