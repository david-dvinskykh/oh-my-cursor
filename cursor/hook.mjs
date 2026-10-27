#!/usr/bin/env node
/**
 * oh-my-cursor hook entry point.
 *
 * Cursor runs this for every native hook event declared in hooks/hooks.json:
 *
 *   node "${CURSOR_PLUGIN_ROOT}/cursor/hook.mjs" <cursorEvent>
 *
 * It translates the Cursor payload into the Claude Code shape the OMC runtime
 * scripts understand, runs the scripts routed to that event, and translates
 * their answers back into Cursor's response format. It always fails open:
 * an error here prints an empty response and exits 0, so a broken hook never
 * blocks the agent.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routesFor } from './lib/routes.mjs';
import {
  toClaudeInput,
  toCursorOutput,
  parseClaudeOutput,
  cursorizeResponse,
  isActivationContext,
} from './lib/translate.mjs';
import { queueContext, takeContext } from './lib/pending.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.CURSOR_PLUGIN_ROOT || join(HERE, '..'));
const SCRIPTS_DIR = process.env.OMC_CURSOR_SCRIPTS_DIR || join(ROOT, 'scripts');

function readStdin(timeoutMs = 1000) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    };
    const timer = setTimeout(() => {
      process.stdin.destroy();
      finish();
    }, timeoutMs);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    if (process.stdin.readableEnded) finish();
  });
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** OMC config lives under ~/.cursor/omc so a Claude Code install is never touched. */
export function configDir(env = process.env) {
  return expandHome(env.OMC_CURSOR_CONFIG_DIR || join(homedir(), '.cursor', 'omc'));
}

function isTruthy(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function scriptEnv(cwd) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PROJECT_DIR: cwd,
    CLAUDE_CONFIG_DIR: configDir(),
    OMC_HOST: 'cursor',
    OMC_PLUGIN_ROOT: ROOT,
    // Cursor has no Claude Code `/goal`, so the ultragoal "/goal required" tool
    // guard could never be satisfied and would block every tool. The ledger and
    // stop-hook persistence still apply. Users can force the guard back with
    // ALLOW_ULTRAGOAL_WITHOUT_GOAL=0.
    ALLOW_ULTRAGOAL_WITHOUT_GOAL: process.env.ALLOW_ULTRAGOAL_WITHOUT_GOAL ?? '1',
  };
}

function scriptCommand(route) {
  const target = join(SCRIPTS_DIR, route.script);
  const args = route.args || [];
  if (isTruthy(process.env.OMC_CURSOR_DIRECT)) return [target, ...args];
  return [join(ROOT, 'scripts', 'run.cjs'), target, ...args];
}

function runScript(route, payload, cwd) {
  const argv = scriptCommand(route);
  const input = JSON.stringify(payload);

  if (route.async) {
    try {
      const child = spawn(process.execPath, argv, {
        cwd,
        env: scriptEnv(cwd),
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.unref();
    } catch {
      // ignore
    }
    return Promise.resolve({ result: null, exitCode: 0, stderr: '' });
  }

  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ result: parseClaudeOutput(stdout), exitCode, stderr });
    };
    try {
      child = spawn(process.execPath, argv, { cwd, env: scriptEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolvePromise({ result: null, exitCode: 1, stderr: '' });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(124);
    }, route.timeout || 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 0));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function bridgeContext(sessionId) {
  const cli = join(ROOT, 'bridge', 'cli.cjs');
  const lines = [
    '[oh-my-cursor] OMC orchestration is active in this Cursor session.',
    `Plugin root (skills call it $OMC_PLUGIN_ROOT): ${ROOT}`,
    `OMC session id (pass as session_id to state_* tools): ${sessionId || 'unknown'}`,
    `OMC CLI: \`omc\` if the shim from /omc-setup is on PATH, otherwise \`node "${cli}"\`.`,
    'OMC state lives in `.omc/` at the workspace root; the `omc` MCP server exposes state_*, notepad_*, project_memory_*, lsp_*, ast_grep_* and wiki_* tools.',
  ];
  if (!existsSync(join(ROOT, 'node_modules', 'commander'))) {
    lines.push('Runtime dependencies are not installed yet: run the `omc-setup` skill (it runs `npm install --omit=dev --ignore-scripts` in the plugin root).');
  }
  return lines.join('\n');
}

export async function handle(event, cursorInput, env = process.env) {
  if (isTruthy(env.DISABLE_OMC)) {
    return event === 'beforeSubmitPrompt' ? { continue: true } : {};
  }

  const payload = toClaudeInput(event, cursorInput, env);
  const cwd = payload.cwd;
  const conversation = payload.session_id;
  const routes = routesFor(event, payload.tool_name);

  const results = [];
  for (const route of routes) {
    const runPayload = route.permissionRequest
      ? { ...payload, hook_event_name: 'PermissionRequest' }
      : payload;
    // eslint-disable-next-line no-await-in-loop
    results.push(await runScript(route, runPayload, cwd));
  }

  const { response, pendingContext } = toCursorOutput(event, results, cursorInput);

  switch (event) {
    case 'sessionStart': {
      const merged = [bridgeContext(conversation), response.additional_context].filter(Boolean).join('\n\n');
      response.additional_context = merged;
      if (!response.env) response.env = {};
      response.env.OMC_HOST = 'cursor';
      response.env.OMC_PLUGIN_ROOT = ROOT;
      break;
    }
    case 'beforeSubmitPrompt':
    case 'preToolUse':
      if (pendingContext) queueContext(cwd, conversation, pendingContext, { from: event });
      break;
    case 'postToolUse':
    case 'postToolUseFailure': {
      const pending = takeContext(cwd, conversation);
      if (pending) {
        response.additional_context = [pending, response.additional_context].filter(Boolean).join('\n\n');
      }
      break;
    }
    case 'stop': {
      const pending = takeContext(cwd, conversation);
      const firstPass = Number(cursorInput?.loop_count || 0) === 0;
      // Only a missed skill activation is worth an extra turn; ordinary
      // reminders that were never delivered are simply dropped.
      if (pending && firstPass && cursorInput?.status !== 'aborted' && isActivationContext(pending)) {
        const note = `[oh-my-cursor] Context from OMC hooks that was not delivered before you finished:\n\n${pending}\n\nAct on it if it changes your answer; otherwise reply "OK" and stop.`;
        response.followup_message = response.followup_message
          ? `${response.followup_message}\n\n${note}`
          : note;
      }
      break;
    }
    default:
      break;
  }

  return cursorizeResponse(response);
}

async function main() {
  const event = process.argv[2];
  let response = {};
  try {
    const raw = await readStdin();
    let cursorInput = {};
    try {
      cursorInput = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      cursorInput = {};
    }
    response = await handle(event, cursorInput);
  } catch (error) {
    if (isTruthy(process.env.OMC_CURSOR_DEBUG)) {
      process.stderr.write(`[oh-my-cursor] hook ${event} failed: ${error?.stack || error}\n`);
    }
    response = event === 'beforeSubmitPrompt' ? { continue: true } : {};
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(0);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
