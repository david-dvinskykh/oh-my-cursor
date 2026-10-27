/**
 * Routing table: which OMC runtime scripts run for each Cursor hook event.
 *
 * Mirrors the upstream Claude Code hooks.json (oh-my-claudecode v5.7.19),
 * re-keyed by native Cursor event names. `matcher` is tested against the
 * Claude-style tool / agent name produced by translate.mjs, so upstream
 * matchers keep working unchanged.
 *
 * Fields:
 *   script   - file under scripts/
 *   args     - extra argv passed to the script
 *   matcher  - regex (anchored) on the Claude-style tool name; omitted = all
 *   timeout  - per-script timeout in ms
 *   async    - fire-and-forget (output ignored, not awaited)
 */

export const ROUTES = {
  sessionStart: [
    { script: 'session-start.mjs', timeout: 5000 },
    { script: 'project-memory-session.mjs', timeout: 5000 },
    { script: 'wiki-session-start.mjs', timeout: 5000 },
    { script: 'stale-run-reporter.mjs', timeout: 5000 },
    { script: 'runs-reconciler.mjs', timeout: 5000 },
  ],
  beforeSubmitPrompt: [
    { script: 'keyword-detector.mjs', timeout: 30000 },
    { script: 'skill-injector.mjs', timeout: 30000 },
  ],
  preToolUse: [
    { script: 'pre-tool-enforcer.mjs', timeout: 5000 },
    { script: 'git-guardrails.mjs', matcher: 'Bash', timeout: 5000 },
  ],
  beforeShellExecution: [
    // Upstream ran this on Claude Code's PermissionRequest event. Cursor has no
    // such event; beforeShellExecution is the closest native permission gate.
    { script: 'permission-handler.mjs', timeout: 5000, permissionRequest: true },
  ],
  postToolUse: [
    { script: 'post-tool-verifier.mjs', timeout: 5000 },
    { script: 'project-memory-posttool.mjs', timeout: 3000, async: true },
    { script: 'post-tool-rules-injector.mjs', matcher: 'Read|Write|Edit|MultiEdit', timeout: 3000 },
    { script: 'post-tool-directory-context-injector.mjs', matcher: 'Read|Write|Edit|MultiEdit', timeout: 3000 },
  ],
  postToolUseFailure: [
    { script: 'post-tool-use-failure.mjs', timeout: 3000 },
  ],
  subagentStart: [
    { script: 'subagent-tracker.mjs', args: ['start'], timeout: 3000 },
  ],
  subagentStop: [
    { script: 'subagent-tracker.mjs', args: ['stop'], timeout: 5000 },
    { script: 'verify-deliverables.mjs', timeout: 5000 },
  ],
  preCompact: [
    { script: 'pre-compact.mjs', timeout: 10000 },
    { script: 'project-memory-precompact.mjs', timeout: 5000 },
    { script: 'wiki-pre-compact.mjs', timeout: 3000 },
  ],
  stop: [
    { script: 'context-guard-stop.mjs', timeout: 5000 },
    { script: 'workflow-drift-guard.mjs', timeout: 3000 },
    { script: 'persistent-mode.mjs', timeout: 10000 },
    { script: 'budget-guard.mjs', timeout: 5000 },
    { script: 'code-simplifier.mjs', timeout: 5000 },
  ],
  sessionEnd: [
    { script: 'session-end.mjs', timeout: 30000, async: true },
    { script: 'wiki-session-end.mjs', timeout: 30000, async: true },
  ],
};

/** Native Cursor event name -> Claude Code event name expected by the scripts. */
export const CLAUDE_EVENT = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  beforeShellExecution: 'PermissionRequest',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
  stop: 'Stop',
  sessionEnd: 'SessionEnd',
};

export function routesFor(event, claudeToolName) {
  const routes = ROUTES[event] || [];
  return routes.filter((route) => {
    if (!route.matcher) return true;
    if (!claudeToolName) return false;
    return new RegExp(`^(?:${route.matcher})$`).test(claudeToolName);
  });
}
