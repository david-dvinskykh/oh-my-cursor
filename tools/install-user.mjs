#!/usr/bin/env node
/**
 * Install oh-my-cursor as plain user-level Cursor configuration, without the
 * plugin system (for accounts where "Allow Local Plugin Imports" is off).
 *
 *   node tools/install-user.mjs              install / update
 *   node tools/install-user.mjs --dry-run    show what would change
 *   node tools/install-user.mjs --uninstall  remove everything this script installed
 *
 * Options:
 *   --cursor-dir <dir>   Cursor user config dir (default ~/.cursor)
 *   --project <dir>      set up a repository (repeatable): rule in <dir>/.cursor/rules and a
 *                        project-level "omc" MCP server bound to <dir>, so OMC state tools
 *                        work on that repo; both paths go to <dir>/.git/info/exclude.
 *                        Once any project is set up, the user-level "omc" server is removed
 *                        (it would duplicate the tools and point at ~/.omc). Projects are
 *                        remembered, so later runs without --project keep them.
 *   --keep-user-mcp      keep the user-level "omc" server even when projects are set up
 *   --force              overwrite skills/agents/commands that exist but were not installed by this script
 *   --deps               install runtime dependencies in the checkout (`npm ci --omit=dev --ignore-scripts`)
 *
 * What it writes (paths point at this checkout, so keep it where it is):
 *   <cursor-dir>/rules/omc.mdc, agents/omc-*.md, skills/<name>/, commands/*.md
 *   <cursor-dir>/hooks.json  — merged: one oh-my-cursor entry per event
 *   <cursor-dir>/mcp.json    — merged: the "omc" server
 * Existing hooks.json / mcp.json are backed up before they are changed. A
 * manifest in <cursor-dir>/omc/install-manifest.json records what was installed.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
const MARKER = 'oh-my-cursor';

function parseArgs(argv) {
  const opts = { cursorDir: join(homedir(), '.cursor'), projects: [], force: false, dryRun: false, uninstall: false, deps: false, keepUserMcp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cursor-dir') opts.cursorDir = resolve(argv[++i]);
    else if (arg === '--project') opts.projects.push(resolve(argv[++i]));
    else if (arg === '--keep-user-mcp') opts.keepUserMcp = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--deps') opts.deps = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf-8');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error.message}); fix or move it, then re-run.`);
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJsonWithBackup(path, data, log, dryRun) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf-8') === next) return;
  if (dryRun) {
    log.push(`would update ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const backup = `${path}.bak-${stamp()}`;
    cpSync(path, backup);
    log.push(`backup ${backup}`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
  log.push(`updated ${path}`);
}

function isOurHook(entry) {
  return typeof entry?.command === 'string' && entry.command.includes('cursor/hook.mjs') && entry.command.includes(MARKER);
}

/** Plugin hooks.json -> user hook entries with the absolute adapter path. */
export function userHookEntries(root = ROOT) {
  const plugin = readJson(join(root, 'hooks', 'hooks.json'), { hooks: {} });
  const adapter = join(root, 'cursor', 'hook.mjs');
  const out = {};
  for (const [event, entries] of Object.entries(plugin.hooks || {})) {
    out[event] = entries.map((entry) => ({
      ...entry,
      command: `node "${adapter}" ${event}`,
    }));
  }
  return out;
}

export function mergeHooks(existing, ours) {
  const merged = { ...(existing || {}) };
  merged.version = merged.version || 1;
  const hooks = { ...(merged.hooks || {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries || []).filter((entry) => !isOurHook(entry));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, entries] of Object.entries(ours || {})) {
    hooks[event] = [...(hooks[event] || []), ...entries];
  }
  merged.hooks = hooks;
  return merged;
}

export function omcServer(root = ROOT, workspace = '${workspaceFolder}') {
  return {
    command: 'node',
    args: [join(root, 'cursor', 'mcp-launch.cjs')],
    env: {
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_CONFIG_DIR: '~/.cursor/omc',
      OMC_HOST: 'cursor',
      OMC_WORKSPACE: workspace,
    },
  };
}

function isOurServer(server) {
  return Array.isArray(server?.args) && server.args.some((arg) => String(arg).includes(MARKER));
}

function gitTracked(repo, rel) {
  const res = spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', rel], { stdio: 'ignore' });
  return res.status === 0;
}

const EXCLUDE_LINES = ['.cursor/mcp.json', '.cursor/rules/omc.mdc', '.omc/'];

function addGitExcludes(repo, log, dryRun) {
  const gitDir = join(repo, '.git');
  if (!existsSync(join(gitDir, 'info')) && !existsSync(join(gitDir, 'HEAD'))) return;
  const file = join(gitDir, 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const have = new Set(current.split('\n').map((line) => line.trim()));
  const missing = EXCLUDE_LINES.filter((line) => !have.has(line));
  if (!missing.length) return;
  if (dryRun) {
    log.push(`would add ${missing.join(', ')} to ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${current}${prefix}# oh-my-cursor (local only)\n${missing.join('\n')}\n`);
  log.push(`excluded ${missing.join(', ')} in ${file}`);
}

/** Project-level MCP server bound to the repo; returns false when skipped. */
function installProjectMcp(repo, root, opts, log, skipped) {
  const mcpPath = join(repo, '.cursor', 'mcp.json');
  if (existsSync(mcpPath) && gitTracked(repo, '.cursor/mcp.json') && !opts.force) {
    skipped.push(`${mcpPath} (tracked by git; add the omc server by hand or use --force)`);
    return false;
  }
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = { ...(mcp.mcpServers || {}), omc: omcServer(root, repo) };
  writeJsonWithBackup(mcpPath, mcp, log, opts.dryRun);
  addGitExcludes(repo, log, opts.dryRun);
  return true;
}

function listEntries(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function copyItem(src, dest, manifestSet, opts, log, skipped) {
  const known = manifestSet.has(dest);
  if (existsSync(dest) && !known && !opts.force) {
    skipped.push(dest);
    return false;
  }
  if (opts.dryRun) {
    log.push(`would copy ${dest}`);
    return true;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return true;
}

export function install(opts, root = ROOT) {
  const log = [];
  const skipped = [];
  const cursorDir = opts.cursorDir;
  const manifestPath = join(cursorDir, 'omc', 'install-manifest.json');
  const previous = readJson(manifestPath, { files: [] });
  const manifestSet = new Set(previous.files || []);
  const installed = [];

  const items = [
    [join(root, 'rules', 'omc.mdc'), join(cursorDir, 'rules', 'omc.mdc')],
    ...listEntries(join(root, 'subagents')).map((f) => [join(root, 'subagents', f), join(cursorDir, 'agents', f)]),
    ...listEntries(join(root, 'skills')).map((f) => [join(root, 'skills', f), join(cursorDir, 'skills', f)]),
    ...listEntries(join(root, 'commands')).map((f) => [join(root, 'commands', f), join(cursorDir, 'commands', f)]),
  ];
  const projects = [...new Set([...(previous.projects || []), ...(opts.projects || [])])].filter((dir) => existsSync(dir));
  for (const repo of projects) items.push([join(root, 'rules', 'omc.mdc'), join(repo, '.cursor', 'rules', 'omc.mdc')]);

  for (const [src, dest] of items) {
    if (copyItem(src, dest, manifestSet, opts, log, skipped)) installed.push(dest);
  }
  // Items installed earlier but no longer shipped are removed.
  for (const old of manifestSet) {
    if (!installed.includes(old) && !skipped.includes(old) && existsSync(old)) {
      if (opts.dryRun) log.push(`would remove ${old}`);
      else rmSync(old, { recursive: true, force: true });
    }
  }

  const hooksPath = join(cursorDir, 'hooks.json');
  writeJsonWithBackup(hooksPath, mergeHooks(readJson(hooksPath, {}), userHookEntries(root)), log, opts.dryRun);

  for (const repo of projects) installProjectMcp(repo, root, opts, log, skipped);

  // The user-level server cannot see which workspace a window has open (Cursor
  // does not expand ${workspaceFolder} there), so its state tools fall back to
  // ~/.omc. With project servers in place it would only duplicate the tools.
  const useUserMcp = projects.length === 0 || opts.keepUserMcp;
  const mcpPath = join(cursorDir, 'mcp.json');
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = { ...(mcp.mcpServers || {}) };
  if (useUserMcp) mcp.mcpServers.omc = omcServer(root);
  else if (isOurServer(mcp.mcpServers.omc)) delete mcp.mcpServers.omc;
  if (useUserMcp || existsSync(mcpPath)) writeJsonWithBackup(mcpPath, mcp, log, opts.dryRun);

  if (!opts.dryRun) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ root, installedAt: new Date().toISOString(), files: installed, projects, userMcp: useUserMcp }, null, 2)}\n`);
  }

  if (opts.deps && !opts.dryRun) {
    const npm = (args) => spawnSync('npm', ['--prefix', root, ...args, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: process.platform === 'win32' });
    let res = existsSync(join(root, 'package-lock.json')) ? npm(['ci']) : { status: 1 };
    if (res.status !== 0) {
      // Mirrors (e.g. a corporate Nexus) may not carry the exact versions pinned
      // in the lockfile; resolve against what the configured registry has.
      log.push('npm ci failed or no lockfile: retrying with npm install --no-package-lock');
      res = npm(['install', '--no-package-lock']);
    }
    log.push(res.status === 0 ? 'runtime dependencies installed' : `npm install failed (exit ${res.status})`);
  }

  return { log, skipped, installed, projects };
}

export function uninstall(opts) {
  const log = [];
  const cursorDir = opts.cursorDir;
  const manifestPath = join(cursorDir, 'omc', 'install-manifest.json');
  const manifest = readJson(manifestPath, { files: [] });
  for (const file of manifest.files || []) {
    if (!existsSync(file)) continue;
    if (opts.dryRun) log.push(`would remove ${file}`);
    else rmSync(file, { recursive: true, force: true });
  }
  const hooksPath = join(cursorDir, 'hooks.json');
  if (existsSync(hooksPath)) writeJsonWithBackup(hooksPath, mergeHooks(readJson(hooksPath, {}), {}), log, opts.dryRun);
  for (const mcpPath of [join(cursorDir, 'mcp.json'), ...(manifest.projects || []).map((repo) => join(repo, '.cursor', 'mcp.json'))]) {
    if (!existsSync(mcpPath)) continue;
    const mcp = readJson(mcpPath, {});
    if (isOurServer(mcp.mcpServers?.omc)) {
      delete mcp.mcpServers.omc;
      writeJsonWithBackup(mcpPath, mcp, log, opts.dryRun);
    }
  }
  if (!opts.dryRun) rmSync(manifestPath, { force: true });
  return { log };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  if (!ROOT.includes(MARKER)) {
    process.stderr.write(`The checkout folder must be named "${MARKER}" (got ${ROOT}); hook entries are recognised by that name.\n`);
    process.exit(2);
  }
  try {
    const result = opts.uninstall ? uninstall(opts) : install(opts);
    for (const line of result.log) process.stdout.write(`${line}\n`);
    if (result.skipped?.length) {
      process.stdout.write(`\nSkipped ${result.skipped.length} existing item(s) not installed by oh-my-cursor (use --force to overwrite):\n`);
      for (const item of result.skipped) process.stdout.write(`  ${item}\n`);
    }
    if (!opts.uninstall && !opts.dryRun) {
      process.stdout.write(`\nInstalled ${result.installed.length} items from ${ROOT}.\nNext: reload Cursor (Developer: Reload Window), then run /omc-setup in a chat.\n`);
      if (!result.projects?.length) {
        process.stdout.write('Tip: add --project <repo> for each repository you use with OMC so its MCP state tools work on that repo (the user-level server falls back to ~/.omc).\n');
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
