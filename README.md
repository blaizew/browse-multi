# browse-multi

Concurrent headless browser automation for AI coding agents.

Give each AI agent its own named Chromium instance. First call auto-starts the browser (~3s). Subsequent commands run in ~200ms. Instances auto-shutdown after 30 minutes idle.

## Why

AI coding assistants (Claude Code, Cursor, Copilot, Windsurf, etc.) often need to browse the web -- scraping documentation, filling forms, verifying deployments, taking screenshots. But most browser tools give you a single shared instance, which breaks when you have parallel agents or sub-agents that each need their own browser.

browse-multi solves this with **named instances**. Each agent gets its own persistent Chromium process, accessed via simple CLI commands or an MCP server. No shared state, no conflicts, up to 21 concurrent instances.

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

```bash
# Browse
browse-multi --name agent1 goto https://example.com
browse-multi --name agent1 text
browse-multi --name agent1 screenshot ./page.png

# Another agent, concurrently
browse-multi --name agent2 goto https://docs.python.org
browse-multi --name agent2 snapshot -i
browse-multi --name agent2 click @e3
```

## MCP server (required for sandboxed environments)

browse-multi ships with an MCP server that manages instance lifecycle (start/stop/status). **This is not optional** — it's the primary way to use browse-multi with Claude Code and other sandboxed AI coding tools.

### Why MCP?

Claude Code runs Bash commands inside a macOS Seatbelt sandbox that blocks Chromium from launching (specifically, Mach port registration is denied). The MCP server runs outside the sandbox as a separate process, so it can start Chromium instances. Once an instance is running, all browse commands go through Bash as HTTP requests to `127.0.0.1` — which works fine from inside the sandbox.

```
┌─────────────────────────────────────────────┐
│  Claude Code sandbox                         │
│                                              │
│  Bash: browse-multi --name a1 goto URL  ────────▶ HTTP to 127.0.0.1:9400
│  Bash: browse-multi --name a1 text      ────────▶ HTTP to 127.0.0.1:9400
│                                              │
└─────────────────────────────────────────────┘
                                                         │
┌─────────────────────────────────────────────┐          │
│  Outside sandbox (MCP server)                │          │
│                                              │          ▼
│  browse_start(name: "a1") ──▶ spawns ──▶ Chromium daemon on :9400
│  browse_stop(name: "a1")                     │
│  browse_status()                             │
└─────────────────────────────────────────────┘
```

### Setup

Register the MCP server with Claude Code:

```bash
claude mcp add browse-multi -- node /path/to/browse-multi/browse-multi-mcp.js
```

Then restart Claude Code. The MCP tools will be available immediately.

### Usage flow

1. **Start an instance** via MCP (outside sandbox):
   ```
   browse_start(name: "research")
   browse_start(name: "agent1", session: "/path/to/cookies.json", headed: true)
   ```

2. **Send commands** via Bash (inside sandbox):
   ```bash
   browse-multi --name research goto https://example.com
   browse-multi --name research text
   browse-multi --name research screenshot ./page.png
   ```

3. **Stop when done** via MCP:
   ```
   browse_stop(name: "research")
   browse_stop()  # stop all
   ```

### MCP tools

| Tool | Description |
|------|-------------|
| `browse_start` | Start a named Chromium instance (params: `name`, `session?`, `headed?`) |
| `browse_stop` | Stop an instance or all instances (params: `name?`) |
| `browse_status` | List all running instances with port, PID, and health |

## Architecture

```
                    ┌─────────────────────────┐
  CLI command ──────▶  browse-multi.js (client) │
                    └──────────┬──────────────┘
                               │ HTTP POST /command
                               ▼
                    ┌─────────────────────────┐
                    │ browse-multi-server.js   │  ← one per instance
                    │  (detached daemon)       │     port 9400-9420
                    │  ┌─────────────────┐     │
                    │  │ Chromium (PW)   │     │
                    │  └─────────────────┘     │
                    └─────────────────────────┘
```

**How it works:**

1. You run `browse-multi --name foo goto https://example.com`
2. The CLI checks if instance `foo` is already running (via state file in `~/.browse-multi/`)
3. If not, it allocates a port (9400-9420), spawns a detached server daemon, and waits for it to be ready
4. The CLI sends the command as an HTTP POST to the daemon
5. The daemon executes it against a real Chromium browser via Playwright
6. Result comes back as JSON, CLI prints it

Each daemon is fully independent -- its own Chromium process, its own port, its own auth token. Daemons auto-shutdown after 30 minutes of inactivity.

## Commands

### Navigation

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL (waits for DOM content loaded) |
| `back` | Go back in history |
| `reload` | Reload current page |
| `url` | Print current URL |

```bash
browse-multi --name a1 goto https://example.com
browse-multi --name a1 back
browse-multi --name a1 url
```

### Content

| Command | Description |
|---------|-------------|
| `text [--limit N]` | Extract page text (default limit: 50,000 chars) |
| `html [selector]` | Get innerHTML of element, or full page HTML |
| `snapshot [-i] [-s selector]` | Build DOM tree with @ref handles |
| `scroll [up\|down\|selector]` | Scroll viewport or element into view |

```bash
browse-multi --name a1 text
browse-multi --name a1 text --limit 5000
browse-multi --name a1 html ".main-content"
browse-multi --name a1 snapshot -i              # interactive elements only
browse-multi --name a1 snapshot -s "#sidebar"   # scoped to element
browse-multi --name a1 scroll                   # down one viewport
browse-multi --name a1 scroll up
browse-multi --name a1 scroll ".footer"         # scroll element into view
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

```bash
browse-multi --name a1 click @e3
browse-multi --name a1 fill "#email" "test@test.com"
browse-multi --name a1 press Enter
browse-multi --name a1 wait ".results" --timeout 30000
browse-multi --name a1 resize 375x812
```

### Inspection

| Command | Description |
|---------|-------------|
| `js <expression>` | Evaluate JavaScript expression |
| `eval` | Evaluate JavaScript from stdin (for multi-line code) |
| `console` | Show captured console messages (ring buffer, last 500) |
| `network` | Show captured network requests (ring buffer, last 500) |

```bash
browse-multi --name a1 js "document.title"
browse-multi --name a1 js "document.querySelector('.price').textContent"
echo 'document.querySelectorAll("a").length' | browse-multi --name a1 eval
browse-multi --name a1 console
browse-multi --name a1 network
```

### Visual

| Command | Description |
|---------|-------------|
| `screenshot [path]` | Take screenshot (default: `~/.browse-multi/browse-multi-screenshot-{name}.png`) |

```bash
browse-multi --name a1 screenshot
browse-multi --name a1 screenshot ./my-screenshot.png
```

### Tabs

| Command | Description |
|---------|-------------|
| `tabs` | List open tabs |
| `tab <id>` | Switch to tab by index |
| `newtab [url]` | Open new tab |
| `closetab [id]` | Close tab (defaults to current) |

```bash
browse-multi --name a1 newtab https://other.com
browse-multi --name a1 tabs
browse-multi --name a1 tab 0
browse-multi --name a1 closetab 1
```

### Session

| Command | Description |
|---------|-------------|
| `export-session` | Export cookies and storage state as JSON |
| `start [--session file] [--headed]` | Start instance without running a command |
| `stop` | Stop an instance |
| `stop --all` | Stop all instances |

```bash
browse-multi --name a1 export-session > session.json
browse-multi --name a1 start --session session.json
browse-multi --name a1 stop
browse-multi stop --all
```

### Meta

| Command | Description |
|---------|-------------|
| `status` | List all running instances with port, PID, health |
| `chain [--timeout ms]` | Execute multiple commands in sequence (JSON via stdin) |
| `help` | Show help |

```bash
browse-multi status
echo '[["goto","https://example.com"],["text"],["screenshot","./out.png"]]' | browse-multi --name a1 chain
```

## The @ref system

The `snapshot` command annotates DOM elements with `@ref` handles (`@e1`, `@e2`, ...) that you can use in place of CSS selectors for `click`, `fill`, and `hover`:

```bash
# Get interactive elements
$ browse-multi --name a1 snapshot -i
@e1  a "Home"
@e2  a "About"
@e3  input placeholder="Search..."
@e4  button "Submit"

# Click by ref
$ browse-multi --name a1 click @e4

# Fill by ref
$ browse-multi --name a1 fill @e3 "search query"
```

**Lifecycle:** Refs are assigned during `snapshot` and remain valid until any navigation (`goto`, `back`, `reload`), which clears them. Always re-snapshot after navigating.

**Flags:**
- `-i` -- interactive elements only (links, buttons, inputs, etc.)
- `-s <selector>` -- scope snapshot to a specific element

## Authenticated browsing

Import session cookies from an existing browser to access authenticated sites:

```bash
# 1. Export session from an authenticated browser
#    (e.g., from Playwright MCP, or use export-session from an already-logged-in instance)
browse-multi --name login goto https://mysite.com
# ... log in manually in headed mode ...
browse-multi --name login export-session > mysite-session.json
browse-multi --name login stop

# 2. Start new instances with the session
browse-multi --name agent1 start --session mysite-session.json
browse-multi --name agent1 goto https://mysite.com/dashboard
```

The `--session` flag only applies when starting a new instance. To refresh expired sessions, stop the instance and start again with an updated session file.

## Headed mode

Add `--headed` to see the browser window:

```bash
browse-multi --name debug --headed goto https://example.com
```

On macOS, browser windows are automatically sent to background after launch so they don't steal focus. Bring them forward via Cmd+Tab when needed.

## Concurrency

Each `--name` gets its own Chromium process with its own port (range 9400-9420, up to 21 concurrent instances). Instances are fully isolated -- different pages, different cookies, different state.

```bash
# Three agents browsing simultaneously
browse-multi --name agent1 goto https://site-a.com &
browse-multi --name agent2 goto https://site-b.com &
browse-multi --name agent3 goto https://site-c.com &
wait
```

**Rules:**
- Never share a `--name` between concurrent agents
- Each instance uses ~100-200MB RAM
- If you run out of ports, use `browse-multi status` to find idle instances and stop them

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

Port and token are stored in the state file at `~/.browse-multi/browse-multi-{name}.json`.

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `BROWSE_MULTI_STATE_DIR` | `~/.browse-multi` | Directory for state files, logs, and default screenshots |

## Troubleshooting

**"No free ports"** -- Too many instances running. Run `browse-multi status` and stop idle ones.

**"Server failed to start"** -- Check logs at `~/.browse-multi/browse-multi-{name}.log` (or `$BROWSE_MULTI_STATE_DIR`).

**"@eN not found"** -- Refs are stale. Run `snapshot` again after any navigation.

**Stale instances** -- `browse-multi status` auto-cleans dead instances.

**Instance won't stop** -- Kill the process manually. Check PID in `~/.browse-multi/browse-multi-{name}.json`.

**Auth not working** -- Session cookies may have expired. Re-export and restart the instance with a fresh session file.

**Sandbox blocking Chromium** -- Use the MCP server to start instances from outside the sandbox. HTTP commands to running instances work fine from within sandboxed environments.

## Requirements

- Node.js >= 18
- Chromium is installed automatically via `npm install` (postinstall script runs `npx playwright install chromium`)

## License

MIT
