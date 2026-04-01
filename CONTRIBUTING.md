# Contributing to browse-multi

browse-multi was built for **Claude Code** and its macOS Seatbelt sandbox. The entire architecture — MCP-first communication, out-of-sandbox daemon spawning, serialized port allocation — exists to work within Claude Code's constraints. Any changes must remain compatible with Claude Code's sandboxed environment. If a feature works via CLI but breaks under MCP in a sandboxed sub-agent, it's broken.

## Architecture

browse-multi is a three-tier system: **MCP server** → **per-instance HTTP daemons** → **Chromium processes**.

```
┌────────────────────────────────────────────────────────────┐
│  AI agent (sandboxed)                                      │
│                                                            │
│  All commands go through MCP tools (stdio JSON-RPC 2.0)    │
│  browse_start, browse_command, browse_stop, etc.           │
└────────────────────┬───────────────────────────────────────┘
                     │ stdin/stdout
┌────────────────────▼───────────────────────────────────────┐
│  MCP Server — browse-multi-mcp.js                          │
│  Runs OUTSIDE sandbox. Spawns daemons, proxies commands.   │
│  Serialized message queue prevents port races.             │
└────────────────────┬───────────────────────────────────────┘
                     │ HTTP (127.0.0.1:9400-9420)
┌────────────────────▼───────────────────────────────────────┐
│  Instance Daemon — browse-multi-server.js (one per agent)  │
│  Holds a single Chromium process + Playwright context.     │
│  Bearer token auth. 30-min idle auto-shutdown.             │
└────────────────────┬───────────────────────────────────────┘
                     │ CDP / Playwright API
┌────────────────────▼───────────────────────────────────────┐
│  Chromium (local, installed via postinstall)                │
└────────────────────────────────────────────────────────────┘
```

### Why this architecture?

macOS Seatbelt sandbox (used by Claude Code) blocks two things for sub-agents:
1. **Chromium launch** — Mach port registration is denied
2. **localhost TCP** — sub-agents can't connect to `127.0.0.1`

The MCP server runs outside the sandbox (MCP servers are spawned by the host process, not the agent). It can launch Chromium and make HTTP calls to the daemons. The agent communicates with the MCP server via stdio, which is not blocked.

This was discovered through painful debugging — things that work in the parent session fail silently in sub-agents. The CLI (`browse-multi.js`) uses HTTP to localhost and therefore **only works outside the sandbox**. MCP is the primary interface.

### Why not just Playwright MCP?

Playwright MCP gives you one shared browser instance. browse-multi gives each agent its own. When you have 5 parallel sub-agents each needing to browse different sites, shared state breaks everything.

## Project structure

```
browse-multi/
  browse-multi-mcp.js      ← MCP server (entry point for Claude Code)
  browse-multi-server.js    ← Per-instance HTTP daemon
  browse-multi.js           ← CLI client (fallback for non-sandboxed use)
  setup                     ← Install script (npm install + claude mcp add)
  test-smoke.sh             ← 12-test regression suite (uses CLI)
  .mcp.json                 ← MCP plugin manifest (Claude Code auto-discovery)
  SKILL.md                  ← Skill file (tells Claude Code when/how to use browse-multi)
  lib/
    instance.js             ← State file management, port allocation (9400-9420), health checks, HTTP client
    refs.js                 ← @ref system: DOM annotation, snapshot tree building, ref resolution
  commands/
    navigation.js           ← goto, back, reload, url
    content.js              ← text, html, snapshot, scroll
    interaction.js          ← click, fill, type, press, select, hover, drag, wait, dialog, upload, resize
    inspection.js           ← js, eval, console, network (ring buffers, 500 max)
    visual.js               ← screenshot
    tabs.js                 ← tabs, tab, newtab, closetab
    session.js              ← export-session, save-session
  browsers/                 ← Chromium (auto-installed, gitignored)
```

## Key conventions

### ES modules

All `.js` files use `import`/`export`. The project is `"type": "module"` in package.json.

### Zero external dependencies

The only dependency is Playwright (pinned at 1.58.2). Everything else uses Node.js stdlib: `http`, `fs`, `path`, `child_process`, `crypto`, `os`. This is intentional — every dependency is attack surface. Don't add packages. If `http` or `fs` can do it, use them.

### Command registry pattern

Each file in `commands/` exports a `register(registerFn)` function. The server calls these at startup to build the command table.

```js
// commands/example.js
export function register(registerCommand) {
  registerCommand('my-command', async (args, ctx) => {
    // ctx.page, ctx.browser, ctx.context — Playwright objects
    // ctx.refMap, ctx.clearRefs(), ctx.setRefMap() — @ref state
    // ctx.consoleBuffer, ctx.networkBuffer — ring buffers
    // ctx.NAME — instance name
    return 'result string or JSON-serializable object';
  });
}
```

To add a new command: create or edit a file in `commands/`, export `register`, and add the import + `register(registerCommand)` call in `browse-multi-server.js`.

### Atomic state files

State files (`~/.browse-multi/browse-multi-{name}.json`) are written atomically: write to `.tmp`, then rename to the live path. This prevents partial/corrupted reads when the MCP server and daemons access state concurrently. Follow this pattern for any new state file operations (see `lib/instance.js`).

### Port allocation

Ports 9400-9420 (21 max concurrent instances). The MCP server scans for the first free port, health-checking existing state files to detect dead instances. The serialized message queue in `browse-multi-mcp.js` prevents race conditions when multiple agents call `browse_start` simultaneously.

### Login mode

Instance names starting with `login-` trigger a special code path:
- Chrome is launched directly via `spawn` (not `playwright.launch()`)
- Connects via Chrome DevTools Protocol (CDP) on ports 9450-9479
- Disables automation flags that trigger "This browser may not be secure" warnings (e.g., Gmail)
- Uses a temp user-data-dir, cleaned up after session export

This exists because Playwright's automation signals cause some sites (notably Google) to block the login flow.

### @ref lifecycle

`snapshot` injects `data-browse-ref="eN"` attributes on DOM elements and stores the mapping server-side. Refs are valid until any navigation (`goto`, `back`, `reload`), which clears them. The resolver in `lib/refs.js` converts `@eN` to `[data-browse-ref="eN"]` CSS selectors at command execution time.

Always re-snapshot after navigating before using `@ref` handles.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSE_MULTI_STATE_DIR` | `~/.browse-multi` | State files, logs, default screenshot path |
| `BROWSE_MULTI_SESSIONS_DIR` | `~/.claude/sessions` | Saved session/cookie files |
| `PLAYWRIGHT_BROWSERS_PATH` | `./browsers` | Set automatically at startup — Chromium lives in the project |

For custom paths, use a wrapper script that sets env vars before exec'ing the MCP server:

```bash
#!/bin/bash
export BROWSE_MULTI_STATE_DIR="$HOME/my-state-dir"
export BROWSE_MULTI_SESSIONS_DIR="$HOME/my-sessions-dir"
exec node /path/to/browse-multi/browse-multi-mcp.js "$@"
```

Then register the wrapper as the MCP command: `claude mcp add browse-multi -- /path/to/wrapper.sh`

## MCP registration

The `setup` script registers the MCP server with Claude Code via `claude mcp add`. This adds an entry to `~/.claude.json` (Claude Code's internal config). If `claude mcp add` fails from inside Claude Code (common), the setup script prints a command to run in a separate terminal.

The `.mcp.json` file at the project root is the plugin manifest — Claude Code uses it for auto-discovery when the repo is cloned into the skills directory.

**Do not edit `~/.claude.json` directly.** It's Claude Code's internal config and is written to continuously. Manual edits cause race conditions.

MCP tool permissions (allowing `browse_command`, `browse_start`, etc. without prompting) are configured in Claude Code's settings files, not in browse-multi itself.

## Testing

Run the smoke tests:

```bash
npm test
# or directly:
bash test-smoke.sh
```

The test suite uses the **CLI interface** (not MCP), so it requires localhost TCP access — it won't work inside a sandbox. Tests start instances, run commands, verify output, and clean up.

When adding a new command, add a corresponding test to `test-smoke.sh`.

## Timeouts

| Context | Timeout | Where |
|---------|---------|-------|
| Page navigation (goto/back/reload) | 30s | `commands/navigation.js` |
| Health check | 2s (1s for port collision detection) | `lib/instance.js` |
| Server startup wait | 10s | `browse-multi-mcp.js` |
| HTTP request to daemon | 60s | `lib/instance.js` |
| Idle auto-shutdown | 30 min | `browse-multi-server.js` |
| Chain command | 5 min (configurable) | `browse-multi.js` |

## Common pitfalls

**"It works in my session but not in a sub-agent"** — The sub-agent is sandboxed. Seatbelt blocks localhost TCP. The sub-agent must use MCP tools (`browse_command`), not the CLI. This is the #1 cause of failures.

**"Port already in use"** — A previous instance didn't shut down cleanly. Run `browse_status` (it auto-cleans dead instances) or manually delete state files in `$BROWSE_MULTI_STATE_DIR`.

**"Login blocked by Google/Gmail"** — The login mode uses direct Chrome launch via CDP to avoid Playwright automation flags. If you're seeing "This browser may not be secure," the login path isn't being triggered. Check that the instance name starts with `login-`.

**Stale @refs** — Any navigation clears refs. Always `snapshot` again after `goto`, `back`, or `reload` before clicking `@eN` handles.

**Lone surrogates in page content** — Some pages produce invalid UTF-16. The MCP layer sanitizes these before returning results (replacement char U+FFFD). If you see garbled output, this is likely the sanitizer working correctly on genuinely broken page content.

## Pull request guidelines

1. Don't add npm dependencies. Use Node.js stdlib.
2. Follow the existing command registry pattern for new commands.
3. Add a smoke test for new commands.
4. Test both MCP and CLI paths if your change affects command routing.
5. Keep Playwright pinned — don't bump without testing the full suite.
6. State file changes must use atomic writes (write .tmp, rename).
