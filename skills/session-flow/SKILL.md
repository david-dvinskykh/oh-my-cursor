---
name: session-flow
description: "Reorient in the current Cursor chat with an evidence-backed map of its goal, pivots, outcomes, current step, and open decisions."
argument-hint: "[short|reset]"
disable-model-invocation: true
---

# Session Flow

Build a compact, evidence-backed map of how this conversation actually unfolded so the user can reorient after switching sessions or compacting. This is an advisory summary, not a planner, executor, or replacement for the user's task list.

## Modes

- No argument: render the full map and reconcile its session-flow items on Cursor's to-do list (the to-do list tool, `todo_write`).
- `short`: return only the goal, current stage, and what (if anything) needs the user. Read-only; do not change the to-do list.
- `reset`: remove only to-do items owned by this skill, then confirm what was removed. Do not render a new map.

## Workflow

1. Reconstruct the flow from this conversation's user messages and tool results. Do not treat repository state alone as evidence that a stage happened. Separate the original goal from explicit goal changes, pivots, completed outcomes, dropped paths, and decisions still waiting on the user.
2. Make 4–8 meaningful stages when the history supports them; use fewer rather than padding sparse histories or inventing work. Use one outcome per stage:
   - `✅` completed with an outcome supported by the conversation
   - `▶` the current unfinished stage
   - `○` an explicitly planned but unstarted stage
   - `✂` dropped, with the stated reason
   - `↪` a pivot, with the old direction and the evidenced new direction
3. Give every stage one compact evidence pointer. Use a real URL or artifact path when one appears in the conversation; otherwise cite a distinctive short user quote or tool result. Never invent a link or state an inference as fact. Mark uncertain or pre-compaction reconstruction as `inferred`.
4. Keep the full map to at most 15 lines: one line per stage, plus concise goal, `Needs you`, and `Next` lines. Include open decisions in `Needs you`; say `none` when there are none. `Next` must be a concrete next action only when the conversation supports one.
5. In the default and `reset` modes, start from the current to-do list as it stands in this chat (the latest `todo_write` state). Cursor to-do items have only an id, a content line and a status, so ownership is encoded in the id and content: an item belongs to this skill only when its id is `session-flow-S<number>` **and** its content starts with `[S<number>]` and ends with the marker `(session-flow: managed stage)`. Never edit, complete, remove, or reuse an item that lacks either marker.
6. In the default mode, call `todo_write` with `merge: true`: update owned items that still represent a stage, and add missing stages with id `session-flow-S<number>` and content `[S<number>] <stage> — evidence: <pointer> (session-flow: managed stage)`. Match statuses to the map: completed (including dropped or pivoted) is `completed`, current is `in_progress`, and planned is `pending`. For owned items whose stage is no longer in the reconstructed map, set status `cancelled` (the to-do list has no delete). Keep surviving stage numbers stable and never collide with unowned items' ids.
7. Cursor's to-do list is per chat and is not persisted to a location the OMC stop hook reads, so these items do not trigger OMC continuation; they are descriptive records only. Preserve both markers on every write so later runs can recognise them. `short` must not call `todo_write`.
8. For `reset`, identify owned items from the current list, then call `todo_write` with `merge: true` setting only those items to `cancelled`; Cursor cannot delete individual items. Report which items were cancelled.
9. If the to-do list tool is unavailable, or the current list is not visible (for example after compaction), render the map without claiming it was persisted. For `reset`, report that owned items could not be inspected or removed; do not guess which items belong to the skill.

## Output

Use a stable, concise shape:

```text
🎯 Goal: <goal and any evidenced change>
✅ S1 <stage> → <outcome> — evidence: <source pointer>
↪ S2 <old direction> → <new direction> — evidence: <source pointer>
▶ S3 <current stage> — evidence: <source pointer>
✂ S4 <dropped path> — <reason> — evidence: <source pointer>
⏸ Needs you: <decision or none>
➡ Next: <supported next action or none>
```

Omit example rows that do not apply. Keep the stage order stable across calls unless the conversation provides evidence to correct it; update the owned to-do items to match any correction.
