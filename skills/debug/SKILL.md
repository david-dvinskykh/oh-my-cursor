---
name: debug
description: "Diagnose the current OMC-in-Cursor chat or repo state (hooks, modes, subagents) using logs, traces, state, and focused reproduction"
---

# Debug

Use this skill when the user wants help diagnosing a current OMC-in-Cursor session problem, workflow breakage, or confusing runtime behavior.

## Goal
Find the real failure signal quickly and explain the next corrective step.

## Workflow
1. Read the user’s issue description carefully.
2. Inspect the most relevant local evidence first:
   - trace tools (`trace_timeline`, `trace_summary`)
   - state tools (`state_list_active`, `state_get_status`, `state_read`) and `.omc/state/`, `.omc/logs/`
   - notepad / project memory when relevant
   - failing tests or commands
   - for hook problems: rerun with `OMC_CURSOR_DEBUG=1` (hook errors to stderr), and remember the kill switches `DISABLE_OMC=1` / `OMC_SKIP_HOOKS=<names>`; `/omc-doctor` checks the install
   - duplicate hook output usually means the Claude Code OMC plugin is also loaded through Cursor's third-party config import
3. Reproduce the issue narrowly if possible.
4. Distinguish symptoms from root cause.
5. Recommend the smallest next fix or verification step.

## Rules
- Prefer real evidence over guesses.
- Use the trace/state surfaces when the issue involves orchestration, hooks, or agent flow.
- If the issue is actually a product/runtime bug rather than app code, say so plainly.
- Do not prescribe broad rewrites before isolating the failure.
- Tag temporary debug output `[DEBUG-<4hex>]`; cleanup is then a single grep.
- Redact secrets from logs and traces before they leave the session.
- If the failure traces to a missing or wrong seam, say so as the finding and point at `refit` or `architecture-survey` — the environment lesson outlives the fix.

## Output
- Observed failure
- Root-cause hypothesis
- Evidence for that hypothesis
- Smallest next action

