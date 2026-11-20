# CLAUDE.md — working on Argon

Argon is an open-source AI agent: a shared TypeScript **core**, a full-screen terminal **CLI**, a local HTTP/WebSocket **server**, a vanilla-JS **GUI** and an **Electron** desktop shell. The agent loop and provider streaming come from Pi (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`).

## Commands

```bash
npm run build        # tsc → dist/ (the GUI has no build step)
npm test             # node --test test/*.test.mjs — fake model, no network; must stay green
npm run desktop      # Electron app from source
npm run dist         # Windows NSIS installer → release/Argon-Setup-<version>.exe
node test/harness/tui-harness.mjs <outDir> [cols] [rows]   # drive the CLI in headless xterm, writes .txt/.html snapshots
```

Always run `npm run build && npm test` before committing. For CLI rendering changes, run the harness and read the `.txt` snapshots.

## Layout

```
src/core/         shared engine (no UI)
  session.ts      ArgonSession: wraps pi Agent; permissions gate, hooks, limits, usage, compaction, undo, sub-agents, background processes
  config.ts       Settings type + defaults; settings.json cache refreshed when the file changes (CLI and GUI run concurrently)
  providers.ts    provider list, modelsFor()/resolveModel(); catalog.ts = live model lists per provider (cached 6h, versioned)
  effort.ts       per-model reasoning profiles (provider-reported levels, default, mandatory) → pi thinking level + thinkingLevelMap
  permissions.ts  modes, allow/deny rules, environment sandbox (writes outside the env folder always ask)
  usage.ts        usage.jsonl ledger (read incrementally), limits, spend, stats, usageDetail() (per model/provider/agent)
  sessions.ts     session files + index (reloaded when changed on disk), environments
  agents.ts       built-in and .md sub-agent definitions
  github.ts       GitHub status (token or gh), git state, createPullRequest
  importer.ts     import CLI sessions into the GUI with git context
  background.ts   background shell processes per session (bash_output / kill_bash tools)
  tools/          read, write, edit, bash, ls, glob, grep, web, todo, memory, skill, task, ask_user
src/cli/
  main.ts         argument parsing, subcommands, headless -p mode
  tui.ts          interactive full-screen UI (editor, pickers, slash commands, event rendering)
  screen.ts       scroll-region terminal layout: transcript above, fixed bottom panel; ANSI/wide-char aware wrapping
  ui.ts           colours, banner, MarkdownStream (line-based streaming markdown), tables
  commands.ts     shared CLI helpers (login, limits, stats, mcp, env removal…)
src/server/server.ts   127.0.0.1 HTTP + WebSocket API for the GUI (token-protected), file watcher for CLI changes, favicons
gui/              index.html, style.css (M3 base), motion.css, environments.css, m3.css, js/{lib,app,pages,theme}.js
desktop/          Electron main/preload, bin/argon.cmd (CLI launcher), bin/path.ps1 (PATH add/remove)
build/            icon.png, installer.nsh (NSIS: PATH + uninstall cleanup)
test/             *.test.mjs (node:test), fixtures/echo-mcp.mjs, harness/tui-harness.mjs
```

## Conventions

- ESM TypeScript (`module: NodeNext`): import local files with the `.js` extension.
- User-facing strings are bilingual: `T("italiano", "English")` in the CLI (language = `settings.cli.language`), `tt(it, en)` / `t(key)` in the GUI (language = `settings.general.language`).
- The CLI and GUI share `~/.argon` (`ARGON_HOME` overrides it). Anything cached in memory must tolerate another process writing the same file (see config.ts, sessions.ts, usage.ts).
- Settings: add the field to the `Settings` type **and** `DEFAULT_SETTINGS`; `cli.*` is CLI-only, everything else is shared. Usage limits are always shared.
- Model choices made in either interface become the shared defaults (`rememberDefaults` in session.ts).
- GUI: no framework, no bundler. Render with template strings + `esc()` for every interpolated value. Raw HTML from the model is escaped in `md()`; keep the CSP in server.ts strict.
- GUI transcript updates go through `reconcile()` (only changed blocks are replaced) so animations don't restart while streaming — don't replace it with `innerHTML`.
- Native `<select>` elements are upgraded automatically to M3 menus by `lib.js` (MutationObserver); dispatch `change` on the select when setting values programmatically.
- Usage events from sub-agents carry `agent`; housekeeping calls use `"title"` / `"compaction"`. Totals always include them.
- Security: never log or send credentials; the GUI API requires the `X-Argon-Token` header (favicons accept `?t=`); writes outside an environment must keep going through the sandbox check.

## Gotchas

- Shell heredocs/`node -e` turn `\\` into `\` and `"\n"` into real newlines inside generated code — edit source files with an editor tool, not inline scripts, when they contain regexes or escapes.
- `npm install` blocks install scripts: Electron needs `npm install-scripts approve electron` (already in `package.json` → `allowScripts`).
- Pi's Anthropic provider only knows adaptive thinking for 4.6/4.7 model ids; `adaptiveThinkingPatch` (effort.ts) upgrades newer Claude ids through `onPayload`.
- The packaged app is not an asar archive (`build.asar: false`) so the CLI can run from `resources/app` with `ELECTRON_RUN_AS_NODE`.
- `where rg` on Windows prints to stderr when ripgrep is missing: child processes used by the TUI must not inherit stderr.
