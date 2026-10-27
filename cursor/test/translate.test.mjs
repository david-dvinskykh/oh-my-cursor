import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toClaudeToolName,
  toClaudeInput,
  toCursorOutput,
  cursorizeText,
  isActivationContext,
} from '../lib/translate.mjs';
import { routesFor } from '../lib/routes.mjs';

test('tool names map to the Claude names OMC matchers expect', () => {
  assert.equal(toClaudeToolName('Shell'), 'Bash');
  assert.equal(toClaudeToolName('Write', { contents: 'x' }), 'Write');
  assert.equal(toClaudeToolName('Write', { old_string: 'a' }), 'Edit');
  assert.equal(toClaudeToolName('MCP:notepad_read'), 'mcp__omc__notepad_read');
  assert.equal(toClaudeToolName('Task'), 'Task');
  assert.equal(toClaudeToolName('Grep'), 'Grep');
  assert.equal(toClaudeToolName('AskQuestion'), 'AskUserQuestion');
});

test('updated_input never adds keys Cursor did not send (e.g. a Claude model tier)', async () => {
  const { mapUpdatedInput } = await import('../lib/translate.mjs');
  const mapped = mapUpdatedInput(
    { tool_input: { subagent_type: 'omc-executor', prompt: 'p' } },
    { subagent_type: 'omc-executor', prompt: 'p2', model: 'sonnet' },
  );
  assert.deepEqual(mapped, { subagent_type: 'omc-executor', prompt: 'p2' });
});

test('exit code 2 blocks preToolUse with stderr as the reason', () => {
  const { response } = toCursorOutput('preToolUse', [{ result: null, exitCode: 2, stderr: 'no force push' }]);
  assert.equal(response.permission, 'deny');
  assert.equal(response.agent_message, 'no force push');
});

test('a hard stop (continue:false) suppresses a stop follow-up', () => {
  const { response } = toCursorOutput('stop', [
    { result: { continue: false, stopReason: 'context limit' }, exitCode: 0, stderr: '' },
    { result: { decision: 'block', reason: 'keep going' }, exitCode: 0, stderr: '' },
  ]);
  assert.equal(response.followup_message, undefined);
});

test('beforeShellExecution maps permission-handler behaviour', () => {
  const allow = toCursorOutput('beforeShellExecution', [
    { result: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }, exitCode: 0, stderr: '' },
  ]);
  assert.equal(allow.response.permission, 'allow');
  const none = toCursorOutput('beforeShellExecution', [{ result: { continue: true }, exitCode: 0, stderr: '' }]);
  assert.equal(none.response.permission, undefined, 'no opinion leaves Cursor approval untouched');
});

test('stop input never claims stop_hook_active (Cursor loop_count is cumulative)', () => {
  const input = toClaudeInput('stop', { conversation_id: 'c', workspace_roots: ['/w'], status: 'completed', loop_count: 3 });
  assert.equal(input.stop_hook_active, false);
  assert.equal(input.loop_count, 3);
  assert.equal(input.cwd, '/w');
  assert.equal(input.session_id, 'c');
});

test('cursorizeText rewrites invocations into Cursor forms', () => {
  const text = 'Run /oh-my-claudecode:ralph then Task(subagent_type="oh-my-claudecode:critic") and oh-my-claudecode:cancel via mcp__plugin_oh-my-claudecode_t__state_clear in Claude Code.';
  assert.equal(
    cursorizeText(text),
    'Run /ralph then Task(subagent_type="omc-critic") and /cancel via state_clear in Cursor.',
  );
  assert.equal(cursorizeText('Run /oh-my-claudecode:plan --consensus'), 'Run /omc-plan --consensus');
  assert.ok(isActivationContext('[MAGIC KEYWORDS DETECTED: RALPH, TDD]'));
  assert.ok(!isActivationContext('plain reminder'));
});

test('matchers are anchored', () => {
  assert.equal(routesFor('postToolUse', 'Read').length, 4);
  assert.equal(routesFor('postToolUse', 'ReadMore').length, 2);
  assert.equal(routesFor('preToolUse', 'Bash').length, 2);
});
