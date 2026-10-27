---
name: remember
description: "Review reusable knowledge from the current Cursor chat and decide what belongs in OMC project memory, the notepad, or durable docs and rules"
---

# Remember

Use this skill when the user wants to preserve or organize useful knowledge discovered during a session.

## Goal
Promote durable, reusable knowledge into the right memory surface instead of leaving it buried in chat history.

## Memory surfaces
- **Project memory** — durable team/project knowledge (`project_memory_*` tools, `.omc/project-memory.json`)
- **Notepad priority** — short high-signal context for the next turns (`notepad_*` tools, `.omc/notepad.md`)
- **Notepad working** — temporary active-session notes
- **Docs / `AGENTS.md` / Cursor rules (`.cursor/rules/*.mdc`)** — durable instructions and conventions when they truly belong there. An existing `CLAUDE.md` is only read by Cursor when third-party config loading is on; prefer `AGENTS.md` or a rule for new instructions.

## Workflow
1. Gather the relevant session findings.
2. Classify each item:
   - durable project fact
   - temporary working note
   - operator preference or instruction
   - duplicate / stale / conflicting information
3. Propose the best destination for each item.
4. Write or update only the appropriate memory surface.
5. Call out duplicates or conflicts that should be cleaned up.

## Rules
- Do not dump everything into one store.
- Prefer project memory for durable team knowledge.
- Prefer notepad for short-lived working context.
- Keep entries concise and actionable.
- If something is uncertain, mark it as uncertain rather than storing it as fact.

## Output
- What was stored
- Where it was stored
- Any duplicates/conflicts found

