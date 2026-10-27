/**
 * End-to-end tests for cursor/hook.mjs.
 *
 * The adapter is spawned exactly as Cursor would spawn it (stdin JSON in,
 * stdout JSON out), but routed to fixture scripts that emit Claude Code-style
 * hook answers, so no upstream runtime code runs in the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'hook.mjs');
const FIXTURES = join(HERE, 'fixtures', 'scripts');

function runHook(event, payload, extraEnv = {}) {
  const workspace = extraEnv.workspace || mkdtempSync(join(tmpdir(), 'omc-cursor-ws-'));
  const log = join(workspace, 'fixture-log.jsonl');
  const baseEnv = { ...process.env };
  delete baseEnv.DISABLE_OMC;
  const env = {
    ...baseEnv,
    OMC_CURSOR_DIRECT: '1',
    OMC_CURSOR_SCRIPTS_DIR: FIXTURES,
    OMC_CURSOR_CONFIG_DIR: join(workspace, 'config'),
    CURSOR_PLUGIN_ROOT: join(HERE, '..', '..'),
    FIXTURE_LOG: log,
    ...extraEnv,
  };
  const input = { conversation_id: 'conv-1', workspace_roots: [workspace], hook_event_name: event, ...payload };
  const res = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env, encoding: 'utf-8' });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  const calls = existsSync(log)
    ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { output: JSON.parse(res.stdout.trim()), calls, workspace };
}

test('sessionStart merges runtime context with the Cursor bridge note', () => {
  const { output, calls } = runHook('sessionStart', { session_id: 's-1', composer_mode: 'agent' });
  assert.match(output.additional_context, /oh-my-cursor\] OMC orchestration is active/);
  assert.match(output.additional_context, /session ctx/);
  assert.equal(output.env.OMC_HOST, 'cursor');
  const first = calls.find((call) => call.script === 'session-start.mjs');
  assert.equal(first.input.hook_event_name, 'SessionStart');
  assert.equal(first.input.session_id, 'conv-1');
  assert.equal(first.env.OMC_HOST, 'cursor');
  assert.equal(first.env.ALLOW_ULTRAGOAL_WITHOUT_GOAL, '1');
  assert.match(first.env.CLAUDE_CONFIG_DIR, /config$/);
});

test('beforeSubmitPrompt never blocks and defers keyword context to the next tool result', () => {
  const first = runHook('beforeSubmitPrompt', { prompt: 'ralph fix the build' });
  assert.deepEqual(first.output, { continue: true });
  const kw = first.calls.find((call) => call.script === 'keyword-detector.mjs');
  assert.equal(kw.input.hook_event_name, 'UserPromptSubmit');
  assert.equal(kw.input.prompt, 'ralph fix the build');

  const after = runHook('postToolUse', { tool_name: 'Read', tool_input: { path: 'a.ts' }, tool_output: 'x' }, { workspace: first.workspace });
  assert.match(after.output.additional_context, /\[MAGIC KEYWORD: RALPH\]/);
  assert.match(after.output.additional_context, /Preferred invocation: \/ralph/);
  assert.match(after.output.additional_context, /subagent_type="omc-executor"/);
  assert.doesNotMatch(after.output.additional_context, /oh-my-claudecode/);
  assert.match(after.output.additional_context, /verified Read/);

  const again = runHook('postToolUse', { tool_name: 'Read', tool_input: { path: 'a.ts' }, tool_output: 'x' }, { workspace: first.workspace });
  assert.doesNotMatch(again.output.additional_context, /MAGIC KEYWORD/, 'pending context is delivered once');
});

test('a missed activation is replayed by stop exactly once', () => {
  const first = runHook('beforeSubmitPrompt', { prompt: 'ralph do it' });
  const stop = runHook('stop', { status: 'completed', loop_count: 0 }, { workspace: first.workspace });
  assert.match(stop.output.followup_message, /MAGIC KEYWORD: RALPH/);
  const stopAgain = runHook('stop', { status: 'completed', loop_count: 0 }, { workspace: first.workspace });
  assert.equal(stopAgain.output.followup_message, undefined);
});

test('beforeSubmitPrompt continue:false becomes a Cursor block with message', () => {
  const { output } = runHook('beforeSubmitPrompt', { prompt: 'halt now' });
  assert.equal(output.continue, false);
  assert.equal(output.user_message, 'halted by omc');
});

test('preToolUse maps Shell to Bash and permissionDecision deny to permission deny', () => {
  const { output, calls } = runHook('preToolUse', { tool_name: 'Shell', tool_input: { command: 'rm -rf /', working_directory: '/' } });
  assert.equal(output.permission, 'deny');
  assert.equal(output.agent_message, 'dangerous');
  const enforcer = calls.find((call) => call.script === 'pre-tool-enforcer.mjs');
  assert.equal(enforcer.input.tool_name, 'Bash');
  assert.ok(calls.some((call) => call.script === 'git-guardrails.mjs'), 'Bash-only route runs for Shell');
});

test('preToolUse on Task maps updatedInput back to Cursor keys and defers context', () => {
  const pre = runHook('preToolUse', { tool_name: 'Task', tool_input: { subagent_type: 'omc-executor', task: 'build it' } });
  assert.equal(pre.output.permission, 'allow');
  assert.equal(pre.output.updated_input.task, 'wrapped: build it');
  assert.equal(pre.output.updated_input.subagent_type, 'omc-executor');
  assert.ok(!pre.calls.some((call) => call.script === 'git-guardrails.mjs'), 'Bash-only route skipped for Task');
  const post = runHook('postToolUse', { tool_name: 'Task', tool_input: {}, tool_output: '{"result":"ok"}' }, { workspace: pre.workspace });
  assert.match(post.output.additional_context, /delegation note/);
  const verifier = post.calls.find((call) => call.script === 'post-tool-verifier.mjs');
  assert.deepEqual(verifier.input.tool_response, { result: 'ok' });
});

test('Write with old_string is routed as Edit and gets file_path', () => {
  const { calls } = runHook('postToolUse', { tool_name: 'Write', tool_input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, tool_output: 'done' });
  const injector = calls.find((call) => call.script === 'post-tool-rules-injector.mjs');
  assert.ok(injector, 'rules injector runs for Edit');
  assert.equal(injector.input.tool_name, 'Edit');
  assert.equal(injector.input.tool_input.file_path, 'src/a.ts');
});

test('MCP tools are exposed to scripts as mcp__omc__<tool>', () => {
  const { calls } = runHook('preToolUse', { tool_name: 'MCP:state_write', tool_input: { mode: 'ralph' } });
  assert.equal(calls[0].input.tool_name, 'mcp__omc__state_write');
});

test('postToolUseFailure carries the error to the script and back as context', () => {
  const { output } = runHook('postToolUseFailure', { tool_name: 'Shell', tool_input: { command: 'npm test' }, error_message: 'exit 1' });
  assert.match(output.additional_context, /failure: exit 1/);
});

test('stop: persistent-mode block becomes followup_message; user abort is respected', () => {
  const blocked = runHook('stop', { status: 'completed', loop_count: 0 }, { FIXTURE_RALPH: '1' });
  assert.match(blocked.output.followup_message, /The boulder never stops/);
  assert.match(blocked.output.followup_message, /\/ralph/);
  const pm = blocked.calls.find((call) => call.script === 'persistent-mode.mjs');
  assert.equal(pm.input.stop_reason, 'end_turn');
  assert.equal(pm.input.stop_hook_active, false);

  const aborted = runHook('stop', { status: 'aborted', loop_count: 0 }, { FIXTURE_RALPH: '1' });
  assert.equal(aborted.output.followup_message, undefined);
  const pmAborted = aborted.calls.find((call) => call.script === 'persistent-mode.mjs');
  assert.equal(pmAborted.input.user_requested, true);
});

test('subagentStop block becomes followup_message', () => {
  const { output, calls } = runHook('subagentStop', { subagent_type: 'omc-executor', status: 'completed', summary: 'done', loop_count: 0 });
  assert.equal(output.followup_message, 'deliverables missing');
  const tracker = calls.find((call) => call.script === 'subagent-tracker.mjs');
  assert.deepEqual(tracker.argv, ['stop']);
  assert.equal(tracker.input.last_assistant_message, 'done');
});

test('preCompact systemMessage becomes user_message', () => {
  const { output } = runHook('preCompact', { trigger: 'auto', context_usage_percent: 91 });
  assert.equal(output.user_message, 'wiki saved');
});

test('DISABLE_OMC short-circuits every event', () => {
  const prompt = runHook('beforeSubmitPrompt', { prompt: 'ralph' }, { DISABLE_OMC: '1' });
  assert.deepEqual(prompt.output, { continue: true });
  assert.equal(prompt.calls.length, 0);
  const pre = runHook('preToolUse', { tool_name: 'Shell', tool_input: { command: 'ls' } }, { DISABLE_OMC: '1' });
  assert.deepEqual(pre.output, {});
});

test('malformed stdin fails open', () => {
  const res = spawnSync(process.execPath, [HOOK, 'beforeSubmitPrompt'], {
    input: '{not json',
    env: { ...process.env, OMC_CURSOR_DIRECT: '1', OMC_CURSOR_SCRIPTS_DIR: FIXTURES },
    encoding: 'utf-8',
  });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).continue, true);
});
