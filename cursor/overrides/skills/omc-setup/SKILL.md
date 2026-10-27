---
name: omc-setup
description: "Install, refresh or repair oh-my-cursor (OMC for Cursor): runtime dependencies, the omc CLI shim, hook and MCP checks, OMC config and project setup"
argument-hint: "[--force] [--project] [--help]"
---

# OMC Setup (Cursor)

This is the one command to run after installing or updating the oh-my-cursor plugin. When invoked, execute the workflow below — do not only summarise it.

The plugin's rule, agents, skills, hooks and MCP server are loaded by Cursor itself; there is no coordinator file to install. Setup prepares what Cursor cannot: the runtime's npm dependencies, the `omc` CLI, OMC's config directory and optional project files.

## Flags

- `--help` → print the help text below and stop.
- `--force` → skip the "already configured" check and run every step.
- `--project` → run only the project steps (Step 7) for the current workspace.
- no flags → pre-check, then the full flow.

```
OMC Setup - configure oh-my-cursor

USAGE:
  /omc-setup             First-time setup, or refresh after an update
  /omc-setup --project   Prepare the current project only (.gitignore, rule templates)
  /omc-setup --force     Run every step even if setup was completed before
  /omc-setup --help      Show this help

WHAT IT DOES:
  - installs runtime dependencies in the plugin folder (npm, no install scripts)
  - installs the `omc` CLI shim (~/.local/bin/omc)
  - checks the hook adapter, the omc MCP server and duplicate Claude Code installs
  - creates ~/.cursor/omc (OMC config) and records setup completion
  - optional: team defaults, task tool, project .gitignore, rule templates, notifications
```

## Step 0: Resolve the plugin root and config dir

The plugin root is printed at session start ("Plugin root (skills call it $OMC_PLUGIN_ROOT): …"). Use that exact path. If it is missing, look for `~/.cursor/plugins/local/oh-my-cursor` or ask the user where the plugin is installed. Every shell block below starts with:

```bash
export OMC_PLUGIN_ROOT="<plugin root>"
export CLAUDE_CONFIG_DIR="$HOME/.cursor/omc"   # OMC's runtime config dir under Cursor
test -f "$OMC_PLUGIN_ROOT/.cursor-plugin/plugin.json" || echo "ERROR: not an oh-my-cursor plugin root: $OMC_PLUGIN_ROOT"
node -p "require(process.env.OMC_PLUGIN_ROOT + '/.cursor-plugin/plugin.json').version"
```

Stop and report if the plugin root is invalid.

## Step 1: Already configured?

Skip this step with `--force` or `--project`.

```bash
CONFIG_FILE="$HOME/.cursor/omc/.omc-config.json"
if [ -f "$CONFIG_FILE" ]; then
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("setupCompleted:",c.setupCompleted||"no");console.log("setupVersion:",c.setupVersion||"-")' "$CONFIG_FILE" \
    || echo "ERROR: $CONFIG_FILE is not valid JSON; it was not modified."
fi
```

If setup was completed before, ask with AskQuestion:

**Question:** "oh-my-cursor is already set up. What would you like to do?"
1. **Refresh runtime (recommended after an update)** — run Steps 2, 3, 4 and 8 only.
2. **Run the full setup again** — continue with Step 2.
3. **Cancel** — exit without changes.

Also offer to resume an interrupted run (the progress helper needs `jq`; without it skip resume detection and run the full flow):

```bash
command -v jq >/dev/null && bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" resume || echo "fresh (jq not installed: progress tracking off)"
```

If the output is not `fresh`, ask whether to resume from the saved step or start fresh (`bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" clear`).

## Step 2: Runtime dependencies

Hooks, the CLI and parts of the MCP server need the runtime's npm dependencies inside the plugin folder (Node 20+ required).

```bash
node --version
npm --prefix "$OMC_PLUGIN_ROOT" ci --omit=dev --ignore-scripts --no-audit --no-fund   # lockfile install; --prefix keeps the shell in the project
test -d "$OMC_PLUGIN_ROOT/node_modules/commander" && echo "runtime dependencies: OK"
```

The plugin ships a runtime-only `package.json` plus `package-lock.json`, so `npm ci` installs a fixed set (~150 packages) and works through corporate registries such as Nexus (npm swaps the lockfile's registry host for the configured one). If `npm ci` fails, report the error and stop; do not fall back to the upstream dev manifest. `--ignore-scripts` is deliberate; native optional modules (`better-sqlite3`, `@ast-grep/napi`) may be skipped, and OMC degrades gracefully without them (`ast_grep_*` tools report unavailability).

Save progress (only if `jq` is installed): `bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" save 2 cursor`

## Step 3: `omc` CLI shim

Skills call `omc …` (ralph verify, ultragoal, team, ask, doctor). Install a shim that runs the bundled CLI:

```bash
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/omc" <<EOF
#!/usr/bin/env sh
export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.cursor/omc}"
export OMC_PLUGIN_ROOT="$OMC_PLUGIN_ROOT"
exec node "$OMC_PLUGIN_ROOT/bridge/cli.cjs" "\$@"
EOF
chmod +x "$HOME/.local/bin/omc"
command -v omc >/dev/null && omc --version || echo "Add \$HOME/.local/bin to PATH to use 'omc' directly."
```

If an `omc` from the Claude Code package (`oh-my-claude-sisyphus`) is already earlier on PATH, tell the user which one wins (`command -v omc`) and that the shim keeps OMC's config in `~/.cursor/omc`. On Windows, create `omc.cmd` in a PATH directory with `@node "<plugin root>\bridge\cli.cjs" %*` and set `CLAUDE_CONFIG_DIR=%USERPROFILE%\.cursor\omc`.

Save progress (only if `jq` is installed): `bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" save 3 cursor`

## Step 4: Hooks, MCP and duplicates

1. **Hook adapter** — must print JSON:

   ```bash
   printf '{"conversation_id":"omc-setup-check","workspace_roots":["%s"]}' "$PWD" \
     | node "$OMC_PLUGIN_ROOT/cursor/hook.mjs" sessionStart
   ```

   Then confirm in Cursor that the plugin's hooks are listed (Customize → the oh-my-cursor plugin → Hooks). If hooks are missing, the plugin is not installed or enabled; reinstall and run **Developer: Reload Window**.

2. **MCP server** — the `omc` server comes with the plugin. Check that `state_read` (or another `omc` tool) is available in this chat. If not, ask the user to enable the `omc` MCP server in Cursor's MCP settings and reload.

3. **Duplicate OMC** — if the Claude Code OMC plugin is also installed (`~/.claude/plugins` contains `oh-my-claudecode`, or the project's `.claude/settings.json` has OMC hooks) and Cursor's *Rules, Skills, Subagents → Include third-party Plugins, Skills, and other configs* is on, OMC hooks and skills run twice. Ask the user to turn that setting off or remove the Claude copy from Cursor's view. Do not edit Claude Code files yourself.

## Step 5: Config directory and retired values

```bash
mkdir -p "$HOME/.cursor/omc" && touch "$HOME/.cursor/omc/.omc-write-probe" && rm -f "$HOME/.cursor/omc/.omc-write-probe" \
  || echo "WARNING: ~/.cursor/omc is not writable; persistent modes (ralph, ultragoal) will fail."
CONFIG_FILE="$HOME/.cursor/omc/.omc-config.json"
[ -f "$CONFIG_FILE" ] || echo '{}' > "$CONFIG_FILE"
node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));if("defaultExecutionMode" in c){delete c.defaultExecutionMode;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");console.log("cleared retired defaultExecutionMode")}' "$CONFIG_FILE"
```

Never write a new `defaultExecutionMode` (removed in OMC 5.0.0).

## Step 6: Preferences (optional)

Ask with AskQuestion (one question per decision):

1. **Team defaults** — maximum worker count (e.g. 5 / 8 / 20) and the default agent type for external CLI teams (`cursor` recommended, `codex`, `gemini`, `claude`). The runtime reads them from `team.ops` in `~/.config/claude-omc/config.jsonc` (user; `.claude/omc.jsonc` per project overrides it). If that file exists and contains comments, edit it by hand to add the keys; otherwise:

   ```bash
   USER_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/claude-omc/config.jsonc"
   mkdir -p "$(dirname "$USER_CFG")"
   [ -f "$USER_CFG" ] || echo '{}' > "$USER_CFG"
   node -e 'const f=process.argv[1],fs=require("fs");let c;try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{console.log("config.jsonc has comments or is invalid: add team.ops by hand");process.exit(0)};c.team={...(c.team||{}),ops:{...((c.team||{}).ops||{}),maxAgents:Number(process.argv[2]),defaultAgentType:process.argv[3]}};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$USER_CFG" <MAX_AGENTS> <AGENT_TYPE>
   ```

2. **Task tool** — only if `bd` (beads) or `br` (beads-rust) is on PATH: built-in (Cursor's to-do list, session-only), beads, or beads-rust. Store `taskTool` and `taskToolConfig: {"injectInstructions": true, "useMcp": false}` the same way.

3. **Notifications** — offer `/configure-notifications` (Telegram, Discord, Slack, webhooks).

Save progress (only if `jq` is installed): `bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" save 6 cursor`

## Step 7: Project setup (current workspace)

Ask before each change:

1. **Ignore OMC state** — append to `.gitignore` if missing:

   ```
   .omc/*
   !.omc/skills/
   !.omc/skills/**
   ```

2. **Rule templates** — OMC ships optional guideline templates (`coding-style`, `git-workflow`, `karpathy-guidelines`, `performance`, `security`, `testing`). Offer to install the chosen ones as Cursor project rules:

   ```bash
   mkdir -p .cursor/rules
   for name in <chosen names>; do
     { printf -- '---\ndescription: OMC %s guidelines\nalwaysApply: false\n---\n\n' "$name"; cat "$OMC_PLUGIN_ROOT/templates/rules/$name.md"; } > ".cursor/rules/omc-$name.mdc"
   done
   ```

3. **Legacy Claude-side OMC files** — if the project has an OMC block in `CLAUDE.md` or OMC agents in `.claude/agents/`, mention that Cursor may import them through its third-party setting; offer to leave them (Claude Code still uses them) or skip importing as in Step 4.3.

With `--project`, stop after this step.

## Step 8: Finish

```bash
VERSION=$(node -p "require(process.env.OMC_PLUGIN_ROOT + '/.cursor-plugin/plugin.json').version")
if command -v jq >/dev/null; then
  CLAUDE_SESSION_ID="<OMC session id from session start>" bash "$OMC_PLUGIN_ROOT/scripts/setup-progress.sh" complete "$VERSION"
else
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.setupCompleted=new Date().toISOString();c.setupVersion=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$HOME/.cursor/omc/.omc-config.json" "$VERSION"
  rm -f .omc/state/setup-state.json
fi
```

Then show the welcome message:

```
oh-my-cursor is ready.

Start with:
  /autopilot "<idea>"     idea → spec → plan → code → QA → validation
  /ralph "<task>"         keep going until the task is verified done
  /team 3:executor "..."  staged plan/exec/verify/fix with parallel subagents
  /plan, /ralplan         planning (ralplan = planner + architect + critic consensus)
  /deep-interview         clarify a vague idea before building
  /cancel                 stop any active OMC mode
  /omc-doctor             diagnose the install

Magic words in a prompt also work: "ralph", "autopilot", "ralplan", "deep interview", "tdd", "ultrathink".
Agents: omc-executor, omc-planner, omc-architect, omc-critic, omc-verifier, … (all inherit the chat model).
Parallel work: several subagents at once, or /multitask in the Agents Window.
```

## Keeping up to date

After pulling a new plugin version (`git -C "$OMC_PLUGIN_ROOT" pull`) run **Developer: Reload Window**, then `/omc-setup` and choose **Refresh runtime**.
