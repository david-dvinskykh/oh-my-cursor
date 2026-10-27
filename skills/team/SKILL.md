---
name: team
description: "N coordinated omc-* subagents on a staged plan/exec/verify/fix pipeline, run in parallel with Cursor subagents, Multitask and git worktrees"
argument-hint: "[N:agent-type] [ralph] <task description>"
---

# Team Skill

Run a staged team pipeline in Cursor: the current chat is the **lead**, and the workers are `omc-*` subagents launched in parallel with the Task tool (several Task calls in one message) or as async subagents through `/multitask`. Workers that could touch the same files get their own git worktree. OMC state, handoffs and the shared task file keep the run resumable.

Cursor facts this skill depends on:
- Subagents run in parallel when the lead sends several Task calls in one message. Foreground calls return each worker's final report to the lead; background workers return immediately and write their output to `~/.cursor/subagents/`.
- Subagents cannot message each other or the lead mid-run. Coordination happens through the worker prompt, the shared task file, per-worker status files and the final report.
- A subagent may start subagents one level deep only. Workers must therefore do the work themselves; only the lead orchestrates.
- Multitask has no built-in conflict prevention: the lead must give workers disjoint files or separate worktrees.
- All `omc-*` agents use `model: inherit`.

## Usage

```
/team N:agent-type "task description"
/team "task description"
/team ralph "task description"
```

### Parameters

- **N** — number of workers for `team-exec` (1–20). Optional; defaults to the number of independent subtasks the plan produces (cap at 8 in-editor unless the user asks for more).
- **agent-type** — `omc-*` role for `team-exec` workers (`executor`, `debugger`, `designer`, `test-engineer`, `writer`, …). Optional; defaults to stage-aware routing. `codex`, `gemini`, `antigravity`, `grok`, `claude` and `cursor` select external CLI workers (see *External CLI workers*).
- **task** — high-level task to decompose.
- **ralph** — optional modifier: wrap the pipeline in Ralph's persistence loop (see *Team + Ralph*).

### Examples

```
/team 5:executor "fix all TypeScript errors across the project"
/team 3:debugger "fix build errors in src/"
/team 4:designer "implement responsive layouts for all page components"
/team "refactor the auth module with security review"
/team ralph "build a complete REST API for user management"
/team 2:codex "review architecture and suggest improvements"   # external Codex CLI workers
```

## Architecture

```
User: "/team 3:executor fix all TypeScript errors"
              |
              v
      [LEAD = current Cursor chat]
              |
              +-- Resume check: state_read(mode="team", session_id=<id>)
              |
              +-- team-plan: omc-explore + omc-planner -> subtasks with file ownership
              |
              +-- Write .omc/state/team/<team>/tasks.json (owners pre-assigned)
              |       + mirror the subtasks in the lead's to-do list
              |
              +-- team-exec: Task(subagent_type="omc-executor", prompt=<preamble + task #1>)
              |              Task(subagent_type="omc-executor", prompt=<preamble + task #2>)   (same message
              |              Task(subagent_type="omc-executor", prompt=<preamble + task #3>)    = parallel)
              |       <- each worker's final report
              |
              +-- team-verify: omc-verifier (+ reviewers) -> pass | fix tasks
              +-- team-fix:    omc-executor / omc-debugger -> back to verify (bounded)
              |
              +-- Completion: merge worktrees, write closeout, /cancel cleanup, report
```

## Staged Pipeline (Canonical Team Runtime)

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Agent Routing

| Stage | Required agents | Optional agents | Selection criteria |
|---|---|---|---|
| **team-plan** | `omc-explore`, `omc-planner` | `omc-analyst`, `omc-architect` | `omc-analyst` for unclear requirements, `omc-architect` for complex boundaries. |
| **team-prd** | `omc-analyst` | `omc-critic` | `omc-critic` to challenge scope. |
| **team-exec** | `omc-executor` | `omc-debugger`, `omc-designer`, `omc-writer`, `omc-test-engineer` | Match the agent to the subtask: UI → `omc-designer`, build/compile issues → `omc-debugger`, docs → `omc-writer`, tests → `omc-test-engineer`. |
| **team-verify** | `omc-verifier` | `omc-test-engineer`, `omc-security-reviewer`, `omc-code-reviewer` | Always run `omc-verifier`. Add `omc-security-reviewer` for auth/crypto changes, `omc-code-reviewer` for >20 files or architectural changes. |
| **team-fix** | `omc-executor` | `omc-debugger` | `omc-debugger` for type/build errors and regression isolation. |

Routing rules:
1. The lead picks agents per stage. `N:agent-type` only overrides the `team-exec` worker type.
2. Reviews are separate passes by separate subagents; the lead never approves its own workers' output.
3. Risk escalates review: security-sensitive or >20-file changes must include `omc-security-reviewer` and `omc-code-reviewer` in `team-verify`.

### Stage Entry/Exit Criteria

- **team-plan** — Entry: invocation parsed. `omc-explore` maps the code, `omc-planner` produces a task graph with file ownership per subtask. Exit: runnable task graph.
- **team-prd** — Entry: scope ambiguous or acceptance criteria missing. `omc-analyst` (optionally `omc-critic`). Exit: explicit acceptance criteria and boundaries.
- **team-exec** — Entry: tasks written and owners assigned. Workers run in parallel. Exit: every task of this pass is `completed` or `failed`.
- **team-verify** — Entry: execution pass finished. `omc-verifier` plus reviewers. Exit pass: gates pass with no required follow-up. Exit fail: fix tasks generated → `team-fix`.
- **team-fix** — Entry: defects, regressions or unmet criteria. `omc-executor`/`omc-debugger`. Exit: fixes done → `team-exec`/`team-verify` again.

### Verify/Fix Loop and Stop Conditions

Continue `team-exec -> team-verify -> team-fix` until verification passes with no required fix tasks, or an explicit terminal blocked/failed outcome is reached with evidence. `team-fix` is bounded by `max_fix_loops` (default 3); beyond it the run ends `failed`.

**Run closeout (either terminal outcome).** Before `/cancel` state cleanup, append at most three factual lines to `.omc/notepads/team/problems.md` (blockers also to `.omc/notepads/team/issues.md`) — what broke and what dragged. Append only; never replace the files; write nothing if there is nothing to say. For a terminal `failed` outcome, also append an incident item (failure signature, evidence pointers, reopen path) to `.omc/notepads/team/issues.md`. Post it to a tracker only if the user explicitly authorises that.

### Stage Handoff Convention

Each completing stage writes `.omc/handoffs/<stage-name>.md` before the next stage starts, and the lead includes the previous handoffs in the next stage's worker prompts.

```markdown
## Handoff: <current-stage> → <next-stage>

- **Decided**: [key decisions]
- **Rejected**: [alternatives and why]
- **Risks**: [risks for the next stage]
- **Files**: [key files created or modified]
- **Remaining**: [items left for the next stage]
```

Handoffs accumulate, survive cancellation, and stay short (10–20 lines).

### Resume and Cancel Semantics

- **Resume:** restart from the last non-terminal stage using team state, `tasks.json`, worker status files and `.omc/handoffs/`.
- **Cancel:** follow `skills/cancel/SKILL.md` (`/cancel`); handoffs are preserved.
- Terminal states: `complete`, `failed`, `cancelled`.

## Workflow

### Resume Check (before initialisation)

The session id is printed at session start ("OMC session id …"); in CLI contexts `OMC_SESSION_ID` wins. Always pass it explicitly:

```
state_read(mode="team", session_id="<current_session_id>")
```

Never resume from an unscoped aggregate response. If state is `active=true` with a non-terminal `current_phase`, resume that stage: keep `team_name`, `current_phase`, `fix_loop_count`, `max_fix_loops`, `stage_history` and the task/worker records; do not re-plan, re-create tasks or relaunch workers whose tasks are already `completed`. If state is malformed, report it and keep the original bytes.

### Phase 1: Parse input

Extract N (1–20), agent-type (must map to an `omc-*` agent or a supported external CLI), and the task.

### Phase 2: Analyse and decompose

Launch `omc-explore` (and `omc-architect` when boundaries are complex) to break the task into subtasks:
- Each subtask is file- or module-scoped and lists the files it owns.
- Dependencies are explicit ("shared types before consumers").
- Two subtasks that must edit the same file are either merged, ordered by dependency, or given separate worktrees.

### Phase 3: Initialise team state

Derive a slug (`fix-ts-errors`) and write state:

```
state_write(mode="team", session_id="<current_session_id>", active=true, current_phase="team-plan", state={
  "team_name": "fix-ts-errors",
  "agent_count": 3,
  "agent_types": "executor",
  "task": "fix all TypeScript errors",
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "linked_ralph": false,
  "stage_history": "team-plan",
  "isolation": "files"
})
```

`state_write` transports values as strings: coerce `agent_count`, `fix_loop_count`, `max_fix_loops` to numbers and `linked_ralph` to boolean when reading.

| Field | Type | Description |
|---|---|---|
| `active` | boolean | team mode active |
| `current_phase` | string | `team-plan`, `team-prd`, `team-exec`, `team-verify`, `team-fix` |
| `team_name` | string | slug for state, handoffs, worktrees and reporting |
| `agent_count` | number | workers in `team-exec` |
| `agent_types` | string | comma-separated worker agent types |
| `task` | string | original task |
| `fix_loop_count` | number | current fix iteration |
| `max_fix_loops` | number | fix iterations before `failed` (default 3) |
| `linked_ralph` | boolean | wrapped in a Ralph loop |
| `stage_history` | string | comma-separated `stage:timestamp` transitions |
| `isolation` | string | `files` (disjoint ownership) or `worktrees` |

Update state on every stage transition:

```
state_write(mode="team", session_id="<current_session_id>", current_phase="team-exec", state={
  "stage_history": "team-plan:2026-02-07T12:00:00Z,team-exec:2026-02-07T12:02:00Z"
})
```

### Phase 4: Create the shared task file

The lead owns `.omc/state/team/<team>/tasks.json`. Pre-assign every owner here — there is no atomic claiming, so workers only take tasks assigned to them.

```json
{
  "team": "fix-ts-errors",
  "tasks": [
    { "id": "1", "subject": "Fix type errors in src/auth/", "description": "Fix all TypeScript errors in src/auth/login.ts, session.ts, types.ts. Verify with tsc --noEmit.", "owner": "worker-1", "files": ["src/auth/"], "status": "pending", "blockedBy": [] },
    { "id": "2", "subject": "Fix type errors in src/api/", "owner": "worker-2", "files": ["src/api/"], "status": "pending", "blockedBy": [] },
    { "id": "3", "subject": "Fix consumers of shared types", "owner": "worker-3", "files": ["src/utils/"], "status": "pending", "blockedBy": ["1"] }
  ]
}
```

Mirror the subtasks in the lead's to-do list so the user sees progress (`#1 [in_progress] Fix type errors in src/auth/ (worker-1)`).

### Phase 4.5: Isolation (worktrees when ownership overlaps)

If subtasks cannot be given disjoint files, set `isolation: "worktrees"` and create one worktree per worker before launch:

```bash
git worktree add ".omc/worktrees/<team>/<worker>" -b "omc-team/<team>/<worker>"
```

Pass the absolute worktree path as the worker's working directory in its prompt. (Inside the Agents Window, `/worktree` creates worktree-isolated agents as well.) Worktrees are removed only at team shutdown, so failed runs can be inspected.

### Phase 5: Launch workers

Launch all unblocked workers of the pass **in one message** with one Task call per worker so they run in parallel:

```
Task(subagent_type="omc-executor", prompt="<worker preamble for worker-1 + task #1 + handoffs>")
Task(subagent_type="omc-executor", prompt="<worker preamble for worker-2 + task #2 + handoffs>")
```

- Large or long runs: launch them as background/async subagents (or ask the user to run the same request with `/multitask` in the Agents Window) and collect results from the reports and status files.
- Tasks blocked by another task run in the next wave, after their blockers are `completed`.
- Before launching, set each task's `status` to `in_progress` in `tasks.json` and `current_phase="team-exec"` in state.

### Phase 6: Collect results and monitor

For each worker the lead reads:
1. the Task result (final report), and
2. `.omc/state/team/<team>/workers/<worker>/status.json` — `{ "task": "1", "status": "completed|failed|blocked", "summary": "...", "files": [...], "evidence": "..." }`.

Then it updates `tasks.json` and the to-do list. Watchdog policy:
- A background worker with no status update after a long quiet period is treated as stalled: check its output in `~/.cursor/subagents/`, then relaunch its task once with the same owner label.
- A worker that fails two tasks gets no further tasks; reassign to a fresh worker.
- A failed blocker: retry it, drop the dependency, or skip the blocked task — record the decision in the next handoff.

### Phase 6.5: Stage transitions

```
state_write(mode="team", session_id="<current_session_id>", current_phase="team-verify")
state_write(mode="team", session_id="<current_session_id>", current_phase="team-fix", state={ "fix_loop_count": 1 })
```

Verify: launch `omc-verifier` (plus the reviewers from the routing table) in one message, each with the acceptance criteria, the changed files and all handoffs. Their verdicts decide pass or fix tasks. Fix tasks go back into `tasks.json` with owners and run as a new `team-exec` wave.

### Phase 7: Completion

1. Confirm every real task is `completed` (or the run is explicitly `failed`).
2. With worktrees: for each worker branch, merge it into the base branch:
   ```bash
   git merge --no-ff --no-edit "omc-team/<team>/<worker>" || { git merge --abort; echo "conflict: <worker>"; }
   ```
   Conflicting branches get an `omc-executor` pass that merges and resolves them; re-run `team-verify` afterwards. Then remove the worktrees (`git worktree remove ".omc/worktrees/<team>/<worker>"`) and delete merged branches (`git branch -d "omc-team/<team>/<worker>"`).
3. Write the run closeout (above).
4. Run `/cancel` for team (and linked Ralph) state cleanup.
5. Report the summary to the user.

## Worker Preamble

Prepend this to every worker prompt and append the worker's tasks:

```
You are a TEAM WORKER in OMC team "{team_name}". Your label is "{worker_name}".
The team lead is the parent chat. You are not the lead and must not orchestrate.

== WORK PROTOCOL ==
1. Your tasks are listed below and in {abs_path}/.omc/state/team/{team_name}/tasks.json
   (owner = "{worker_name}"). Work only on those tasks and only on the files they own.
2. Work directly with your own tools (read, edit, shell). Do NOT launch subagents,
   do NOT run /team, /autopilot, /ralph, /multitask or `omc team`, do NOT create worktrees.
3. Working directory: {abs_workdir}. Use absolute paths.
4. After each task, write {abs_path}/.omc/state/team/{team_name}/workers/{worker_name}/status.json:
   {"task": "<id>", "status": "completed|failed|blocked", "summary": "...", "files": [...], "evidence": "<command + result>"}
5. Verify before reporting completed (build/tests/diagnostics for the files you touched).
   A task you could not finish is "failed" or "blocked" with the reason — never "completed".
6. Worktree mode only (your working directory is under .omc/worktrees/): commit all your
   changes on your branch before reporting:
   git -C {abs_workdir} add -A && git -C {abs_workdir} commit -m "team {team_name}: <task ids> by {worker_name}"
7. Finish with a final report: per task id, status, files changed, verification evidence,
   open risks (and the commit hash in worktree mode). This report is how the lead hears from you.

== RULES ==
- Do not edit files owned by another task. If you must, stop and report "blocked".
- Do not edit .omc/state/team/{team_name}/tasks.json; only the lead updates it.
- No secrets in files or reports.
```

Worker-type addendum: `omc-designer` gets the design system/brief; `omc-test-engineer` gets the test command and coverage target; `omc-debugger` gets the failing command output.

## Team + Ralph

`/team ralph "task"` (or both keywords) wraps the pipeline in Ralph's persistence loop:

```
state_write(mode="team", session_id="<current_session_id>", active=true, current_phase="team-plan", state={ "team_name": "build-rest-api", "linked_ralph": true, "task": "build a complete REST API" })
state_write(mode="ralph", session_id="<current_session_id>", active=true, iteration=1, max_iterations=10, current_phase="execution", state={ "linked_team": true, "team_name": "build-rest-api" })
```

1. Ralph iteration starts; the team pipeline runs `team-plan → team-prd → team-exec → team-verify`.
2. On verify pass, Ralph's reviewer (`omc-architect` by default) approves or rejects.
3. Approve → both modes complete, run `/cancel`.
4. Verify fail or reviewer rejection → `team-fix`, back to `team-exec → team-verify`.
5. Fix loop exceeds `max_fix_loops` → Ralph increments its iteration and retries the pipeline.
6. Ralph exceeds `max_iterations` → terminal `failed`.

OMC's stop hook keeps the lead's turn going between stages ("The boulder never stops") until the modes complete or are cancelled.

## External CLI workers (optional)

The OMC CLI can also run workers as separate CLI processes in tmux panes — useful for other providers or for runs that outlive the chat:

```bash
omc team 2:cursor "apply the implementation plan"      # cursor-agent workers (executor-style only)
omc team 2:codex "review the auth module"              # Codex CLI
omc team 2:gemini "redesign UI components"             # Gemini CLI
omc team status <team-name>
omc team shutdown <team-name>
```

Requirements: tmux (or psmux on native Windows — check `tmux -V` before suggesting WSL) and the selected CLI installed and authenticated. These workers use OMC's CLI runtime (`.omc/state/team/{teamName}/events.jsonl`, worker status files) rather than Cursor subagents; the lead still owns verification and the final decision. Per-role routing for CLI teams is configured in `.claude/omc.jsonc` (project) or `~/.config/claude-omc/config.jsonc` (user) under `team.roleRouting`, or with `OMC_TEAM_ROLE_OVERRIDES`; `omc doctor --team-routing` probes provider availability.

## Configuration

Optional OMC settings in `.claude/omc.jsonc` (project) or `~/.config/claude-omc/config.jsonc` (user):

```jsonc
{
  "team": {
    "ops": {
      "maxAgents": 20,
      "defaultAgentType": "cursor",
      "monitorIntervalMs": 30000,
      "shutdownTimeoutMs": 15000
    }
  }
}
```

`defaultAgentType` applies to external CLI teams. In-editor teams always use `omc-*` subagents.

## Gotchas

1. **No atomic claiming** — pre-assign owners in `tasks.json`; workers only work on their own tasks.
2. **No mid-run messaging** — put everything a worker needs in its prompt (task, files, acceptance criteria, handoffs, workdir).
3. **One nesting level** — workers must not launch subagents.
4. **Parallel edits** — Cursor does not prevent conflicting edits between parallel agents; use disjoint files or worktrees.
5. **Secrets** — never put credentials in worker prompts; prompts end up in transcripts and state.
6. **Team name** — lowercase letters, numbers and hyphens, derived from the task.

## Parallel session caveats

- **Multi-repo workspace anchor:** a `.omc-workspace` marker in a parent directory makes several sub-repo sessions share one `.omc/`. Resolution order: `OMC_STATE_DIR > .omc-workspace > git > cwd`.
- **Session id source:** `OMC_SESSION_ID` wins in CLI contexts; the Cursor conversation id (printed at session start) is the session id in hook and chat contexts.
- Team state is session-scoped; `.omc/handoffs/` is shared by design.
