#!/usr/bin/env node
'use strict';
/**
 * Launcher for the omc MCP server under Cursor.
 *
 * The bundled server treats process.cwd() as the trusted project root for its
 * state, notepad and project-memory tools. Cursor may start plugin MCP servers
 * from the plugin folder, so move to the workspace first when Cursor provides
 * it (mcp.json passes ${workspaceFolder} as OMC_WORKSPACE). If the value is
 * missing or was not interpolated, the current directory is kept.
 */

const { existsSync, statSync } = require('fs');
const { join } = require('path');

const workspace = process.env.OMC_WORKSPACE;
if (workspace && !workspace.includes('${') && existsSync(workspace)) {
  try {
    if (statSync(workspace).isDirectory()) process.chdir(workspace);
  } catch {
    // keep the current directory
  }
}

require(join(__dirname, '..', 'bridge', 'mcp-server.cjs'));
