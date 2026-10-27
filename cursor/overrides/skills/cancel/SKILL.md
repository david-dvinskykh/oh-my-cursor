---
name: cancel
description: "Cancel any active OMC mode (autopilot, ralph, ultragoal, swarm, ultrapilot, pipeline, team) in Cursor, stop the stop-hook continuation and clean up session and retired legacy state"
argument-hint: "[--force] [--all]"
---

# Cancel Skill

Intelligent cancellation that detects and cancels the active OMC mode.

**The cancel skill is the standard way to complete and exit any OMC mode.**
When the stop hook detects completion, it instructs the agent (through Cursor's
`stop` follow-up message) to invoke this skill for state cleanup. Clearing the
mode state is what ends the "The boulder never stops" continuation. Retry a failed operation in the same scope and report
what remains; `--force` changes shutdown urgency, never scope, lock handling,
or ownership checks. `--all` is the only cross-session authorization.

## Cancellation Contract

The flags control independent scope and shutdown dimensions:

| Invocation | Scope | Shutdown behavior |
|---|---|---|
| no flags | Current session only | Graceful cancellation, including teammate shutdown waits |
| `--force` | Current session only | Forced cancellation: skip graceful waits, but still use protected state tools and honor locks/ownership |
| `--all` | Every known session, by explicit session id | Normal safe cancellation independently for each session, then explicit legacy/global cleanup |
| `--force --all` | Every known session, by explicit session id | Forced-all: skip graceful waits for each session, then perform the authorized legacy/global cleanup |

Resolve the current identity from `OMC_SESSION_ID` when the OMC CLI set it
(CLI contexts), otherwise from the hook-provided `session_id`. In Cursor the
hook adapter uses the Cursor conversation id as `session_id`; the sessionStart
hook prints it as "OMC session id" and the Ralph/autopilot continuation context
repeats it. A missing or ambiguous identity for no flags or
`--force` fails closed: do not aggregate state, choose a discovered session,
or issue an unscoped cleanup. This is a fail-closed error for the default
command and for `--force`. `--all` may enumerate known sessions, but every
concrete id is still read, cancelled, and cleared independently.

## What It Does

Automatically detects and cancels active modes:

- **Autopilot**: Stops the workflow while preserving progress for resume.
- **Ralph**: Stops the persistence loop.
- **Legacy Ultrawork / UltraQA**: Removes stale upgraded-installation state only;
  neither is a live workflow.
- **Ultragoal**: Clears its session runtime guard while preserving durable
  `.omc/ultragoal/` plan and ledger artifacts.
- **Swarm**: Stops coordinated agents and releases claimed tasks only in its
  authorized shared cleanup path.
- **Ultrapilot / Pipeline**: Stops their worker or sequential execution.
- **Team**: Lets the lead's in-editor workers (Cursor subagents) finish or
  records them as still running, then clears session-scoped Team state; forced
  paths skip waits. Cursor has no team object to delete and subagents cannot
  be messaged.
- **Team + Ralph**: Team is cancelled first, then linked Ralph is cleared in
  the same session; a Team failure retains linked Ralph.
- **OMC Teams, Plan Consensus, and Self-Improve**: Use their mode-specific
  protected cleanup and preserve artifacts designated for resume.

## Usage

```text
/cancel
/cancel --force
/cancel --all
/cancel --force --all
```

Or say: `cancelomc`, `stopomc`.

## Critical: State Tool Availability

The state tools (`state_clear`, `state_read`, `state_write`,
`state_list_active`, `state_get_status`) come from the plugin's `omc` MCP
server. Call them by tool name. If they are missing, the `omc` MCP server is
disabled or not started: enable it in Cursor's MCP settings (or run
`/omc-doctor`) before cancelling.

If `state_clear` is unavailable or fails, retry the same scoped operation and
report the failure. The fallback below is only an emergency escape from a
stop-hook loop for a non-force, non-Team cancellation. It removes files only
for an explicitly identified current session. Do NOT use this fallback for
`autopilot`, `team`, or `omc-teams`, or for `--force`/`--all`; never use it to
bypass a lock, ownership check, corruption, or another state-tool failure.
Linked modes need one protected operation per mode.

Replace `MODE` with the specific mode (for example `ralplan`, `ralph`,
`ultrawork`, or `ultragoal`).

```bash
# Emergency fallback: direct file removal for one identified session only.
# OMC_SESSION_ID may be exported by the OMC CLI; otherwise paste the
# "OMC session id" printed at session start (the Cursor conversation id).
SESSION_ID="${OMC_SESSION_ID:-<omc-session-id-from-session-start>}"
case "$SESSION_ID" in "<"*) SESSION_ID="" ;; esac
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { d="$PWD"; while [ "$d" != "/" ] && [ ! -d "$d/.omc" ]; do d="$(dirname "$d")"; done; echo "$d"; })"
sha256portable() { printf '%s' "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16; }

if [ -n "${OMC_STATE_DIR:-}" ]; then
  SOURCE="$(git remote get-url origin 2>/dev/null || echo "$REPO_ROOT")"
  HASH="$(sha256portable "$SOURCE")"
  DIR_NAME="$(basename "$REPO_ROOT" | sed 's/[^a-zA-Z0-9_-]/_/g')"
  OMC_STATE="$OMC_STATE_DIR/${DIR_NAME}-${HASH}/state"
elif [ "$REPO_ROOT" != "/" ] && [ -d "$REPO_ROOT/.omc" ]; then
  OMC_STATE="$REPO_ROOT/.omc/state"
else
  echo "ERROR: Could not locate .omc state directory" >&2; exit 1
fi
[ -d "$OMC_STATE" ] || { echo "ERROR: State dir not found at $OMC_STATE" >&2; exit 1; }
MODE="ralplan" # replace with the target mode
[ -n "$SESSION_ID" ] || { echo "ERROR: current session identity is required; refusing unscoped fallback" >&2; exit 1; }

if [ -d "$OMC_STATE/sessions/$SESSION_ID" ]; then
  rm -f "$OMC_STATE/sessions/$SESSION_ID/${MODE}-state.json" \
    "$OMC_STATE/sessions/$SESSION_ID/${MODE}-stop-breaker.json" \
    "$OMC_STATE/sessions/$SESSION_ID/skill-active-state.json"
  NOW_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  EXPIRES_ISO="$(date -u -d "+30 seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(seconds=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)"
  printf '{"active":true,"requested_at":"%s","expires_at":"%s","mode":"%s","source":"bash_fallback"}' \
    "$NOW_ISO" "$EXPIRES_ISO" "$MODE" > "$OMC_STATE/sessions/$SESSION_ID/cancel-signal-state.json"
fi
```

## Cancellation Flow

This is the authoritative procedure for every invocation.

### 1. Parse Arguments

Parse exact flags independently; unknown or near-match arguments do nothing:

```bash
FORCE_MODE=false
ALL_MODE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE_MODE=true ;;
    --all) ALL_MODE=true ;;
  esac
done
SCOPE="current"
if [[ "$ALL_MODE" == true ]]; then SCOPE="all"; fi
GRACEFUL_MODE=true
if [[ "$FORCE_MODE" == true ]]; then GRACEFUL_MODE=false; fi
```

The parsed values select exactly one row in the contract above.

### 2. Detect Active Modes

1. For no flags or `--force`, require one unambiguous current session id and
   call `state_list_active(session_id="<current_session_id>")`. Its scoped
   result is authoritative; never use an aggregate result to infer ownership.
2. For `--all`, call `state_list_active(all=true)` once and retain every
   concrete session id. Discovery enumerates targets; it is not a Team read.
3. For each selected id, call
   `state_get_status(mode="<mode>", session_id="<session_id>")` before mode
   cleanup. Treat Ultrawork as retired cleanup input.
4. Pass the selected id to every read, write, and clear. Protected state tools
   enforce the shared mutation lock and ownership boundary; no flag bypasses
   either one.

Use this dependency order when several modes appear in one scoped status:

1. Autopilot (including its linked Ralph and retired-state cleanup)
2. Standalone Ralph
3. Retired Ultrawork and UltraQA
4. Ultragoal runtime guard
5. Shared Swarm state (global pass only)
6. Ultrapilot and Pipeline
7. Team (in-editor workers)
8. Legacy OMC Teams (external tmux runtime)
9. Plan Consensus and Self-Improve

Ralph linked to Team is excluded from the standalone step and is handled only
after Team succeeds; this prevents the persistence loop from outliving workers.

### 3. Cancel Each Selected Session

Process each selected session independently in this dependency order. A failed
or unresolved scoped operation marks that session unsuccessful: retain affected
state/runtime records, report the scope and reason, and do not claim linked
cleanup. An `--all` run may continue other ids, but any such failure blocks the
final global pass.

**Autopilot (primary first)**

1. Read the exact session state, including `workflowRunId` when present.
2. Pause only that run with `state_write(mode="autopilot", session_id="<session_id>", active=false, state={workflowRunId: "<exact run id>"})`; do not replay the readback. The state tool revalidates workflow integrity under its mutation lock.
3. If the primary write fails, stop this session's dependent cleanup. Otherwise,
   clear only same-session named-workflow
   `state_clear(mode="ralplan", session_id="<session_id>")`, then linked Ralph,
   then retired UltraQA. Preserve the paused primary for resume when a
   dependent clear fails. Force mode keeps this primary-first ordering.

The primary pause preserves workflow, pipeline tracking, and task identity. A
`target_state_sha256` may be supplied only when it is the exact hash of the
current serialized state. Never clear nested `ralplan`, linked state, cancel
signals, or runtime artifacts after a failed primary write; report the exact
dependent failure and retry it in the same session.

**Team (in-editor workers)**

1. Read `state_read(mode="team", session_id="<session_id>")` and obtain the
   captured team name and active worker labels. Never select a Team from an
   aggregate read.
2. On graceful paths, workers are Cursor subagents that cannot be messaged:
   stop launching new Task calls, give each still-running background worker up
   to 15 seconds to finish, then reconcile for 5 more seconds (check
   `~/.cursor/subagents/` output). Record finished workers and timeouts.
   Forced paths skip both waits.
3. After graceful confirmation/timeouts (or immediately when forced), clear
   `state_clear(mode="team", session_id="<session_id>")`. If the protected
   clear fails for lock, ownership, corruption, or another reason, retain Team
   runtime records and linked Ralph; do not use an unscoped clear or fallback.
4. Only after Team clear succeeds, inspect linked Ralph and clear it with the
   same session id (`state_read(mode="ralph", session_id="<session_id>")` then
   `state_clear(mode="ralph", session_id="<session_id>")`). For workers of the
   optional external tmux runtime (`omc team N:...`), run the captured
   team-name orphan scan after state cleanup; in-editor Team has no team
   object to delete.

Report the team name, signaled members, responses, timeouts, whether Team and
linked Ralph state cleared, and any manual cleanup needed. A graceful timeout
is recorded separately; only an unresolved protected operation blocks the global
pass. The orphan scan is limited to the captured name and must not
terminate an uncaptured Team or delete a `~/.cursor/omc/teams` root.

The scan, only when the external tmux team runtime was used, is:

```bash
node "${OMC_PLUGIN_ROOT}/scripts/cleanup-orphans.mjs" \
  --team-name "<captured_team_name>"
```

Use `--dry-run` to inspect without terminating workers. This scan is not a
substitute for the protected Team clear and is never inferred from a
name-prefix match.

**Linked Ralph context**

If cancellation starts while Ralph is linked, apply the same Team-first
ordering. Never clear Ralph before a linked Team has been successfully handled;
if Team fails, Ralph remains protected. Both operations use the selected id.

**Other modes**

- Standalone Ralph: `state_clear(mode="ralph", session_id="<session_id>")`.
- Retired Ultrawork: `state_clear(mode="ultrawork", session_id="<session_id>")`
  only for the stale scoped record; never reactivate or route it.
- Retired UltraQA: `state_clear(mode="ultraqa", session_id="<session_id>")`
  only for stale pre-5.0.0 state.
- Ultragoal: `state_clear(mode="ultragoal", session_id="<session_id>")` clears
  only its runtime guard; preserve `.omc/ultragoal/` artifacts.
- Ultrapilot, Pipeline, Plan Consensus, and Self-Improve: use their protected
  session-scoped clear and mode-specific resume/artifact rules.
- Swarm and other shared state are not guessed from a session; process them in
  the authorized global pass only. OMC Teams (the optional external tmux CLI runtime) use their own tmux/runtime cleanup.

Self-Improve cleanup clears its resolved state and orphaned worktrees while
preserving `iteration_state` and recording `status: "user_stopped"` in the
resolved `agent-settings.json` (self-improve's own run-state file, not a
Cursor setting). New topic roots are not replaced by a flat
legacy root. OMC Teams are cleaned through their own captured tmux/runtime
records, never as in-editor Team state; clear `omc-teams` only through that
mode's protected session operation.

Finally, clear `state_clear(mode="skill-active", session_id="<session_id>")` as
the last scoped operation. A failure also makes that session unresolved.

### 4. Authorized Global Pass

The global pass is allowed only for `--all`, after every concrete session id is
attempted successfully and has completed its scoped flow, including the final
`skill-active` clear. If any session operation failed or remains unresolved,
report partial completion and omit this pass. Never replace a failed scoped
operation with a global retry.
If all-session enumeration itself fails, returns an ambiguous id, or cannot
capture a Team owner, treat the affected scope as unresolved and stop before
any unscoped operation. A legacy-only entry may be reported, but it does not
authorize guessing a current session or deleting a Team root.

Use protected state tools for the explicit pass, for example:

```text
state_clear(mode="<legacy-mode>")  # no session_id: --all authorization only
```

An unscoped `state_clear` is not a legacy-only API: it can revisit session
state as well as legacy/shared artifacts. Restrict it to the compatibility
paths explicitly authorized for this pass, including legacy mode JSON, Swarm
databases/markers, checkpoints, and shared OMC worker registries. Do not clear
any Team root whose owner was not successfully captured
and cleared; uncaptured Team roots remain protected. Report global cleanup
failures separately from scoped session failures.

The explicit compatibility set is:

- `.omc/state/{autopilot,ralph,ralph-plan,ralph-verification}-state.json`
- `.omc/state/{ultrawork,ultraqa,ultrapilot,pipeline,omc-teams}-state.json`
- `.omc/state/{ultrapilot-ownership,plan-consensus,ralplan,boulder,hud}.json`
- `.omc/state/subagent-tracking.json` and `.omc/state/subagent-tracker.lock`
- `.omc/state/{swarm.db,swarm.db-wal,swarm.db-shm,swarm-active.marker,swarm-tasks.db}`
- `.omc/state/{rate-limit-daemon.pid,rate-limit-daemon.log}`
- `.omc/state/checkpoints/` and an empty `.omc/state/sessions/` directory
- shared legacy Team bridge heartbeats and
  `.omc/state/team-mcp-workers.json`, only after captured owners succeed

These names expand to the following legacy records (and no session-owned
replacement): `autopilot-state.json`, `ralph-state.json`,
`ralph-plan-state.json`, `ralph-verification.json`, `ultrawork-state.json`,
`ultraqa-state.json`, `ultrapilot-state.json`, `ultrapilot-ownership.json`,
`pipeline-state.json`, `omc-teams-state.json`, `plan-consensus.json`,
`ralplan-state.json`, `boulder.json`, `hud-state.json`,
`subagent-tracking.json`, and `subagent-tracker.lock`.

Shared database compatibility records are `swarm.db`, `swarm.db-wal`,
`swarm.db-shm`, `swarm-active.marker`, and `swarm-tasks.db`; daemon records
are `rate-limit-daemon.pid` and `rate-limit-daemon.log`. Checkpoints are
removed only as part of this authorized global pass.

Do not interpret this list as permission to remove arbitrary files under
`.omc/state`, `~/.cursor/omc/teams`, or `~/.cursor/omc/tasks`. Unlisted or uncaptured
Team/runtime records remain for inspection and future ownership resolution.

The global pass must retain the same lock and ownership checks as scoped
operations. It may continue recording an error for one compatibility item
after the per-session gate opens, but must report that global failure and never
claim a complete reset. It must not delete durable Autopilot, Ultragoal,
Self-Improve, or Team handoff artifacts merely because they share a directory.

If no active mode is found in the selected scope, report: “No active OMC modes
detected.” For a current-session command, do not silently broaden that result;
use `--all` to enumerate other sessions and perform the global pass.

## Preserved State

| Mode | Cancellation result |
|---|---|
| Autopilot | `active=false` with progress, phase, plan, and verdicts preserved |
| Ralph, Ultrawork, UltraQA, Swarm, Ultrapilot, Pipeline | State cleared when the protected scoped/global operation succeeds |
| Ultragoal | Runtime guard cleared; durable plan/ledger preserved |
| Team | Handoffs and uncaptured runtime roots preserved; selected state cleared only after its flow |
| Plan Consensus / Self-Improve | Mode-specific resume/artifact records preserved as documented by the mode |

Autopilot can resume with `/autopilot`; Ultragoal's durable
plan and ledger can resume through `/ultragoal`. Ralph and retired state do not
provide a resume path. Team handoffs remain available for a later scoped
resume, while shared Swarm and legacy records require explicit authorization.

Cancellation reports should identify the selected scope, modes observed,
successful and failed operations, skipped waits, and any retained records.
Do not turn a timeout, missing identity, lock conflict, ownership mismatch, or
malformed state into a success message. A successful current-session report
does not imply that another session or a shared legacy artifact was touched.

## MCP Worker Cleanup (external tmux team runtime only)

This applies only when the optional `omc team` tmux CLI runtime was used; in-editor
subagent workers have no tmux sessions or heartbeats. For selected-session cancellation, inspect only the captured team's
`.omc/state/team-bridge/{team}/*.heartbeat.json` records and capture exact worker
handles before state cleanup. Send shutdown signals and terminate only those
exact tmux session identifiers, not sessions selected by name prefix. If ownership
or identity cannot be established, retain the records and report manual cleanup.
Remove their heartbeat/registry entries only after protected cleanup succeeds.

After every concrete session succeeds, the authorized `--all` global runtime
cleanup may remove shared legacy bridge state for captured Team names. Populate
`CAPTURED_TEAM_NAMES` only from successful scoped Team reads; retain every
uncaptured registry/root. Use the exact captured worker identities for shutdown;
a team-name prefix is not ownership evidence. Remove only matching bridge
records and registry entries after their cleanup succeeds.
