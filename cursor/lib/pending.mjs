/**
 * Deferred model context.
 *
 * Some Cursor events (beforeSubmitPrompt, preToolUse) cannot add text to the
 * model context, while the matching Claude Code events could. Text produced
 * there is queued per conversation and delivered by the next event that can
 * carry it: postToolUse / postToolUseFailure (additional_context) or, if the
 * agent finishes without calling a tool, stop (followup_message).
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;

function safeId(id) {
  const cleaned = String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.slice(0, 128) || 'default';
}

export function pendingPath(cwd, conversationId) {
  return join(cwd, '.omc', 'state', 'cursor', `pending-${safeId(conversationId)}.json`);
}

export function queueContext(cwd, conversationId, text, meta = {}) {
  if (!text || !text.trim()) return;
  const file = pendingPath(cwd, conversationId);
  let entries = [];
  try {
    if (existsSync(file)) entries = JSON.parse(readFileSync(file, 'utf-8')).entries || [];
  } catch {
    entries = [];
  }
  if (entries.some((entry) => entry.text === text)) return;
  entries.push({ text, at: new Date().toISOString(), ...meta });
  let payload = JSON.stringify({ entries });
  while (payload.length > MAX_BYTES && entries.length > 1) {
    entries.shift();
    payload = JSON.stringify({ entries });
  }
  try {
    mkdirSync(join(cwd, '.omc', 'state', 'cursor'), { recursive: true });
    writeFileSync(file, payload);
  } catch {
    // Best effort: losing a reminder must never break the agent.
  }
}

/** Read and clear queued context. Returns '' when nothing is pending. */
export function takeContext(cwd, conversationId) {
  const file = pendingPath(cwd, conversationId);
  try {
    if (!existsSync(file)) return '';
    const entries = JSON.parse(readFileSync(file, 'utf-8')).entries || [];
    rmSync(file, { force: true });
    return entries.map((entry) => entry.text).filter(Boolean).join('\n\n');
  } catch {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return '';
  }
}
