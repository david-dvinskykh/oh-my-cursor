import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { install, uninstall, ROOT } from '../../tools/install-user.mjs';

function setup() {
  const cursorDir = mkdtempSync(join(tmpdir(), 'omc-user-'));
  writeFileSync(join(cursorDir, 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: { stop: [{ type: 'command', command: 'echo mine' }], afterFileEdit: [{ command: 'prettier' }] },
  }));
  writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  mkdirSync(join(cursorDir, 'skills', 'tdd'), { recursive: true });
  writeFileSync(join(cursorDir, 'skills', 'tdd', 'SKILL.md'), 'my own tdd skill');
  return cursorDir;
}

const opts = (cursorDir, extra = {}) => ({ cursorDir, projects: [], force: false, dryRun: false, uninstall: false, deps: false, keepUserMcp: false, ...extra });

test('install merges hooks and MCP without touching user entries, and is idempotent', () => {
  const cursorDir = setup();
  const first = install(opts(cursorDir));
  install(opts(cursorDir));

  const hooks = JSON.parse(readFileSync(join(cursorDir, 'hooks.json'), 'utf-8'));
  assert.equal(hooks.version, 1);
  assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: 'prettier' }]);
  assert.equal(hooks.hooks.stop.length, 2, 'user stop hook kept, ours added once');
  assert.equal(hooks.hooks.stop[0].command, 'echo mine');
  assert.equal(hooks.hooks.stop[1].command, `node "${join(ROOT, 'cursor', 'hook.mjs')}" stop`);
  assert.equal(hooks.hooks.stop[1].loop_limit, 100);
  assert.ok(hooks.hooks.sessionStart && hooks.hooks.preToolUse && hooks.hooks.beforeSubmitPrompt);

  const mcp = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
  assert.deepEqual(mcp.mcpServers.github, { command: 'gh-mcp' });
  assert.equal(mcp.mcpServers.omc.args[0], join(ROOT, 'cursor', 'mcp-launch.cjs'));

  assert.ok(existsSync(join(cursorDir, 'rules', 'omc.mdc')));
  assert.ok(existsSync(join(cursorDir, 'agents', 'omc-executor.md')));
  assert.ok(existsSync(join(cursorDir, 'skills', 'team', 'SKILL.md')));
  assert.equal(readFileSync(join(cursorDir, 'skills', 'tdd', 'SKILL.md'), 'utf-8'), 'my own tdd skill', 'existing user skill not overwritten');
  assert.ok(first.skipped.some((p) => p.endsWith(join('skills', 'tdd'))));
  assert.ok(readdirSync(cursorDir).some((f) => f.startsWith('hooks.json.bak-')), 'hooks.json backed up');
});

test('uninstall removes only what was installed', () => {
  const cursorDir = setup();
  install(opts(cursorDir));
  uninstall(opts(cursorDir));
  const hooks = JSON.parse(readFileSync(join(cursorDir, 'hooks.json'), 'utf-8'));
  assert.deepEqual(hooks.hooks, { stop: [{ type: 'command', command: 'echo mine' }], afterFileEdit: [{ command: 'prettier' }] });
  const mcp = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
  assert.deepEqual(mcp.mcpServers, { github: { command: 'gh-mcp' } });
  assert.ok(!existsSync(join(cursorDir, 'skills', 'team')));
  assert.ok(existsSync(join(cursorDir, 'skills', 'tdd', 'SKILL.md')));
  assert.ok(!existsSync(join(cursorDir, 'rules', 'omc.mdc')));
});

test('dry run changes nothing', () => {
  const cursorDir = setup();
  const before = readFileSync(join(cursorDir, 'hooks.json'), 'utf-8');
  const result = install(opts(cursorDir, { dryRun: true }));
  assert.equal(readFileSync(join(cursorDir, 'hooks.json'), 'utf-8'), before);
  assert.ok(!existsSync(join(cursorDir, 'agents')));
  assert.ok(result.log.some((line) => line.startsWith('would')));
});

test('--project binds a project-level omc server to the repo and drops the user-level one', () => {
  const cursorDir = setup();
  const repo = mkdtempSync(join(tmpdir(), 'omc-repo-'));
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  install(opts(cursorDir));
  install(opts(cursorDir, { projects: [repo] }));

  const projectMcp = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf-8'));
  assert.equal(projectMcp.mcpServers.omc.env.OMC_WORKSPACE, repo);
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'omc.mdc')));
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
  assert.match(exclude, /^\.cursor\/mcp\.json$/m);
  assert.match(exclude, /^\.omc\/$/m);

  const userMcp = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
  assert.equal(userMcp.mcpServers.omc, undefined, 'user-level omc removed');
  assert.deepEqual(userMcp.mcpServers.github, { command: 'gh-mcp' });

  // A later plain run remembers the project and keeps the user-level server off.
  install(opts(cursorDir));
  assert.equal(JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8')).mcpServers.omc, undefined);
  assert.ok(existsSync(join(repo, '.cursor', 'rules', 'omc.mdc')));
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8').match(/oh-my-cursor/g).length, 1, 'excludes added once');

  uninstall(opts(cursorDir));
  assert.equal(JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf-8')).mcpServers.omc, undefined);
  assert.ok(!existsSync(join(repo, '.cursor', 'rules', 'omc.mdc')));
});
