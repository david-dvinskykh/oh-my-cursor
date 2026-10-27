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
 *   --project <dir>      also install the orchestration rule into <dir>/.cursor/rules
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
  const opts = { cursorDir: join(homedir(), '.cursor'), project: null, force: false, dryRun: false, uninstall: false, deps: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cursor-dir') opts.cursorDir = resolve(argv[++i]);
    else if (arg === '--project') opts.project = resolve(argv[++i]);
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

export function omcServer(root = ROOT) {
  return {
    command: 'node',
    args: [join(root, 'cursor', 'mcp-launch.cjs')],
    env: {
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_CONFIG_DIR: '~/.cursor/omc',
      OMC_HOST: 'cursor',
      OMC_WORKSPACE: '${workspaceFolder}',
    },
  };
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
  if (opts.project) items.push([join(root, 'rules', 'omc.mdc'), join(opts.project, '.cursor', 'rules', 'omc.mdc')]);

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

  const mcpPath = join(cursorDir, 'mcp.json');
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = { ...(mcp.mcpServers || {}), omc: omcServer(root) };
  writeJsonWithBackup(mcpPath, mcp, log, opts.dryRun);

  if (!opts.dryRun) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ root, installedAt: new Date().toISOString(), files: installed }, null, 2)}\n`);
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

  return { log, skipped, installed };
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
  const mcpPath = join(cursorDir, 'mcp.json');
  if (existsSync(mcpPath)) {
    const mcp = readJson(mcpPath, {});
    if (mcp.mcpServers?.omc?.args?.some((arg) => String(arg).includes(MARKER))) {
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
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
