---
name: ultragoal
description: "Durable multi-goal workflow for Cursor: ordered stories in a plan/ledger under .omc/ultragoal (via `omc ultragoal`), kept on track by OMC's stop-hook persistence and a gated final review"
argument-hint: "<brief or subcommand>"
---

<Purpose>
Ultragoal breaks a brief into an ordered set of goals ("stories"), records start/checkpoint/blocker/failure events in a durable append-only ledger, and gates final completion behind ai-slop-cleaner + verification + code review. In Cursor the loop is driven by two things only:

1. **The durable ledger** under `.omc/ultragoal/`, written exclusively through the `omc ultragoal ...` CLI. It survives new chats, worktrees and `/summarize`.
2. **OMC's stop-hook persistence.** While ultragoal mode is active, ending a turn makes OMC's `stop` hook send a follow-up message (`[ULTRAGOAL #n/50] ... The boulder never stops`), so the agent continues instead of stopping until every story is resolved and the final gate passes, or the user runs `/cancel`.

Cursor has no `/goal` command. Upstream OMC pairs ultragoal with Claude Code's `/goal`; that pairing does not exist here, and nothing in this skill asks the user to type `/goal`.
</Purpose>

<Use_When>
- The user wants a durable, repo-native way to track a large initiative across several Cursor chats or worktrees
- The work is large enough to warrant multiple ordered stories with attempt counts and per-story evidence
- The user wants the final completion gated behind ai-slop-cleaner + verification + code review
</Use_When>

<Do_Not_Use_When>
- The task is a single small change — use direct delegation or `ralph` instead
- The user wants a planning-only artifact with no execution loop — use `plan` instead
</Do_Not_Use_When>

<Why_This_Exists>
A single chat loses its working state on restart and does not enforce a final review gate by itself. `omc ultragoal` adds a durable plan, ledger and gate so a long multi-step initiative survives chat restarts, fresh worktrees and review iterations, while the OMC stop hook keeps the active agent working on the current story.
</Why_This_Exists>

<How_To_Use>

**CLI prefix.** Use `omc` when the shim from `/omc-setup` is on PATH; otherwise
`node "$OMC_PLUGIN_ROOT/bin/oh-my-claudecode.js"` (substitute the plugin root printed at
session start). Generated handoffs may print `oh-my-claudecode.js` — that is the same
entry point. Run each `omc ultragoal ...` call as a **single shell command** (no `&&`,
`;` or pipes): OMC's tool guard only recognises a lone ultragoal CLI call as bootstrap.

1. Create a plan from a brief:
   ```
   omc ultragoal create-goals --brief-file plan.md
   ```
   Or with explicit stories:
   ```
   omc ultragoal create-goals --brief "ship the migration" \
     --goal "Schema::Add new columns" \
     --goal "Backfill::Backfill rows in batches" \
     --goal "Cutover::Drop old columns and switch reads"
   ```
   The default `--claude-goal-mode aggregate` gives the whole run one objective
   (`Complete all ultragoal stories in .omc/ultragoal/goals.json: G001 ...; G002 ...`).
   `--claude-goal-mode per-story` makes each story's own objective the one the
   snapshots below must quote. The flag name is a runtime identifier kept from upstream;
   in Cursor it only selects which objective text the ledger reconciles against.

   **Parallel chats in one workspace:** when several Cursor chats run ultragoal in the
   same workspace, pass `--plan-id <stable-id>` or `--auto-plan-id` so the plan is written
   to `.omc/ultragoal/plans/{planId}/` instead of the shared single-plan path; otherwise
   they clobber each other. `--auto-plan-id` derives `{epochMs}-{slug}` from the brief.
   Thread the same `--plan-id <id>` through every later subcommand in that chat.
   `omc ultragoal list-plans` enumerates planIds.

2. Start (or resume) the next story:
   ```
   omc ultragoal complete-goals [<goal-id>]
   ```
   With no goal id, this resumes the active story or starts the first pending story. With a goal id, OMC targets exactly that eligible story (a pending story may be started out of order) and never falls through to another. An active different story, unknown id, completed or review-blocked story, or failed story without `--retry-failed` is rejected without state mutation. An in-progress named story is resumed without changing its attempt.

   It prints a handoff (plan path, ledger path, story, objective, checkpoint commands). The handoff text was written for Claude Code and tells the agent to set or clear `/goal`; **in Cursor ignore every `/goal` set/clear instruction** and keep the rest:
   - Record the objective printed under "Aggregate /goal condition" (aggregate mode) or "Objective" (per-story mode) — the snapshots below must quote it verbatim.
   - Put the stories on Cursor's to-do list if useful, and delegate the work to `omc-*` subagents as usual.
   - Work the story until its evidence is real (tests, files, diffs).

3. Checkpoint a story:
   ```
   omc ultragoal checkpoint --goal-id G001-... --status complete \
     --evidence "tests/files/PR evidence" \
     --claude-goal-json '{"goal":{"objective":"<objective from the handoff>","status":"active"}}'
   ```
   For the final story, the snapshot status is `complete` and you also pass
   `--quality-gate-json` (see step 4).

   **About `--claude-goal-json` in Cursor.** This is a documented runtime flag, not a
   Cursor feature. Upstream it carries a snapshot of Claude Code's `/goal`; Cursor has no
   such state, so the snapshot is simply the agent's own statement of the objective it is
   pursuing and its status. The CLI only checks it for textual consistency with the
   plan's expected objective; it cannot observe anything. It is optional for `status`
   and non-final failed checkpoints, but the runtime still requires it for
   `checkpoint --status complete`, `checkpoint --status blocked` and
   `record-review-blockers`, so pass it there:
   - non-final story, aggregate mode: `{"goal":{"objective":"<aggregate objective>","status":"active"}}`
   - final story (or any per-story-mode completion): `{"goal":{"objective":"<expected objective>","status":"complete"}}`
   - `record-review-blockers`: status `active`

   If blocked or failed, checkpoint with `--status failed --evidence "<failure>"`, then
   `omc ultragoal complete-goals --retry-failed` to resume. (`--status blocked` exists
   only for the upstream case of a different, completed Claude `/goal` blocking a new one;
   it does not arise in Cursor.)

4. Final quality gate (last unresolved story). Run, in order:
   - `/ai-slop-cleaner` on the changed files (even if it is a no-op),
   - `/verify` (rerun the real verification commands),
   - `/omc-review` (code review by `omc-code-reviewer`, with architect status from `omc-architect`).

   If all are clean, checkpoint with `--status complete`, a `complete` snapshot, and:
   ```
   --quality-gate-json '{"aiSlopCleaner":{"status":"passed","evidence":"..."},
     "verification":{"status":"passed","commands":["npm test"],"evidence":"..."},
     "codeReview":{"recommendation":"APPROVE","architectStatus":"CLEAR","evidence":"..."}}'
   ```
   (a path to a JSON file also works). Anything other than `APPROVE` + `CLEAR` is not clean.

5. If the final review is not clean, do NOT mark complete. Record blockers:
   ```
   omc ultragoal record-review-blockers --goal-id G00X-... \
     --title "Resolve final code-review blockers" \
     --objective "Fix the listed review findings and rerun final gates" \
     --evidence "<the review findings>" \
     --claude-goal-json '{"goal":{"objective":"<expected objective>","status":"active"}}'
   ```
   This appends a new blocker story; continue with `complete-goals`.

6. Inspect state at any time:
   ```
   omc ultragoal status
   ```

7. When every story is resolved and the final gate passed, run `/cancel` to end ultragoal mode cleanly (it clears only the runtime guard; `.omc/ultragoal/` is preserved).

</How_To_Use>

<Persistence>
- Ultragoal mode is activated by the word `ultragoal` in the user's request (OMC's prompt hook writes `ultragoal-state.json`). While it is active and not all stories are resolved, OMC's `stop` hook answers every attempt to end the turn with a follow-up like `[ULTRAGOAL #n/50] Ultragoal mode is active. Continue the durable goal workflow ...`. Treat it as "The boulder never stops": continue with the current story or the next `complete-goals` call. The hook text still says "keep the matching Claude /goal active" — ignore that clause in Cursor.
- The hook stops reinforcing once all stories in `goals.json` are `complete` or `review_blocked`, the aggregate completion is recorded, the reinforcement limit (50) is reached, or `/cancel` runs.
- Do not end the turn while a story is in progress just to report status; reporting moments are a completed final gate, a hard blocker that needs the user, or cancellation.
</Persistence>

<Important_Limitations>
- No `/goal` in Cursor. Handoff text and hook messages from the OMC runtime still mention Claude `/goal`; those parts have no Cursor equivalent and are ignored. The ledger plus the stop-hook follow-up replace it.
- `--claude-goal-json` snapshots are self-reported by the agent; OMC validates text only. Never fabricate a `complete` snapshot before the work and the final gate are actually done.
- **Runtime `/goal` tool guard.** The unchanged OMC runtime has a preToolUse guard that denies tools with `[ULTRAGOAL /GOAL REQUIRED]` unless it sees a Claude `/goal`, which Cursor cannot provide. oh-my-cursor's hook adapter therefore sets `ALLOW_ULTRAGOAL_WITHOUT_GOAL=1` for the OMC scripts by default. If you still see that denial, the user has set `ALLOW_ULTRAGOAL_WITHOUT_GOAL=0` (or another value) in the environment Cursor was started from: tell them to unset it and reload the window, or run `/cancel`.
</Important_Limitations>

## Parallel session caveats

- **Multi-repo workspace anchor:** drop a `.omc-workspace` marker at the parent directory so several sub-repos share one `.omc/`. Resolution order: `OMC_STATE_DIR > .omc-workspace > git > cwd`.
- **Session id source:** `OMC_SESSION_ID` env var wins in CLI contexts; the hook payload `session_id` (one per Cursor chat) wins in hook contexts.
- **Plan id:** two runs in the same workspace conflict on shared plan artifacts. Use separate chats (session-scoped state is already isolated per chat) and pass `--plan-id` to keep their ledgers apart.
- **Parallel verdict:** supported (each chat writes its own session-scoped state).
