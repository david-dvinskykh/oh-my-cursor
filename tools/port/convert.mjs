#!/usr/bin/env node
/**
 * Port oh-my-claudecode agents and skills to native Cursor plugin components.
 *
 *   node tools/port/convert.mjs <path-to-oh-my-claudecode-checkout>
 *
 * Writes agents/omc-*.md and skills/<name>/ into the plugin root. Files under
 * cursor/overrides/ are hand-ported (team, omc-setup, hud, ...) and are copied
 * over the mechanical output last, so re-running after an upstream update keeps
 * them. Re-run, then review `git diff` and update overrides where upstream
 * changed the hand-ported skills.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_NAMES } from '../../cursor/lib/translate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OVERRIDES = join(ROOT, 'cursor', 'overrides');

// Upstream commands that only dispatch to a same-named skill are dropped:
// in Cursor every skill is already a slash entry, so they would duplicate it.
const KEPT_COMMANDS = new Set(['psm', 'compact']);

const AGENT_ALT = AGENT_NAMES.join('|');

// Upstream skills whose frontmatter name differs from their folder (to avoid
// clashing with host built-ins such as Plan mode). Slash invocations must use
// the frontmatter name.
export const SKILL_ALIASES = { plan: 'omc-plan', review: 'omc-review' };

/** Rewrite `/plan` and `/review` skill invocations to their real names. */
export function finalizeText(text) {
  return text.replace(/(^|[\s`(\[])\/(plan|review)(?=[\s`.,;:)*\]]|$)/gm, (m, pre, name) => `${pre}/${SKILL_ALIASES[name]}`);
}

/** Ordered text rewrites applied to every ported markdown file. */
export const RULES = [
  // Plugin root and install locations.
  [/\$\{OMC_SETUP_PLUGIN_ROOT:-\$\{CLAUDE_PLUGIN_ROOT\}\}/g, '${OMC_PLUGIN_ROOT}'],
  [/`CLAUDE_PLUGIN_ROOT`\/`OMC_PLUGIN_ROOT`/g, '`OMC_PLUGIN_ROOT` (printed at session start)'],
  [/\$\{CLAUDE_PLUGIN_ROOT\}/g, '${OMC_PLUGIN_ROOT}'],
  [/\$CLAUDE_PLUGIN_ROOT\b/g, '$OMC_PLUGIN_ROOT'],
  [/\bCLAUDE_PLUGIN_ROOT\b/g, 'OMC_PLUGIN_ROOT'],
  [/active OMC plugin\/install/g, 'oh-my-cursor plugin'],
  [/installed OMC plugin directory/g, 'installed oh-my-cursor plugin directory'],

  // Skill invocation: Cursor has no Skill tool; skills are /<name> entries.
  [/`?Skill\(\s*(?:skill\s*=\s*)?"(?:oh-my-claudecode:)?([a-z0-9-]+)"\s*\)`?/g, '`/$1`'],
  [/\bcall the Skill tool with [`"]?([a-z0-9-]+)[`"]?/g, 'open the `$1` skill (`/$1`)'],
  [/\bUse the Skill tool to invoke: `([a-z0-9-]+)`/g, 'Invoke the `$1` skill (`/$1`)'],
  [/\bvia the Skill tool\b/g, 'as a skill (`/<name>`)'],
  [/\bthe Skill tool\b/g, 'skill invocation (`/<name>`)'],
  [/\bSkill tool\b/g, 'skill invocation'],
  [/`Skill\(\)`/g, '`/<skill>`'],
  [/\bSkill\(\)/g, '`/<skill>`'],

  // Agent and skill namespaces.
  [/mcp__plugin_oh-my-claudecode_t__([a-z_]+)/g, '$1'],
  [/\/oh-my-claudecode:([a-z0-9-]+)/g, '/$1'],
  [new RegExp(`oh-my-claudecode:(${AGENT_ALT})\\b`, 'g'), 'omc-$1'],
  [/oh-my-claudecode:([a-z0-9-]+)/g, '/$1'],
  [new RegExp(`subagent_type="(${AGENT_ALT})"`, 'g'), 'subagent_type="omc-$1"'],
  [new RegExp(`(^|[^/\\w-])\`(${AGENT_ALT})\`(?! skill)`, 'g'), '$1`omc-$2`'],

  // Model tiers: every Cursor agent uses `model: inherit`.
  [/,\s*model\s*=\s*"(?:haiku|sonnet|opus|fable)"/g, ''],
  [/\s*\(model\s*=\s*(?:haiku|sonnet|opus|fable)\)/g, ''],
  [/\bAgent\(model=(?:haiku|sonnet|opus|fable)\)/g, 'subagent'],
  [/\s*\(use `model=(?:haiku|sonnet|opus)` for [^)]*\)/g, ''],
  [/ with model="(?:haiku|sonnet|opus)"/g, ''],
  [/ with model=(?:haiku|sonnet|opus)\b/g, ''],
  [/\(haiku tier\)/g, '(quick)'],
  [/\(sonnet tier\)/g, '(standard)'],
  [/\(opus tier\)/g, '(thorough)'],
  [/spawn a Claude Task agent:/g, 'launch a Cursor subagent with the Task tool:'],

  // Shell tool: Cursor calls it Shell.
  [/\bUse Bash\b/g, 'Use the shell'],
  [/\bvia Bash\b/g, 'via the shell'],
  [/\bBash heredocs\b/g, 'shell heredocs'],
  [/\bnever use Bash\b/gi, 'never use the shell'],
  [/\bBash tool\b/g, 'Shell tool'],
  [/\bBash\b(?!\()/g, 'Shell'],

  // Tools.
  [/\bAskUserQuestion\b/g, 'AskQuestion'],
  [/\bTodoWrite or the active task-list surface\b/g, 'the to-do list'],
  [/\btask-list\/TodoWrite\b/g, 'to-do list'],
  [/\bTodoWrite items\b/g, 'to-do items'],
  [/\ba TodoWrite\b/g, 'a to-do list'],
  [/\busing TodoWrite\b/g, 'using the to-do list'],
  [/\bin TodoWrite\b/g, 'in the to-do list'],
  [/\bTodoWrite\b/g, 'the to-do list'],
  [/`run_in_background: true`/g, 'background execution (a background subagent, or a background shell for long commands)'],
  [/\brun_in_background\b/g, 'background execution'],
  [/Runtime effort inherits from the parent Claude Code session; no bundled agent frontmatter pins an effort override\./g,
    'Runtime model and effort inherit from the parent Cursor chat (`model: inherit`).'],
  [/Write and Edit tools are blocked/g, 'file edits are blocked (Cursor `readonly: true`)'],
  [/\(Write and Edit tools are blocked for this agent\)/g, '(this subagent is read-only)'],

  // Config locations: Cursor equivalents; OMC's own config moves to ~/.cursor/omc.
  [/~\/\.claude\/CLAUDE\.md/g, 'your Cursor user rules'],
  [/~\/\.claude\/skills/g, '~/.cursor/skills'],
  [/~\/\.claude\/agents/g, '~/.cursor/agents'],
  [/~\/\.claude\/rules/g, '~/.cursor/rules'],
  [/~\/\.claude\/commands/g, '~/.cursor/commands'],
  // OMC's own settings stay where the runtime reads them: <config>/settings.json
  // (config dir is ~/.cursor/omc under Cursor) and the project files
  // .claude/settings.json and .claude/omc.jsonc.
  [/~\/\.claude\//g, '~/.cursor/omc/'],
  [/~\/\.claude\b/g, '~/.cursor/omc'],
  [/(^|[\s`(.])\.claude\/skills/g, '$1.cursor/skills'],
  [/(^|[\s`(.])\.claude\/agents/g, '$1.cursor/agents'],
  [/(^|[\s`(.])\.claude\/rules/g, '$1.cursor/rules'],
  [/(^|[\s`(.])\.claude\/commands/g, '$1.cursor/commands'],
  [/\bCLAUDE\.md\b/g, 'AGENTS.md'],
  [/AGENTS\.md\/AGENTS\.md/g, 'AGENTS.md'],
  [/AGENTS\.md(,| or| and) AGENTS\.md/g, 'AGENTS.md'],

  // Claude-agent wording.
  [/\bClaude built-in team mode\b/g, 'parallel Cursor subagents (`/multitask`)'],
  [/\bdocument-specialist Claude agents\b/g, '`omc-document-specialist` subagents'],
  [/\b(?:are|use) Claude agents \(default\)/g, (m) => m.replace('Claude agents', 'Cursor subagents')],
  [/\bthe Claude `(omc-[a-z-]+)` agent\b/g, 'the `$1` subagent'],
  [/\b(?:the )?default Claude Architect\/Critic\b/g, 'the default `omc-architect`/`omc-critic`'],
  [/\b(?:the )?default Claude (Architect|Critic)( review)?\b/g, (m, role, review) => `the default \`omc-${role.toLowerCase()}\`${review || ''}`],
  [/\bthe Claude (Architect|Critic) pass\b/g, (m, role) => `the \`omc-${role.toLowerCase()}\` pass`],
  [/\bClaude-only execution\b/g, 'Cursor-subagent-only execution'],
  [/oh-my-claudecode:<name>/g, 'omc-<name>'],
  // Retired upstream entry point; OMC 5's canonical executor workflow is /execute.
  [/\/start-work\b/g, '/execute'],
  [/ \((?:Opus|Sonnet|Haiku)\)/g, ''],
  [/\((?:Opus|Sonnet|Haiku), ([^)]*)\)/g, '($1)'],
  [/`(omc-[a-z-]+)` agent \((?:haiku|sonnet|opus)\)/g, '`$1` agent'],

  // Host naming.
  [/\bClaude Code's\b/g, "Cursor's"],
  [/\bClaude Code session\b/g, 'Cursor chat'],
  [/\bClaude Code\b/g, 'Cursor'],
  [/\boh-my-claudecode\b(?![-:\w/])/g, 'oh-my-cursor'],
];

export function convertText(text) {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return finalizeText(out);
}

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: null, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: null, body: text };
  const rawMeta = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  let lastKey = null;
  for (const line of rawMeta.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) {
      lastKey = match[1];
      meta[lastKey] = match[2];
    } else if (lastKey && line.trim()) {
      meta[lastKey] += `\n${line}`;
    }
  }
  return { meta, body };
}

function yamlString(value) {
  const unquoted = String(value).trim().replace(/^(['"])(.*)\1$/s, '$2');
  return JSON.stringify(unquoted);
}

/** Port one agent: Cursor subagent frontmatter, omc- prefix, inherit model. */
export function convertAgent(name, text) {
  const { meta, body } = splitFrontmatter(text);
  const description = (meta?.description || name)
    .replace(/^(['"])(.*)\1$/s, '$2')
    .replace(/\s*\((?:Haiku|Sonnet|Opus|Fable)[^)]*\)\s*$/i, '')
    .trim();
  const disallowed = meta?.disallowedTools || '';
  const readonly = /\b(Write|Edit)\b/.test(disallowed);
  const lines = [
    '---',
    `name: omc-${name}`,
    `description: ${yamlString(convertText(description))}`,
    'model: inherit',
  ];
  if (readonly) lines.push('readonly: true');
  lines.push('---', '');
  return `${lines.join('\n')}${convertText(body)
    .replace(
      /\*\*Note to Orchestrators\*\*: Use the Worker Preamble Protocol \(`wrapWithPreamble\(\)` from `src\/agents\/preamble\.ts`\) to ensure this agent execut[^.]*\./g,
      '**Note to orchestrators**: when you launch this agent as a worker, say in its prompt that it must do the work directly and must not spawn further subagents.',
    )
    .replace(/escalate to explore-high which has lsp_find_references/g, 'use the `lsp_find_references` tool (omc MCP)')}`;
}

/** Port a skill's SKILL.md: keep name/description/argument-hint, convert body. */
export function convertSkill(text) {
  const { meta, body } = splitFrontmatter(text);
  if (!meta) return convertText(text);
  const lines = ['---', `name: ${meta.name}`, `description: ${yamlString(convertText(meta.description || meta.name))}`];
  if (meta['argument-hint']) lines.push(`argument-hint: ${yamlString(meta['argument-hint'])}`);
  if (meta['disable-model-invocation']) lines.push(`disable-model-invocation: ${meta['disable-model-invocation']}`);
  lines.push('---', '');
  return `${lines.join('\n')}${convertText(body)}`;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function port(upstream) {
  const report = { agents: 0, skills: 0, files: 0, commands: 0, overrides: 0 };

  rmSync(join(ROOT, 'agents'), { recursive: true, force: true });
  for (const file of readdirSync(join(upstream, 'agents'))) {
    if (!file.endsWith('.md') || file === 'AGENTS.md') continue;
    const name = file.replace(/\.md$/, '');
    writeFile(join(ROOT, 'agents', `omc-${name}.md`), convertAgent(name, readFileSync(join(upstream, 'agents', file), 'utf-8')));
    report.agents += 1;
  }

  rmSync(join(ROOT, 'skills'), { recursive: true, force: true });
  for (const file of walk(join(upstream, 'skills'))) {
    const rel = relative(join(upstream, 'skills'), file);
    const target = join(ROOT, 'skills', rel);
    if (rel === 'AGENTS.md') continue;
    if (rel.endsWith('/SKILL.md')) {
      writeFile(target, convertSkill(readFileSync(file, 'utf-8')));
      report.skills += 1;
    } else if (rel.endsWith('.md')) {
      writeFile(target, convertText(readFileSync(file, 'utf-8')));
      report.files += 1;
    } else {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
      report.files += 1;
    }
  }

  rmSync(join(ROOT, 'commands'), { recursive: true, force: true });
  for (const file of readdirSync(join(upstream, 'commands'))) {
    const name = file.replace(/\.md$/, '');
    if (!KEPT_COMMANDS.has(name)) continue;
    writeFile(join(ROOT, 'commands', file), convertText(readFileSync(join(upstream, 'commands', file), 'utf-8')));
    report.commands += 1;
  }

  const omitFile = join(OVERRIDES, 'OMIT');
  if (existsSync(omitFile)) {
    for (const line of readFileSync(omitFile, 'utf-8').split('\n')) {
      const rel = line.replace(/#.*$/, '').trim();
      if (!rel || rel.includes('..')) continue;
      rmSync(join(ROOT, rel), { recursive: true, force: true });
      report.omitted = (report.omitted || 0) + 1;
    }
  }

  if (existsSync(OVERRIDES)) {
    for (const file of walk(OVERRIDES)) {
      const rel = relative(OVERRIDES, file);
      if (rel === 'OMIT') continue;
      const target = join(ROOT, rel);
      mkdirSync(dirname(target), { recursive: true });
      if (file.endsWith('.md')) writeFileSync(target, finalizeText(readFileSync(file, 'utf-8')));
      else cpSync(file, target);
      report.overrides += 1;
    }
  }
  return report;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const upstream = process.argv[2];
  if (!upstream || !existsSync(join(upstream, 'skills'))) {
    process.stderr.write('usage: node tools/port/convert.mjs <oh-my-claudecode checkout>\n');
    process.exit(1);
  }
  const report = port(resolve(upstream));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
