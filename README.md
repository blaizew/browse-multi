# browse-multi

Concurrent headless browser automation for AI coding agents.

Give each AI agent its own named Chromium instance. First call auto-starts the browser (~3s). Subsequent commands run in ~200ms. Instances auto-shutdown after 30 minutes idle.

## Why

AI coding assistants (Claude Code, Cursor, Copilot, Windsurf, etc.) often need to browse the web -- scraping documentation, filling forms, verifying deployments, taking screenshots. But most browser tools give you a single shared instance, which breaks when you have parallel agents or sub-agents that each need their own browser.

browse-multi solves this with **named instances**. Each agent gets its own persistent Chromium process, accessed via an MCP server that works in both sandboxed and unsandboxed environments. No shared state, no conflicts, up to 21 concurrent instances.

## Install

Open Claude Code and paste this:

```
Install browse-multi: run git clone https://github.com/blaizew/browse-multi.git ~/.claude/skills/browse-multi && cd ~/.claude/skills/browse-multi && ./setup
```

Claude will clone the repo, install Chromium, register the MCP server, and set up skill routing. After restarting Claude Code, browse-multi is ready to use.

If `claude mcp add` fails from inside Claude Code, the setup script will print a command to run in a separate terminal.

### What the setup does

1. `npm install` — installs Playwright and downloads Chromium locally
2. `claude mcp add` — registers the MCP server so instances can start outside the sandbox
3. The skill file (`SKILL.md`) at the repo root tells Claude Code when and how to use browse-multi

## Quick start

All interaction goes through the MCP server. This works in both sandboxed and unsandboxed environments.

```
# Start an instance
browse_start(name: "agent1")

# Browse
browse_command(name: "agent1", command: "goto", args: ["https://example.com"])
browse_command(name: "agent1", command: "text")
browse_command(name: "agent1", command: "screenshot", args: ["./page.png"])

# Another agent, concurrently
browse_start(name: "agent2")
browse_command(name: "agent2", command: "goto", args: ["https://docs.python.org"])
browse_command(name: "agent2", command: "snapshot", args: ["-i"])
browse_command(name: "agent2", command: "click", args: ["@e3"])

# Stop when done
browse_stop(name: "agent1")
browse_stop(name: "agent2")
```

## How it works

The MCP server manages instance lifecycle and proxies commands to per-instance Chromium daemons. This architecture works in sandboxed environments (where Bash can't launch Chromium or connect to localhost) and unsandboxed ones alike.

```
┌─────────────────────────────────────────────┐
│  AI coding agent (sandboxed or not)          │
│                                              │
│  MCP: browse_start(name: "a1")          ──────▶ spawns Chromium daemon
│  MCP: browse_command(name, "goto", [url]) ──────▶ proxied to daemon
│  MCP: browse_command(name, "text")        ──────▶ proxied to daemon
│  MCP: browse_stop(name: "a1")            ──────▶ kills daemon
│                                              │
└─────────────────────────────────────────────┘
                                                         │
┌─────────────────────────────────────────────┐          │
│  MCP server (outside sandbox)               │          │
│                                              │          ▼
│  browse-multi-mcp.js ──▶ spawns ──▶ Chromium daemon on :9400
│                       ──▶ HTTP  ──▶ 127.0.0.1:9400
│                       ──▶ kill  ──▶ stops daemon
└─────────────────────────────────────────────┘
```

Each daemon is fully independent -- its own Chromium process, its own port, its own auth token. Daemons auto-shutdown after 30 minutes of inactivity.

### MCP tools

| Tool | Description |
|------|-------------|
| `browse_start` | Start a named Chromium instance (params: `name`, `session?`, `headed?`) |
| `browse_command` | Send any command to a running instance (params: `name`, `command`, `args?`) |
| `browse_stop` | Stop an instance or all instances (params: `name?`) |
| `browse_status` | List all running instances with port, PID, and health |
| `browse_login` | Open a headed browser for user to log in (params: `url`) |
| `browse_login_complete` | Save session cookies and close login browser (params: `name?`, `domain?`) |

### MCP setup

The install script handles this automatically. To register manually:

```bash
claude mcp add browse-multi -- node /path/to/browse-multi/browse-multi-mcp.js
```

Then restart Claude Code.

## Commands

All commands are sent via `browse_command`. The `command` parameter is the command name, and `args` is an array of arguments.

```
browse_command(name: "a1", command: "<command>", args: ["<arg1>", "<arg2>"])
```

### Navigation

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL (waits for DOM content loaded) |
| `back` | Go back in history |
| `reload` | Reload current page |
| `url` | Print current URL |

```
browse_command(name: "a1", command: "goto", args: ["https://example.com"])
browse_command(name: "a1", command: "back")
browse_command(name: "a1", command: "url")
```

### Content

| Command | Description |
|---------|-------------|
| `text [--limit N]` | Extract page text (default limit: 50,000 chars) |
| `html [selector]` | Get innerHTML of element, or full page HTML |
| `snapshot [-i] [-s selector]` | Build DOM tree with @ref handles |
| `scroll [up\|down\|selector]` | Scroll viewport or element into view |

```
browse_command(name: "a1", command: "text")
browse_command(name: "a1", command: "text", args: ["--limit", "5000"])
browse_command(name: "a1", command: "html", args: [".main-content"])
browse_command(name: "a1", command: "snapshot", args: ["-i"])
browse_command(name: "a1", command: "scroll")
browse_command(name: "a1", command: "scroll", args: ["up"])
browse_command(name: "a1", command: "scroll", args: [".footer"])
```

### Interaction

| Command | Description |
|---------|-------------|
| `click <sel\|@ref>` | Click an element |
| `fill <sel\|@ref> <value>` | Clear and fill an input |
| `type <text>` | Type text with keyboard (no clearing) |
| `press <key>` | Press a key (Enter, Tab, Escape, etc.) |
| `select <sel> <value>` | Select dropdown option |
| `hover <sel\|@ref>` | Hover over element |
| `drag <from> <to>` | Drag one element to another |
| `wait <sel> [--timeout ms]` | Wait for element to appear (default: 10s) |
| `dialog <accept\|dismiss>` | Handle next browser dialog |
| `upload <sel> <filepath>` | Upload file to input |
| `resize <WxH>` | Set viewport size |

```
browse_command(name: "a1", command: "click", args: ["@e3"])
browse_command(name: "a1", command: "fill", args: ["#email", "test@test.com"])
browse_command(name: "a1", command: "press", args: ["Enter"])
browse_command(name: "a1", command: "wait", args: [".results", "--timeout", "30000"])
browse_command(name: "a1", command: "resize", args: ["375x812"])
```

### Inspection

| Command | Description |
|---------|-------------|
| `js <expression>` | Evaluate JavaScript expression |
| `eval` | Evaluate JavaScript from stdin (for multi-line code) |
| `console` | Show captured console messages (ring buffer, last 500) |
| `network` | Show captured network requests (ring buffer, last 500) |

```
browse_command(name: "a1", command: "js", args: ["document.title"])
browse_command(name: "a1", command: "js", args: ["document.querySelector('.price').textContent"])
browse_command(name: "a1", command: "console")
browse_command(name: "a1", command: "network")
```

### Visual

| Command | Description |
|---------|-------------|
| `screenshot [path]` | Take screenshot (default: state directory) |

```
browse_command(name: "a1", command: "screenshot")
browse_command(name: "a1", command: "screenshot", args: ["./my-screenshot.png"])
```

### Tabs

| Command | Description |
|---------|-------------|
| `tabs` | List open tabs |
| `tab <id>` | Switch to tab by index |
| `newtab [url]` | Open new tab |
| `closetab [id]` | Close tab (defaults to current) |

```
browse_command(name: "a1", command: "newtab", args: ["https://other.com"])
browse_command(name: "a1", command: "tabs")
browse_command(name: "a1", command: "tab", args: ["0"])
browse_command(name: "a1", command: "closetab", args: ["1"])
```

### Session

| Command | Description |
|---------|-------------|
| `export-session` | Export cookies and storage state as JSON |
| `save-session [domain]` | Export and save to sessions directory |

```
browse_command(name: "a1", command: "save-session")
browse_command(name: "a1", command: "save-session", args: ["example.com"])
browse_command(name: "a1", command: "export-session")
```

### Multi-command chain

```
browse_command(name: "a1", command: "chain", args: [
  "[\"goto\",\"https://example.com\"],[\"text\"],[\"screenshot\",\"./out.png\"]"
])
```

## The @ref system

The `snapshot` command annotates DOM elements with `@ref` handles (`@e1`, `@e2`, ...) that you can use in place of CSS selectors for `click`, `fill`, and `hover`:

```
browse_command(name: "a1", command: "snapshot", args: ["-i"])
# → @e1  a "Home"
#   @e2  a "About"
#   @e3  input placeholder="Search..."
#   @e4  button "Submit"

browse_command(name: "a1", command: "click", args: ["@e4"])
browse_command(name: "a1", command: "fill", args: ["@e3", "search query"])
```

**Lifecycle:** Refs are assigned during `snapshot` and remain valid until any navigation (`goto`, `back`, `reload`), which clears them. Always re-snapshot after navigating.

**Flags:**
- `-i` -- interactive elements only (links, buttons, inputs, etc.)
- `-s <selector>` -- scope snapshot to a specific element

## Authenticated browsing

Sessions are stored in the sessions directory (`~/.claude/sessions/<domain>.json` by default) and can be shared across instances.

### Login flow

```
# Step 1: Open a headed browser for the user to log in
browse_login(url: "https://mysite.com/login")

# Step 2: User logs in manually...

# Step 3: Save session cookies and close the browser
browse_login_complete()
# → saves to ~/.claude/sessions/mysite.com.json
```

### Using saved sessions

```
browse_start(name: "agent1", session: "~/.claude/sessions/mysite.com.json")
browse_command(name: "agent1", command: "goto", args: ["https://mysite.com/dashboard"])
```

The `session` parameter only applies when the instance starts. To refresh expired sessions, stop the instance, re-login, and start again with the updated session file.

## Headed / headless mode

Instances are **headed by default** (visible browser window). On macOS, non-login windows are
automatically sent to background after launch so they don't steal focus. Login instances stay
in the foreground so the user can interact with them.

For headless (invisible) browsing:

```
browse_start(name: "agent1", headed: false)
```

## Concurrency

Each `--name` gets its own Chromium process with its own port (range 9400-9420, up to 21 concurrent instances). Instances are fully isolated -- different pages, different cookies, different state.

```
# Three agents browsing simultaneously
browse_start(name: "agent1")
browse_start(name: "agent2")
browse_start(name: "agent3")

browse_command(name: "agent1", command: "goto", args: ["https://site-a.com"])
browse_command(name: "agent2", command: "goto", args: ["https://site-b.com"])
browse_command(name: "agent3", command: "goto", args: ["https://site-c.com"])
```

**Rules:**
- Never share a `--name` between concurrent agents
- Each instance uses ~100-200MB RAM
- If you run out of ports, use `browse_status` to find idle instances and stop them

## CLI fallback

A CLI is available for standalone use, CI, or environments where MCP is not available. The CLI sends the same HTTP commands to the same daemons — it's an alternative interface, not a different system.

```bash
browse-multi --name a1 goto https://example.com
browse-multi --name a1 text
browse-multi --name a1 screenshot ./page.png
browse-multi --name a1 click @e3
browse-multi --name a1 stop
browse-multi status
browse-multi stop --all
```

Session management via CLI:

```bash
browse-multi login https://mysite.com/login                  # headed browser for login
browse-multi --name login-mysite.com save-session             # save session
browse-multi --name login-mysite.com stop
browse-multi --name a1 start --session ~/.claude/sessions/mysite.com.json
```

**Note:** The CLI requires localhost TCP access. In sandboxed environments (Claude Code with Seatbelt), the CLI won't work — use the MCP tools instead.

## HTTP API

For programmatic use, you can talk directly to the daemon HTTP server. Each instance listens on `127.0.0.1:{port}` and requires a Bearer token.

### Health check

```
GET /health
→ { "ok": true, "name": "agent1", "uptime": 42 }
```

No auth required.

### Command

```
POST /command
Authorization: Bearer {token}
Content-Type: application/json

{ "command": "goto", "args": ["https://example.com"] }
→ { "ok": true, "result": "Navigated to https://example.com/" }
```

Port and token are stored in the state file at `~/.browse-multi/browse-multi-{name}.json` (or `$BROWSE_MULTI_STATE_DIR`).

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `BROWSE_MULTI_STATE_DIR` | `~/.browse-multi` | Directory for state files, logs, and default screenshots |
| `BROWSE_MULTI_SESSIONS_DIR` | `~/.claude/sessions` | Directory for saved session/cookie files |

To set env vars for the MCP server, use a wrapper script:

```bash
#!/bin/bash
export BROWSE_MULTI_STATE_DIR="$HOME/my-custom-state-dir"
export BROWSE_MULTI_SESSIONS_DIR="$HOME/my-custom-sessions-dir"
exec node /path/to/browse-multi/browse-multi-mcp.js "$@"
```

Then register the wrapper as the MCP command:

```bash
claude mcp add browse-multi -- /path/to/wrapper.sh
```

## Troubleshooting

**"No free ports"** -- Too many instances running. Run `browse_status` and stop idle ones.

**"Server failed to start"** -- Check logs at `~/.browse-multi/browse-multi-{name}.log` (or `$BROWSE_MULTI_STATE_DIR`).

**"@eN not found"** -- Refs are stale. Run `snapshot` again after any navigation.

**Stale instances** -- `browse_status` auto-cleans dead instances.

**Instance won't stop** -- Kill the process manually. Check PID in the state file.

**Auth not working** -- Session cookies may have expired. Re-login via `browse_login` and restart the instance with a fresh session file.

**Sandbox blocking Chromium or localhost** -- Use the MCP tools (`browse_command`) for all commands. They run outside the sandbox. The CLI only works in non-sandboxed contexts.

## Requirements

- Node.js >= 18
- Chromium is installed automatically via `npm install` (postinstall script runs `npx playwright install chromium`)

## License

MIT
