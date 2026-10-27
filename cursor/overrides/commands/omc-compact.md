---
name: omc-compact
description: "Prepare OMC state for a manual Cursor summarization (/summarize) without losing active-mode context"
---

# OMC manual compaction helper

Cursor compacts long chats itself; OMC's `preCompact` hook then saves notepad, project memory and wiki context automatically. Use this command when the user wants to compact **now**.

This command cannot trigger Cursor's summarization itself. It prepares OMC state, then hands off to Cursor's built-in `/summarize` command.

## Steps

1. Treat the text the user typed after `/omc-compact` as an optional note for the summary.
2. Make sure OMC state is current before the summary drops detail:
   - if a mode is active (`state_list_active`), write its latest phase/progress with `state_write` (same `session_id` as printed at session start);
   - write the decisions and open items that must survive into `.omc/notepad.md` via `notepad_write_working`.
3. Do not summarise the conversation yourself and do not claim compaction happened.
4. Tell the user:

```text
OMC state is saved. Run Cursor's built-in /summarize now<, and include: "<note>">.
OMC's preCompact hook also preserves notepad, project memory and wiki context when Cursor compacts.
```
