# Notice

oh-my-cursor is a derivative work of **oh-my-claudecode** (https://github.com/Yeachan-Heo/oh-my-claudecode),
Copyright (c) 2025 Yeachan Heo and contributors, released under the MIT License (see `LICENSE`).

Ported from upstream version 5.7.19, commit `e10206d8789b0ac4e5214eddbfbd203c1b757dea` (2026-10-27).

- `scripts/`, `dist/`, `bridge/`, `templates/`, `bin/` and `package.json` are the upstream runtime, unchanged.
- `agents/`, `skills/` and `commands/` are generated from upstream by `tools/port/convert.mjs` and
  partly rewritten by hand (`cursor/overrides/`) for Cursor.
- `.cursor-plugin/`, `rules/`, `hooks/hooks.json`, `mcp.json`, `cursor/` and `tools/` are new.

oh-my-cursor is not affiliated with Cursor (Anysphere), Anthropic or the oh-my-claudecode maintainers.
