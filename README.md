# oh-my-cursor

Multi-agent orchestration for **Cursor** — a native Cursor plugin port of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (OMC) 5.7.19.

OMC's agents, workflows (autopilot, ralph, team, ralplan, deep-interview, ultragoal, …), hooks and MCP tools run on Cursor's own building blocks:

| OMC concept | In Cursor |
|---|---|
| 19 specialised agents | Cursor subagents `omc-executor`, `omc-planner`, `omc-architect`, `omc-critic`, `omc-verifier`, … (`model: inherit`, read-only roles use `readonly: true`) |
| 48 skills | Cursor skills, invoked with `/<name>` (`/autopilot`, `/ralph`, `/team`, `/omc-plan`, `/omc-review`, …) |
| Coordinator `CLAUDE.md` | always-applied plugin rule `rules/omc.mdc` |
| Claude Code hooks | native Cursor hooks (`hooks/hooks.json`) through the adapter `cursor/hook.mjs` |
| `/team` on Claude agent teams | parallel Cursor subagents / `/multitask`, git worktrees, staged plan → exec → verify → fix |
| Persistence ("the boulder never stops") | Cursor `stop` hook follow-up messages |
| OMC MCP tools (state, notepad, project memory, LSP, ast-grep, wiki, …) | plugin MCP server `omc` |
| `~/.claude/` config | `~/.cursor/omc/` |

## Install

```bash
git clone https://github.com/david-dvinskykh/oh-my-cursor ~/.cursor/plugins/local/oh-my-cursor
```

1. In Cursor run **Developer: Reload Window**. The plugin's rule, agents, skills, hooks and the `omc` MCP server appear under **Customize**.
2. In a chat run `/omc-setup`. It installs the runtime's npm dependencies inside the plugin folder (`npm install --omit=dev --ignore-scripts`), the `omc` CLI shim (`~/.local/bin/omc`), checks hooks/MCP, and creates `~/.cursor/omc`.
3. If the Claude Code version of OMC is installed too, turn off *Settings → Rules, Skills, Subagents → Include third-party Plugins, Skills, and other configs*, otherwise OMC hooks and skills run twice.

### Install without the plugin system

If Cursor says local plugin import is blocked (the Enterprise admin setting *Allow Local Plugin Imports* is off), install the same components as plain user-level Cursor config:

```bash
git clone https://github.com/david-dvinskykh/oh-my-cursor ~/oh-my-cursor
node ~/oh-my-cursor/tools/install-user.mjs --dry-run   # preview
node ~/oh-my-cursor/tools/install-user.mjs --deps      # install + runtime dependencies
```

It copies the rule, agents, skills and commands into `~/.cursor/{rules,agents,skills,commands}` and merges one oh-my-cursor entry per event into `~/.cursor/hooks.json` and the `omc` server into `~/.cursor/mcp.json` (backups are written first; your own hooks and servers stay). Existing skills with the same name are skipped unless you pass `--force`. Keep the checkout where it is — the hooks point at it. Then reload the window and run `/omc-setup`.

- Update: `git -C ~/oh-my-cursor pull && node ~/oh-my-cursor/tools/install-user.mjs`
- Remove: `node ~/oh-my-cursor/tools/install-user.mjs --uninstall`
- If the orchestration rule does not show up from `~/.cursor/rules`, install it per project with `--project <repo>` (writes `<repo>/.cursor/rules/omc.mdc`) or paste `rules/omc.mdc` into *Cursor Settings → Rules → User Rules*.
- An org policy can still disable user hooks or MCP servers; `/omc-doctor` shows what is active.

Requirements: Cursor with plugins and hooks, Node.js 20+, git. Optional: `jq` (setup progress tracking), tmux and `cursor-agent` / `codex` / `gemini` CLIs for external CLI teams (`omc team N:cursor …`).

Update: `git -C ~/.cursor/plugins/local/oh-my-cursor pull`, reload the window, `/omc-setup` → *Refresh runtime*.

## Use

```
/autopilot "build a REST API for bookstore inventory"   idea → spec → plan → code → QA
/ralph "make all tests pass"                             keep going until verified done
/team 3:executor "fix all TypeScript errors"             parallel subagents, staged pipeline
/ralplan "migrate auth to OAuth2"                         planner + architect + critic consensus
/deep-interview "I want a better onboarding flow"         clarify before building
/cancel                                                   stop any active mode
/omc-doctor                                               diagnose the install
```

Magic words in a normal prompt work too: `ralph`, `autopilot`, `ralplan`, `deep interview`, `ultragoal`, `tdd`, `deslop`, `ultrathink`, `cancelomc`.

Parallel work: the lead chat launches several `omc-*` subagents in one message, or use `/multitask` in the Agents Window. Overlapping edits get separate git worktrees.

## What differs from Claude Code

- **Models.** Every `omc-*` agent inherits the chat's model; there are no haiku/sonnet/opus tiers.
- **Prompt hook.** Cursor's `beforeSubmitPrompt` cannot add context, so keyword routing is detected by the agent via the rule; the hook's note is delivered with the next tool result (or replayed once at `stop`).
- **No HUD/statusline.** `/hud` prints a status report in chat instead.
- **No `/goal`, no `/compact`.** Ultragoal persists through its ledger and the stop hook; `/omc-compact` prepares state before Cursor's `/summarize`.
- **No PermissionRequest/Notification events.** OMC's safe-command auto-approval runs on `beforeShellExecution`.
- **Subagents cannot message each other**, and nest one level only; `/team` coordinates through prompts, `.omc/state/team/<team>/tasks.json` and per-worker status files.
- OMC project settings the runtime reads stay at `.claude/omc.jsonc` and `.claude/settings.json` (OMC keys only).

## Layout

```
.cursor-plugin/plugin.json   plugin manifest
rules/omc.mdc                orchestration rule (always applied)
agents/omc-*.md              subagents
skills/<name>/SKILL.md       skills
commands/                    psm, omc-compact
hooks/hooks.json             native Cursor hooks -> cursor/hook.mjs
mcp.json                     omc MCP server
cursor/                      hook adapter, tests, hand-ported overrides
tools/port/                  converter + PORTING.md (how to sync with upstream)
scripts/ dist/ bridge/ templates/   OMC runtime (upstream, unchanged)
```

Kill switches: `DISABLE_OMC=1` disables all hooks, `OMC_SKIP_HOOKS=<names>` skips some, `OMC_CURSOR_DEBUG=1` logs adapter errors to stderr.

## Development

```bash
node --test cursor/test/*.test.mjs              # hook adapter tests (fixture scripts, no upstream code)
node tools/port/convert.mjs <oh-my-claudecode checkout>   # regenerate agents/skills from upstream
```

Hand-ported files live in `cursor/overrides/` and win over the converter's output; see `tools/port/PORTING.md`.

## Credits and license

MIT. Based on oh-my-claudecode by Yeachan Heo and contributors (MIT); see `NOTICE.md` and `LICENSE`.
