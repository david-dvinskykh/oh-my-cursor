---
name: omc-doctor
description: "Diagnose and fix an oh-my-cursor install in Cursor: plugin manifest, Node and runtime deps, omc CLI shim, hooks adapter, omc MCP server, ~/.cursor/omc config, .omc state health (stale or stuck modes, orphaned workers, worktrees), duplicate OMC from a Claude Code side-install, and legacy Claude-side files Cursor would import"
argument-hint: "[--fix]"
---

# OMC Doctor (Cursor)

You are the OMC Doctor for **oh-my-cursor**. Run every check below, collect evidence,
print the report, then offer fixes. Never change anything without the user's consent
(see "Fixes"). Read-only checks may run without asking.

Conventions used below:
- `$OMC_PLUGIN_ROOT` is the absolute plugin root printed by the sessionStart hook
  (`Plugin root: …`). Export it once in the shell: `export OMC_PLUGIN_ROOT=<that path>`.
- OMC user config dir is `~/.cursor/omc` (override: `OMC_CURSOR_CONFIG_DIR`). OMC for
  Cursor never writes to `~/.claude/`; paths under `~/.claude/` and `.claude/` below are
  only inspected to detect a Claude Code side-install or legacy files.
- Status levels: OK, INFO, WARN, CRITICAL.

## Step 1: Locate the plugin root and validate the manifest

If the session context has no `Plugin root:` line, the sessionStart hook did not run
(CRITICAL — hooks not loaded) and you must locate the root yourself:

```bash
for d in "$OMC_PLUGIN_ROOT" "$HOME/.cursor/plugins/local/oh-my-cursor"; do
  [ -n "$d" ] && [ -f "$d/.cursor-plugin/plugin.json" ] && { echo "ROOT: $d"; break; }
done
```

Then validate the manifest and the components it declares:

```bash
node -e '
const p=require("path"),f=require("fs"),r=process.argv[1];
let m;try{m=JSON.parse(f.readFileSync(p.join(r,".cursor-plugin","plugin.json"),"utf8"))}catch(e){console.log("MANIFEST: INVALID -",e.message);process.exit()}
console.log("MANIFEST: OK name="+m.name+" version="+m.version);
if(m.name!=="oh-my-cursor")console.log("MANIFEST: WARN unexpected name");
for(const k of ["rules","agents","skills","commands","hooks","mcpServers"]){const v=m[k];if(!v){console.log("COMPONENT "+k+": NOT DECLARED");continue}
console.log("COMPONENT "+k+": "+(f.existsSync(p.join(r,v))?"OK":"MISSING")+" ("+v+")")}
' "$OMC_PLUGIN_ROOT"
```

If the root is a git checkout, also report its version freshness (INFO only):

```bash
git -C "$OMC_PLUGIN_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 && {
  git -C "$OMC_PLUGIN_ROOT" status --short --branch | head -5
  git -C "$OMC_PLUGIN_ROOT" log -1 --format='HEAD %h %cs %s'
}
```

**Diagnosis**:
- No root found: CRITICAL — plugin not installed. Local install: clone into
  `~/.cursor/plugins/local/oh-my-cursor`, then *Developer: Reload Window*.
- Manifest missing/invalid JSON or a declared component missing: CRITICAL.
- Root found but no `Plugin root:` line in the session context: CRITICAL — the plugin's
  hooks are not running (check that the plugin shows under **Customize** and reload the window).
- Uncommitted changes or branch behind its upstream: INFO (update with `git pull`, then reload).

## Step 2: Node runtime

Cursor runs every OMC hook and the MCP server with `node` from a non-interactive shell.

```bash
command -v node && node --version || echo "NODE: MISSING"
node -e 'const r=require(process.argv[1]+"/package.json").engines?.node;console.log("Required:",r)' "$OMC_PLUGIN_ROOT"
```

**Diagnosis**:
- `node` missing: CRITICAL — hooks, MCP server and ralph persistence cannot run
  (nvm/fnm users need Node on the PATH of non-interactive shells and of the Cursor app).
- Major version not in the `engines` range (currently 20/22/23/24/25/26): WARN.

## Step 3: Runtime dependencies

```bash
[ -d "$OMC_PLUGIN_ROOT/node_modules/commander" ] && echo "DEPS: OK" || echo "DEPS: MISSING"
```

**Diagnosis**: missing → CRITICAL. Fix: run the `omc-setup` skill (`/omc-setup`), which
runs `npm install --omit=dev --ignore-scripts` in the plugin root.

## Step 4: `omc` CLI shim

```bash
if command -v omc >/dev/null 2>&1; then
  echo "SHIM: $(command -v omc)"; head -5 "$(command -v omc)" 2>/dev/null
  omc version 2>&1 | head -3
else
  echo "SHIM: NOT ON PATH"
fi
```

**Diagnosis**:
- On PATH and the shim script references `$OMC_PLUGIN_ROOT/bridge/cli.cjs` (same root as
  Step 1): OK.
- On PATH but points to another root, or `omc` resolves to a different package (for
  example a global npm install of the upstream `oh-my-claude-sisyphus` CLI): WARN — the
  CLI may read a different runtime than the plugin.
- Not on PATH: WARN — skills fall back to `node "$OMC_PLUGIN_ROOT/bridge/cli.cjs"`;
  `/omc-setup` installs the shim at `~/.local/bin/omc` (also check that `~/.local/bin`
  is on PATH).

## Step 5: Hooks file and adapter

```bash
node -e '
const p=require("path"),f=require("fs"),r=process.argv[1];
let h;try{h=JSON.parse(f.readFileSync(p.join(r,"hooks","hooks.json"),"utf8"))}catch(e){console.log("HOOKS: INVALID -",e.message);process.exit()}
const ev=Object.keys(h.hooks||{});console.log("HOOKS: "+ev.length+" events: "+ev.join(", "));
for(const e of ev)for(const x of h.hooks[e])if(!String(x.command).includes("cursor/hook.mjs"))console.log("HOOKS: WARN "+e+" does not use cursor/hook.mjs: "+x.command);
' "$OMC_PLUGIN_ROOT"
echo '{}' | node "$OMC_PLUGIN_ROOT/cursor/hook.mjs" sessionStart | head -c 600; echo
echo "DISABLE_OMC=${DISABLE_OMC:-<unset>} OMC_SKIP_HOOKS=${OMC_SKIP_HOOKS:-<unset>}"
```

The adapter test runs OMC's session-start scripts for the current workspace; that is
expected and safe.

**Diagnosis**:
- `hooks/hooks.json` missing or invalid: CRITICAL.
- Adapter prints a JSON object whose `additional_context` starts with
  `[oh-my-cursor] OMC orchestration is active`: OK.
- Adapter prints `{}` only: WARN — the adapter failed open. Re-run with
  `OMC_CURSOR_DEBUG=1` to see the error on stderr.
- Adapter prints nothing or non-JSON: CRITICAL.
- `DISABLE_OMC` set: INFO — every OMC hook is disabled on purpose. `OMC_SKIP_HOOKS` set: INFO.

Also look for manual copies of OMC hooks in Cursor's own hook files (they would run in
addition to the plugin's hooks):

```bash
for f in "$HOME/.cursor/hooks.json" ".cursor/hooks.json"; do
  [ -f "$f" ] && grep -nE 'hook\.mjs|keyword-detector|persistent-mode|session-start\.mjs|oh-my-c' "$f" && echo "^ in $f"
done
```

Any match: WARN — duplicate OMC hook registration (manual cleanup, with consent).

## Step 6: `omc` MCP server

1. Validate `$OMC_PLUGIN_ROOT/mcp.json` (valid JSON, server `omc` pointing at
   `${CURSOR_PLUGIN_ROOT}/bridge/mcp-server.cjs`, file exists).
2. Live check: call the `state_list_active` tool. If the tool is available and returns,
   the server is visible and enabled: OK.
3. If the tool is not available: CRITICAL — the `omc` server is not loaded or is disabled.
   Ask the user to open **Customize** (or Cursor's MCP settings) and enable the
   oh-my-cursor `omc` server, then reload the window. A server that is listed but
   errors usually means missing deps (Step 3) or Node (Step 2).
4. Duplicates: check `~/.cursor/mcp.json` and `.cursor/mcp.json` for another server that
   runs `mcp-server.cjs` from an OMC checkout or Claude Code plugin cache:

```bash
for f in "$HOME/.cursor/mcp.json" ".cursor/mcp.json"; do
  [ -f "$f" ] && grep -nE 'mcp-server\.cjs|oh-my-c' "$f" && echo "^ in $f"
done
```

   Any match: WARN — a second OMC MCP server (duplicate tools, possibly another runtime version).

## Step 7: OMC config dir `~/.cursor/omc`

```bash
D="${OMC_CURSOR_CONFIG_DIR:-$HOME/.cursor/omc}"; echo "CONFIG DIR: $D"
mkdir -p "$D" 2>/dev/null && touch "$D/.omc-write-probe" 2>/dev/null && rm -f "$D/.omc-write-probe" && echo "WRITABLE" || echo "NOT WRITABLE"
for f in .omc-config.json settings.json; do
  [ -f "$D/$f" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("VALID",process.argv[1])' "$D/$f" 2>/dev/null || { [ -f "$D/$f" ] && echo "INVALID JSON $D/$f"; }
done
```

**Diagnosis**:
- Not writable: WARN — ralph/autopilot persistence and config writes will fail.
- `.omc-config.json` or `settings.json` invalid JSON: WARN — the runtime falls back to defaults.
- Missing `.omc-config.json`: INFO — `/omc-setup` has not been run yet; defaults apply.
- Project config the runtime also reads (`.claude/omc.jsonc`, OMC keys in
  `.claude/settings.json`, `~/.config/claude-omc/config.jsonc`) is legitimate — do not
  flag it as legacy. Only validate that any present file parses.

## Step 8: `.omc/` state health

Run in the workspace root (or `$OMC_STATE_DIR/{project-id}/` when `OMC_STATE_DIR` is set).

1. Active modes — call `state_list_active` with `all: true`, then `state_get_status`
   (no mode) for details.
2. Inventory state files and their age:

```bash
ls -la .omc/state/ 2>/dev/null
find .omc/state -maxdepth 3 -name '*-state.json' -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort
find .omc/state/sessions -mindepth 1 -maxdepth 1 -type d -mtime +1 2>/dev/null
ls .omc/state/team 2>/dev/null
```

3. Evaluate:
- **Stuck active mode**: a mode file (`ralph-state.json`, `autopilot-state.json`,
  `ultrawork-state.json`, `ralplan-state.json`, `team-state.json`, `ultragoal-state.json`, …)
  with `active: true` whose freshest of `last_checked_at` / `updated_at` / `started_at` is
  older than 2 hours: WARN — stale persistence state; it can make the `stop` hook keep
  sending "The boulder never stops" follow-ups. Fix: `/cancel` (preferred) or
  `state_clear` for that mode.
- **Ralph at its limit**: `iteration >= max_iterations` while `active: true`: WARN.
- **Lingering cancel signal**: `cancel-signal-state.json` older than a few minutes: INFO (safe to clear).
- **Stale subagents**: in `.omc/state/sessions/*/subagent-tracking-state.json`, agents with
  `status: "running"` and `started_at` older than 5 minutes when no subagent is actually
  running in this chat: INFO — tracking left behind by an interrupted subagent.
- **Old session dirs**: `.omc/state/sessions/<id>/` untouched for more than 24 hours with no
  active mode inside: INFO — safe to prune.
- **Malformed state**: any `*-state.json` that is not valid JSON: WARN.
- **Orphaned team workers**: for each directory in `.omc/state/team/`, run
  `omc team status <team-name>` (or `node "$OMC_PLUGIN_ROOT/bridge/cli.cjs" team status <team-name>`).
  A team whose workers are all dead but whose state still says running: WARN. Also list
  stray worker processes without killing them:
  `node "$OMC_PLUGIN_ROOT/scripts/cleanup-orphans.mjs" --dry-run`.

## Step 9: Git worktrees

```bash
git worktree list --porcelain 2>/dev/null | grep -E '^(worktree|branch|prunable|locked)'
```

**Diagnosis**:
- `prunable` entries: INFO — worktree directory gone; `git worktree prune` cleans the metadata.
- Worktrees left over from finished team/multitask runs (clean, branch merged): INFO —
  candidates for `git worktree remove`. Never remove a worktree with uncommitted changes.

## Step 10: Duplicate OMC (Claude Code plugin also installed)

Cursor's setting *Rules, Skills, Subagents → Include third-party Plugins, Skills, and
other configs* imports Claude Code skills, agents, CLAUDE.md and `.claude/settings.json`
hooks. If the Claude Code OMC plugin (oh-my-claudecode) is also installed and that
setting is on, OMC hooks and skills run twice.

```bash
ls -d "$HOME/.claude/plugins/cache/omc/oh-my-claudecode"/* 2>/dev/null
grep -l 'oh-my-claudecode' "$HOME/.claude/plugins/installed_plugins.json" "$HOME/.claude/settings.json" 2>/dev/null
grep -nE 'keyword-detector|persistent-mode|session-start|oh-my-claudecode' "$HOME/.claude/settings.json" .claude/settings.json .claude/settings.local.json 2>/dev/null
```

The setting's value is not readable from a file. If any Claude-side OMC install or
OMC hook registration is found, ask the user (AskQuestion) whether the third-party
setting is on. Signs it is: duplicate `[MAGIC KEYWORD: …]` notes, two copies of OMC skills
(for example `ralph` listed twice) or agents without the `omc-` prefix (`executor`,
`architect`) appearing alongside `omc-executor`.

**Diagnosis**:
- Claude-side OMC found and setting on (or unknown): CRITICAL — duplicate hooks/skills.
  Recommended fix: turn the setting off. Removing the Claude Code plugin is the
  alternative only if the user no longer uses Claude Code.
- Claude-side OMC found and setting off: OK (INFO: side-install present, ignored by Cursor).
- Nothing found: OK.

## Step 11: Legacy Claude-side OMC files in the project

With third-party loading on, Cursor also imports project-level Claude files. Old OMC files
there give Claude Code instructions (Claude-only tools, model tiers, unprefixed agent names)
that conflict with this plugin.

```bash
ls .claude/agents/ .claude/skills/ .claude/commands/ 2>/dev/null
grep -ln '<!-- OMC:START -->' CLAUDE.md .claude/CLAUDE.md "$HOME/.claude/CLAUDE.md" "$HOME/.claude"/CLAUDE-*.md AGENTS.md 2>/dev/null
```

Flag only files whose names match OMC-provided names — never user content:
- Agents (`.claude/agents/`): `architect.md`, `document-specialist.md`, `explore.md`,
  `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`,
  `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`,
  `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`, `tracer.md`
- Skills (`.claude/skills/`): any folder whose name matches a folder in
  `$OMC_PLUGIN_ROOT/skills/` (for example `autopilot`, `cancel`, `deep-interview`, `hud`,
  `omc-doctor`, `omc-setup`, `plan`, `ralph`, `ralplan`, `team`, `ultragoal`, `wiki`)
- Commands (`.claude/commands/`): `deepsearch.md`
- An OMC block (`<!-- OMC:START -->` … `<!-- OMC:END -->`) in `CLAUDE.md`.

**Diagnosis**:
- Matches present and third-party loading on: WARN — conflicting legacy OMC instructions imported.
- Matches present and loading off: INFO — ignored by Cursor; keep them if the project is
  also used with Claude Code.
- An OMC block in `AGENTS.md`: WARN — OMC for Cursor ships its instructions as the
  `rules/omc.mdc` rule; a copied block duplicates (and may contradict) it.

## Step 12: Shadowing copies in Cursor's own locations

Copies of OMC agents/skills in Cursor's user or project folders override or duplicate the
plugin's versions:

```bash
ls "$HOME/.cursor/agents" .cursor/agents "$HOME/.cursor/skills" .cursor/skills 2>/dev/null
```

Flag only `omc-*.md` agent files and skill folders with the OMC skill names above:
WARN — stale copy shadows the plugin. Anything else is user content: OK.

---

## Report Format

```
## OMC Doctor Report (oh-my-cursor)

### Summary
[HEALTHY / ISSUES FOUND]

### Checks
| Check | Status | Details |
|-------|--------|---------|
| Plugin root & manifest | OK/WARN/CRITICAL | root, version |
| Node runtime | OK/WARN/CRITICAL | version |
| Runtime deps (commander) | OK/CRITICAL | |
| omc CLI shim | OK/WARN | path |
| Hooks file & adapter | OK/INFO/WARN/CRITICAL | |
| omc MCP server | OK/WARN/CRITICAL | |
| Config dir ~/.cursor/omc | OK/INFO/WARN | |
| .omc state health | OK/INFO/WARN | active modes, stale files |
| Git worktrees | OK/INFO | |
| Duplicate OMC (Claude Code side-install) | OK/INFO/CRITICAL | |
| Legacy Claude-side files in project | OK/INFO/WARN | |
| Shadowing copies in ~/.cursor / .cursor | OK/WARN | |

### Issues Found
1. …

### Recommended Fixes
…
```

---

## Fixes (only with consent)

If issues were found, ask with AskQuestion (multiple selection when available; otherwise
numbered options in chat and wait) which fixes to apply. List only fixes for issues
actually found, each naming the exact files/state it touches, plus "None".

Rules for every fix:
- Show exactly what will change before changing it. For files, back up first
  (`cp -p <file> <file>.omc-doctor-<timestamp>.bak`) and edit only the OMC-owned part.
- Never delete user content; never touch files outside the ones named in the proposal.
- Never edit Claude Code's own plugin cache or settings to "fix" Cursor — propose turning
  off the third-party setting instead.

Available fixes:
- **Missing deps / shim / config dir**: run the `omc-setup` skill (`/omc-setup`).
- **Plugin not loaded / hooks not running / MCP disabled**: user action in Cursor —
  enable the plugin and its `omc` server under **Customize**, then *Developer: Reload Window*.
- **Plugin outdated (git checkout)**: `git -C "$OMC_PLUGIN_ROOT" pull --ff-only`, then
  `/omc-setup` if `package.json` changed, then reload the window.
- **Stuck or stale mode state**: `/cancel`, or `state_clear` for the specific mode
  (add `session_id` for session-scoped state). Do not clear a mode that is genuinely in use.
- **Old session dirs / lingering cancel signal / stale subagent tracking**: delete only the
  listed files or `.omc/state/sessions/<id>/` directories.
- **Orphaned team workers**: `node "$OMC_PLUGIN_ROOT/scripts/cleanup-orphans.mjs" --team-name <name>`
  after showing the `--dry-run` output; then `state_clear` for `team` if its state is stale.
- **Prunable worktrees**: `git worktree prune`; remove clean, merged worktrees with
  `git worktree remove <path>` one by one.
- **Duplicate OMC from Claude Code**: user turns off *Include third-party Plugins, Skills,
  and other configs* (Cursor settings → Rules, Skills, Subagents) and reloads; or, only if
  they no longer use Claude Code, uninstalls oh-my-claudecode there.
- **Legacy Claude-side files**: when the project is no longer used with Claude Code, move the
  matching `.claude/agents|skills|commands` files into `.claude/.omc-legacy-backup/` and cut
  the `<!-- OMC:START -->…<!-- OMC:END -->` block out of `CLAUDE.md` (backup first). If the
  project is still used with Claude Code, recommend turning off third-party loading instead.
- **OMC block in AGENTS.md / duplicate hooks or MCP entries in `.cursor` / `~/.cursor`
  files / shadowing copies**: remove only the matching block or entry (backup first).

## Post-Fix

Re-run the affected checks and show the updated rows. If the plugin, hooks, MCP config or
Cursor settings changed, tell the user:
> Fixes applied. Run **Developer: Reload Window** in Cursor for them to take effect.

## Not available in Cursor

- Claude Code plugin cache/marketplace version checks, `statusLine`/HUD setup and the
  `~/.claude/settings.json` standalone-hook fingerprint audit from upstream OMC do not apply:
  oh-my-cursor installs as a Cursor plugin and registers hooks only through `hooks/hooks.json`.
  (`node-hook-fingerprints.json` beside this skill is kept for reference only.)
- The value of the third-party loading setting cannot be read from a file; ask the user.
