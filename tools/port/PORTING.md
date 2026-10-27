# Porting oh-my-claudecode to Cursor — conventions

oh-my-cursor ships the OMC runtime (scripts/, dist/, bridge/, templates/) unchanged and
replaces every Claude Code surface with a native Cursor one. This file is the reference
for anyone (human or agent) editing the ported skills and agents.

## How the port is built

1. `node tools/port/convert.mjs <oh-my-claudecode checkout>` regenerates `agents/`,
   `skills/` and `commands/` from upstream with mechanical rewrites (see `RULES` in
   convert.mjs).
2. Hand-ported files live in `cursor/overrides/<same relative path>` and are copied
   over the mechanical output. Edit the override, never the generated copy.
3. `cursor/overrides/OMIT` lists generated paths to delete (one per line, relative to
   the plugin root).

## Cursor facts the port relies on

**Plugin.** `.cursor-plugin/plugin.json` declares `rules/`, `agents/`, `skills/`,
`commands/`, `hooks/hooks.json`, `mcp.json`. Local install: clone into
`~/.cursor/plugins/local/oh-my-cursor`, then *Developer: Reload Window*; components show
under **Customize**. `${CURSOR_PLUGIN_ROOT}` is expanded in mcp.json and hook commands.

**Plugin root inside skills.** The agent's shell does not get `CURSOR_PLUGIN_ROOT`.
The sessionStart hook prints the absolute plugin root. Skills write it as
`${OMC_PLUGIN_ROOT}` / `$OMC_PLUGIN_ROOT`; the agent substitutes the printed path (or
exports `OMC_PLUGIN_ROOT=<path>` once in the shell).

**OMC CLI.** `omc` when the shim from `/omc-setup` is on PATH
(`~/.local/bin/omc` → `node "$OMC_PLUGIN_ROOT/bridge/cli.cjs" "$@"`); otherwise
`node "$OMC_PLUGIN_ROOT/bridge/cli.cjs"`. Commands that spawn `claude` CLI sessions are
Claude-only; prefer `cursor-agent` where the CLI offers it (`omc team N:cursor ...`).

**Subagents.** Files in `agents/` with frontmatter `name`, `description`,
`model: inherit`, optional `readonly: true`, `is_background`. All OMC agents are named
`omc-<role>` (`omc-executor`, `omc-planner`, `omc-architect`, `omc-critic`, …) and all
use `model: inherit` — there are no haiku/sonnet/opus tiers. The parent invokes them
with the Task tool (`Task(subagent_type="omc-executor", prompt=...)`), by `/omc-<name>`,
or by naming them. Several Task calls in one message run in parallel. Background
subagents return immediately; their output lands in `~/.cursor/subagents/` and they can
be resumed by agent id. Nesting: a subagent may start subagents, one level only.
Subagents cannot message each other; coordination goes through the parent and files.

**Multitask.** `/multitask` in the Agents Window runs requests as async subagents and
lets Cursor split a large task across several subagents. There is no built-in conflict
prevention: give workers disjoint files or separate git worktrees (`/worktree`).

**Skills.** `skills/<name>/SKILL.md` with `name` and `description`. Invoked by
`/<name>` or when the agent decides it is relevant. There is no Skill tool: write
"invoke the `ralph` skill (`/ralph`)" or "open `skills/ralph/SKILL.md` and follow it".

**Asking the user.** Cursor's `AskQuestion` tool (multiple choice). If unavailable,
ask in chat with numbered options and wait.

**To-do list.** Cursor's to-do list tool (todo_write). There are no Claude
`TaskCreate/TaskUpdate/TaskList/TaskGet` or `SendMessage`/`TeamCreate` tools.

**Hooks.** Native events: sessionStart, beforeSubmitPrompt, preToolUse,
beforeShellExecution, postToolUse, postToolUseFailure, subagentStart, subagentStop,
preCompact, stop, sessionEnd (also afterFileEdit, afterShellExecution,
beforeMCPExecution, beforeReadFile, afterAgentResponse, workspaceOpen).
`cursor/hook.mjs` translates them for the OMC scripts. Important differences:
- `beforeSubmitPrompt` cannot add model context. Keyword routing text is queued and
  delivered with the next tool result or replayed by `stop`; the `rules/omc.mdc` rule
  also tells the agent to detect magic keywords itself.
- `stop` continuation (`followup_message`) is how ralph/autopilot/ultragoal persistence
  works ("The boulder never stops").
- No PermissionRequest and no Notification events. No statusline/HUD API.
- No `/goal` command (Claude Code feature). No `/compact`; Cursor's manual compaction is
  `/summarize`.

**MCP.** The plugin's `omc` server (`bridge/mcp-server.cjs`) exposes `state_*`,
`notepad_*`, `project_memory_*`, `shared_memory_*`, `lsp_*`, `ast_grep_*`,
`python_repl`, `session_search`, `trace_*`, `wiki_*`, `deepinit_manifest`. Call them by
tool name (`state_write`), not `mcp__plugin_…`.

**Config.** OMC user config is `~/.cursor/omc/` (the runtime's `CLAUDE_CONFIG_DIR` is
pointed there, so `~/.cursor/omc/.omc-config.json`, `~/.cursor/omc/settings.json`, …).
Project config the runtime reads stays at `.claude/omc.jsonc` and `.claude/settings.json`
(OMC keys only) and `~/.config/claude-omc/config.jsonc`. State stays in `.omc/`.
Cursor's own locations: rules `.cursor/rules/*.mdc` and user rules, skills
`.cursor/skills` / `~/.cursor/skills`, agents `.cursor/agents` / `~/.cursor/agents`,
commands `.cursor/commands`, hooks `.cursor/hooks.json` / `~/.cursor/hooks.json`,
MCP `.cursor/mcp.json` / `~/.cursor/mcp.json`. Project instructions file: `AGENTS.md`.

**Third-party loading.** Cursor's setting *Rules, Skills, Subagents → Include
third-party Plugins, Skills, and other configs* imports Claude Code skills, agents,
CLAUDE.md and `.claude/settings.json` hooks. If the Claude Code OMC plugin is also
installed, turn that off (or remove the Claude copy) so OMC hooks do not run twice.

## Writing rules for ported text
- Keep upstream behaviour and structure; change only what depends on the host.
- Never claim a Cursor feature that is not listed above. When something has no Cursor
  equivalent, say so plainly and give the closest native path.
- Keep code identifiers, CLI flags and state file names unchanged — the runtime reads them.
- Everything in files is English.
