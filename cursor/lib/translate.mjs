/**
 * Translation between Cursor's native hook protocol and the Claude Code hook
 * protocol that the OMC runtime scripts were written against.
 *
 * Input side:  Cursor JSON (camelCase events, conversation_id, workspace_roots,
 *              Shell/Write/MCP:<tool> names) -> Claude JSON (session_id, cwd,
 *              Bash/Edit/mcp__omc__<tool> names, tool_response, ...).
 * Output side: Claude JSON (hookSpecificOutput, decision:"block", continue,
 *              systemMessage, ...) -> Cursor JSON (permission, followup_message,
 *              additional_context, user_message, agent_message, ...).
 *
 * Pure functions only, so they can be unit-tested without spawning anything.
 */

import { CLAUDE_EVENT } from './routes.mjs';

const EDIT_KEYS = ['old_string', 'oldString', 'old_str', 'search', 'edits'];

/** Map a Cursor tool name (+ input) to the Claude Code tool name OMC expects. */
export function toClaudeToolName(cursorName, toolInput = {}) {
  if (!cursorName || typeof cursorName !== 'string') return cursorName;
  if (cursorName.startsWith('MCP:')) return `mcp__omc__${cursorName.slice(4)}`;
  switch (cursorName) {
    case 'Shell':
    case 'Terminal':
    case 'run_terminal_cmd':
      return 'Bash';
    case 'Write':
    case 'edit_file':
    case 'search_replace':
    case 'StrReplace': {
      const isEdit = toolInput && EDIT_KEYS.some((key) => key in toolInput);
      return isEdit ? 'Edit' : 'Write';
    }
    case 'read_file':
      return 'Read';
    case 'grep_search':
    case 'codebase_search':
      return 'Grep';
    case 'file_search':
    case 'list_dir':
      return 'Glob';
    case 'delete_file':
      return 'Delete';
    case 'todo_write':
    case 'TodoWrite':
      return 'TodoWrite';
    case 'web_search':
      return 'WebSearch';
    case 'AskQuestion':
    case 'ask_question':
      // OMC sends its "user input needed" notification on this tool.
      return 'AskUserQuestion';
    default:
      return cursorName;
  }
}

/** Add the Claude-style keys OMC reads, keeping every original key. */
export function normalizeToolInput(claudeToolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput ?? {};
  const out = { ...toolInput };
  const filePath = toolInput.file_path ?? toolInput.path ?? toolInput.target_file ?? toolInput.filePath;
  if (filePath && !out.file_path) out.file_path = filePath;
  if (claudeToolName === 'Write' && out.content === undefined) {
    const content = toolInput.contents ?? toolInput.code_edit ?? toolInput.text;
    if (content !== undefined) out.content = content;
  }
  if (claudeToolName === 'Edit') {
    if (out.old_string === undefined) out.old_string = toolInput.oldString ?? toolInput.old_str ?? toolInput.search;
    if (out.new_string === undefined) out.new_string = toolInput.newString ?? toolInput.new_str ?? toolInput.replace;
  }
  if (claudeToolName === 'Task') {
    if (out.prompt === undefined) out.prompt = toolInput.task ?? toolInput.instructions;
    if (out.subagent_type === undefined) out.subagent_type = toolInput.subagentType ?? toolInput.agent;
  }
  if (claudeToolName === 'Bash' && out.command === undefined && typeof toolInput.cmd === 'string') {
    out.command = toolInput.cmd;
  }
  return out;
}

function parseToolOutput(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { output: String(raw) };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Plain text output.
  }
  return { output: raw, stdout: raw };
}

function stopReasonFrom(status) {
  switch (status) {
    case 'aborted':
      return 'aborted';
    case 'error':
      return 'error';
    default:
      return 'end_turn';
  }
}

/**
 * Build the Claude Code hook payload for `event` from the Cursor payload.
 * `env` supplies CURSOR_PROJECT_DIR and similar fallbacks.
 */
export function toClaudeInput(event, cursor, env = {}) {
  const c = cursor && typeof cursor === 'object' ? cursor : {};
  const workspaceRoot = Array.isArray(c.workspace_roots) && c.workspace_roots.length > 0
    ? c.workspace_roots[0]
    : undefined;
  const cwd = c.cwd || workspaceRoot || env.CURSOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = c.conversation_id || c.session_id || c.parent_conversation_id || '';

  const base = {
    hook_event_name: CLAUDE_EVENT[event] || event,
    session_id: sessionId,
    cwd,
    transcript_path: c.transcript_path || env.CURSOR_TRANSCRIPT_PATH || undefined,
    permission_mode: 'default',
    // Kept so runtime code can tell it is hosted by Cursor.
    host: 'cursor',
    cursor_event: event,
    cursor_generation_id: c.generation_id,
    model: c.model,
  };

  switch (event) {
    case 'sessionStart':
      return { ...base, source: c.is_background_agent ? 'background' : 'startup', composer_mode: c.composer_mode };
    case 'beforeSubmitPrompt':
      return { ...base, prompt: c.prompt ?? '', attachments: c.attachments };
    case 'preToolUse':
    case 'postToolUse':
    case 'postToolUseFailure': {
      const toolName = toClaudeToolName(c.tool_name, c.tool_input);
      const payload = {
        ...base,
        tool_name: toolName,
        tool_input: normalizeToolInput(toolName, c.tool_input),
        tool_use_id: c.tool_use_id,
        cursor_tool_name: c.tool_name,
      };
      if (c.cwd) payload.cwd = c.cwd;
      if (event === 'postToolUse') {
        payload.tool_response = parseToolOutput(c.tool_output);
        payload.tool_output = c.tool_output;
      }
      if (event === 'postToolUseFailure') {
        payload.error = c.error_message;
        payload.is_interrupt = Boolean(c.is_interrupt);
        payload.failure_type = c.failure_type;
      }
      return payload;
    }
    case 'beforeShellExecution':
      return {
        ...base,
        tool_name: 'Bash',
        tool_input: { command: c.command ?? '' },
        cwd: c.cwd || cwd,
      };
    case 'subagentStart':
      return {
        ...base,
        agent_id: c.subagent_id,
        agent_type: c.subagent_type,
        prompt: c.task,
        subagent_model: c.subagent_model,
        is_parallel_worker: Boolean(c.is_parallel_worker),
      };
    case 'subagentStop':
      return {
        ...base,
        agent_id: c.subagent_id,
        agent_type: c.subagent_type,
        agent_transcript_path: c.agent_transcript_path,
        last_assistant_message: c.summary ?? c.description ?? '',
        status: c.status,
        modified_files: c.modified_files,
        // Cursor's loop_count counts every earlier automatic follow-up in the
        // conversation, so it cannot stand in for Claude's "already continued
        // once" flag: OMC scripts would stop continuing after one follow-up.
        // Loop bounds come from OMC's own iteration caps and hooks.json loop_limit.
        stop_hook_active: false,
      };
    case 'preCompact':
      return {
        ...base,
        trigger: c.trigger === 'manual' ? 'manual' : 'auto',
        custom_instructions: '',
        context_usage_percent: c.context_usage_percent,
      };
    case 'stop': {
      const aborted = c.status === 'aborted';
      return {
        ...base,
        // Cursor's loop_count counts every earlier automatic follow-up in the
        // conversation, so it cannot stand in for Claude's "already continued
        // once" flag: OMC scripts would stop continuing after one follow-up.
        // Loop bounds come from OMC's own iteration caps and hooks.json loop_limit.
        stop_hook_active: false,
        stop_reason: stopReasonFrom(c.status),
        user_requested: aborted,
        loop_count: c.loop_count,
      };
    }
    case 'sessionEnd':
      return { ...base, session_id: sessionId || c.session_id, reason: c.reason || 'other' };
    default:
      return { ...base, ...c };
  }
}

/** Parse a script's stdout into a Claude hook result object (or null). */
export function parseClaudeOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Some scripts print several JSON lines; take the last parseable object.
    const lines = text.split('\n').reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // keep looking
      }
    }
    return null;
  }
}

function additionalContextOf(result) {
  if (!result) return '';
  const hso = result.hookSpecificOutput;
  const parts = [];
  if (hso && typeof hso.additionalContext === 'string') parts.push(hso.additionalContext);
  if (typeof result.additionalContext === 'string') parts.push(result.additionalContext);
  return parts.filter(Boolean).join('\n\n');
}

function blockReasonOf(result) {
  if (!result) return null;
  if (result.decision === 'block') return result.reason || result.stopReason || 'Blocked by OMC hook.';
  const hso = result.hookSpecificOutput;
  if (hso && hso.decision === 'block') return hso.reason || 'Blocked by OMC hook.';
  return null;
}

function permissionOf(result) {
  const hso = result?.hookSpecificOutput;
  if (!hso) return null;
  if (hso.permissionDecision) {
    return { decision: hso.permissionDecision, reason: hso.permissionDecisionReason || '' };
  }
  const behavior = hso.decision?.behavior;
  if (behavior) return { decision: behavior, reason: hso.decision.message || '' };
  return null;
}

/**
 * Merge the results of every script that ran for one event into a single
 * Cursor hook response.
 *
 * `results` is an array of { result, exitCode, stderr } in run order.
 * Returns { response, pendingContext } where pendingContext is text that has
 * no native slot on this event and must be delivered later.
 */
export function toCursorOutput(event, results, cursorInput = {}) {
  const contexts = [];
  const userMessages = [];
  let blockReason = null;
  let hardStop = false;
  let hardStopReason = '';
  let permission = null;
  let updatedInput = null;

  for (const { result, exitCode, stderr } of results) {
    if (exitCode === 2) {
      // Claude Code convention: exit 2 blocks, stderr is the reason.
      blockReason = blockReason || (stderr || '').trim() || 'Blocked by OMC hook.';
      continue;
    }
    if (!result) continue;
    const ctx = additionalContextOf(result);
    if (ctx) contexts.push(ctx);
    if (typeof result.systemMessage === 'string' && result.systemMessage.trim()) {
      userMessages.push(result.systemMessage.trim());
    }
    if (result.continue === false) {
      hardStop = true;
      hardStopReason = hardStopReason || result.stopReason || '';
    }
    const reason = blockReasonOf(result);
    if (reason && !blockReason) blockReason = reason;
    const perm = permissionOf(result);
    if (perm && (!permission || perm.decision === 'deny')) permission = perm;
    const hso = result.hookSpecificOutput;
    if (hso && hso.updatedInput && typeof hso.updatedInput === 'object') updatedInput = hso.updatedInput;
  }

  const context = contexts.join('\n\n');
  const userMessage = userMessages.join('\n');
  const response = {};
  let pendingContext = '';

  switch (event) {
    case 'sessionStart': {
      const merged = [context, userMessage].filter(Boolean).join('\n\n');
      if (merged) response.additional_context = merged;
      break;
    }
    case 'beforeSubmitPrompt': {
      if (hardStop) {
        response.continue = false;
        if (hardStopReason || blockReason) response.user_message = hardStopReason || blockReason;
      } else if (blockReason) {
        response.continue = false;
        response.user_message = blockReason;
      } else {
        response.continue = true;
      }
      // beforeSubmitPrompt cannot add model context in Cursor: defer it.
      pendingContext = context;
      if (userMessage && response.continue !== false) pendingContext = [pendingContext, userMessage].filter(Boolean).join('\n\n');
      break;
    }
    case 'preToolUse': {
      if (blockReason || permission?.decision === 'deny') {
        const reason = permission?.decision === 'deny' ? permission.reason || blockReason : blockReason;
        response.permission = 'deny';
        response.user_message = reason;
        response.agent_message = reason;
      } else if (permission?.decision === 'allow') {
        response.permission = 'allow';
      }
      if (updatedInput && response.permission !== 'deny') {
        response.updated_input = mapUpdatedInput(cursorInput, updatedInput);
      }
      // Context produced before the tool runs is delivered by the postToolUse
      // response of the same call (Cursor's preToolUse has no context slot).
      if (response.permission !== 'deny') {
        pendingContext = [context, userMessage].filter(Boolean).join('\n\n');
      }
      break;
    }
    case 'beforeShellExecution': {
      if (permission?.decision === 'deny' || blockReason) {
        response.permission = 'deny';
        response.user_message = permission?.reason || blockReason;
        response.agent_message = permission?.reason || blockReason;
      } else if (permission?.decision === 'allow') {
        response.permission = 'allow';
      }
      break;
    }
    case 'postToolUse':
    case 'postToolUseFailure': {
      const merged = [context, userMessage, blockReason].filter(Boolean).join('\n\n');
      if (merged) response.additional_context = merged;
      break;
    }
    case 'subagentStart': {
      if (blockReason || permission?.decision === 'deny') {
        response.permission = 'deny';
        response.user_message = permission?.reason || blockReason;
      }
      break;
    }
    case 'subagentStop':
    case 'stop': {
      if (!hardStop && blockReason) response.followup_message = blockReason;
      break;
    }
    case 'preCompact': {
      const merged = [userMessage, context].filter(Boolean).join('\n\n');
      if (merged) response.user_message = merged;
      break;
    }
    default:
      break;
  }

  return { response, pendingContext };
}

/** Names of the OMC agents shipped by this plugin (Cursor subagent names are `omc-<name>`). */
export const AGENT_NAMES = [
  'analyst', 'architect', 'code-reviewer', 'code-simplifier', 'critic', 'debugger',
  'designer', 'document-specialist', 'executor', 'explore', 'git-master', 'planner',
  'qa-tester', 'scientist', 'security-reviewer', 'test-engineer', 'tracer', 'verifier', 'writer',
];

const AGENT_SET = new Set(AGENT_NAMES);

/** Skills whose frontmatter name differs from their folder name upstream. */
const SKILL_ALIASES = { plan: 'omc-plan', review: 'omc-review' };

/**
 * Rewrite Claude Code-specific references in text produced by the OMC runtime
 * so the Cursor agent sees invocations that exist in Cursor:
 *   /oh-my-claudecode:<skill>       -> /<skill>
 *   oh-my-claudecode:<agent>        -> omc-<agent>
 *   mcp__plugin_oh-my-claudecode_t__<tool> -> <tool> (omc MCP server)
 */
export function cursorizeText(text) {
  if (typeof text !== 'string' || !text) return text;
  const skill = (name) => SKILL_ALIASES[name] || name;
  return text
    .replace(/mcp__plugin_oh-my-claudecode_t__([a-z_]+)/g, '$1')
    .replace(/\/oh-my-claudecode:([a-z0-9-]+)/g, (match, name) => `/${skill(name)}`)
    .replace(/oh-my-claudecode:([a-z0-9-]+)/g, (match, name) => (AGENT_SET.has(name) ? `omc-${name}` : `/${skill(name)}`))
    .replace(/the active oh-my-claudecode plugin\/install/g, 'the oh-my-cursor plugin')
    .replace(/\bAskUserQuestion\b/g, 'AskQuestion')
    .replace(/\bTodoWrite\b/g, 'the to-do list')
    .replace(/\bClaude Code\b/g, 'Cursor');
}

/** Apply cursorizeText to every string field of a Cursor response. */
export function cursorizeResponse(response) {
  const out = {};
  for (const [key, value] of Object.entries(response || {})) {
    out[key] = typeof value === 'string' ? cursorizeText(value) : value;
  }
  return out;
}

/** True when deferred context carries a skill activation the agent must not miss. */
export function isActivationContext(text) {
  return typeof text === 'string' && /\[MAGIC KEYWORDS?(?: DETECTED)?:/.test(text);
}

/** Map a Claude-shaped updatedInput back onto the Cursor tool_input keys. */
export function mapUpdatedInput(cursorInput, updatedInput) {
  const original = (cursorInput && cursorInput.tool_input) || {};
  const out = { ...original };
  for (const [key, value] of Object.entries(updatedInput)) {
    if (key in original) out[key] = value;
  }
  if (updatedInput.command !== undefined) out.command = updatedInput.command;
  if (updatedInput.prompt !== undefined) {
    if ('task' in original) out.task = updatedInput.prompt;
    else out.prompt = updatedInput.prompt;
  }
  return out;
}
