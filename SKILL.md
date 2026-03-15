---
name: browse-multi
description: |
  Concurrent browser automation via persistent headless Chromium daemons with CLI interface.
  Each agent gets its own named instance (~200ms/command after first call).
  DEFAULT tool for all agent browsing. Every agent and sub-agent that needs to browse
  the web MUST use browse-multi, not Playwright MCP. Playwright MCP is reserved for
  the user's interactive use only (logging in, exporting session cookies).
  Use when an agent or sub-agent needs to browse the web, scrape a page, interact with a site,
  fill forms, take screenshots, or extract content. Triggers on: "browse this site,"
  "scrape this page," "navigate to," "check this URL," "take a screenshot of,"
  "fill out this form," "read this page," or any task requiring web access beyond WebFetch.
  Do NOT use for: simple URL fetching where WebFetch works (static pages, APIs).
allowed-tools:
  - Bash
  - Read
---

# browse-multi — Concurrent Browser Automation

Persistent headless Chromium daemons accessed via CLI. Each agent gets its own
named instance. First call auto-starts the browser (~3s). Subsequent commands
~200ms. Auto-shuts down after 30 min idle.

## Routing

**Use when:**
- ANY agent or sub-agent needs to browse the web (this is the default, not Playwright MCP)
- A sub-agent needs to browse a JS-heavy or authenticated website
- Multiple agents need concurrent browser access (each gets its own instance)
- You need to interact with a page: click buttons, fill forms, navigate flows
- WebFetch fails or returns incomplete content (JS rendering required)
- You need screenshots, DOM snapshots, or console/network inspection

**Don't use when:**
- A simple `WebFetch` can get the content (static HTML, public APIs)
- The user is personally/interactively browsing — use Playwright MCP instead
- You just need to download a file — use `curl` or `WebFetch`

**Playwright MCP is for the user only** — logging into sites and exporting session
cookies. Agents must never call Playwright MCP tools directly.

**Inputs:** `--name <instance>` (required), `<command>` + args. Optional: `--session <file>` for auth, `--headless` for invisible browser.

**Output:** Command results to stdout (text, JSON, file paths). Screenshots to state directory.

**Edge cases:**
- If sandbox is enabled, use MCP tools to start instances (see Setup)
- Session cookies expire — re-login when auth fails
- Some sites' bot detection can invalidate sessions after scrolling/rapid navigation
- `@ref` handles go stale after any navigation — always re-snapshot

## Setup

The MCP server is registered automatically by the plugin. Chromium is installed
via `npm install` (postinstall script). No manual configuration needed.

**Why MCP is required:** Claude Code runs Bash commands inside a macOS Seatbelt
sandbox that blocks Chromium from launching (Mach port registration is denied).
The MCP server runs outside the sandbox and handles instance lifecycle (start/stop).
Once running, all browse commands go through Bash as HTTP requests to 127.0.0.1 —
which works fine from inside the sandbox.

**Sandbox constraint:** When the Bash sandbox is enabled, Chromium can't launch
(Mach port registration is blocked by Seatbelt). Use the browse-multi MCP tools
to start/stop instances — MCP servers run outside the sandbox:
```
mcp__browse-multi__browse_start(name: "myagent")
mcp__browse-multi__browse_start(name: "myagent", session: "~/.claude/sessions/x.com.json")
mcp__browse-multi__browse_stop(name: "myagent")
mcp__browse-multi__browse_stop()  # stop all
mcp__browse-multi__browse_status()
mcp__browse-multi__browse_login(url: "https://example.com/login")
mcp__browse-multi__browse_login_complete()  # save session + stop login instance
```
Once the server is running, all browse commands go through Bash as HTTP requests
(which work fine in the sandbox).

## Usage

All commands use this pattern:
```bash
browse-multi --name <instance> <command> [args...]

# Shorthand: set BM at the start of your session
BM="browse-multi --name myagent"
$BM goto https://example.com
$BM text
$BM screenshot
```

**`--name` is required** for all commands except `status` and `help`.
Each agent MUST use a unique name (e.g., `--name agent-1`, `--name research`).

## Session Management (Authenticated Browsing)

Sessions are stored in `~/.claude/sessions/<domain>.json` — a shared directory that
all agents can access. Session files contain Playwright `storageState` (cookies +
localStorage) and are named by domain (e.g., `x.com.json`, `threads.net.json`).

**Playwright MCP is NOT required for session management.** Browse-multi handles
login and export entirely on its own via headed browser instances.

### Agent workflow for authenticated browsing

1. **Check for existing session:**
   ```bash
   ls ~/.claude/sessions/<domain>.json
   ```

2. **If session exists, use it:**
   ```
   mcp__browse-multi__browse_start(name: "myagent", session: "~/.claude/sessions/<domain>.json")
   ```

3. **If session doesn't exist OR auth fails (redirect to login page, 401/403):**
   - Delete the stale session file if it exists
   - Trigger the login flow (see below)
   - Retry with the new session

### Login flow (two MCP calls)

When a session is missing or expired:

1. **Open a headed browser for the user:**
   ```
   mcp__browse-multi__browse_login(url: "https://example.com/login")
   ```
   This starts a visible Chromium window and navigates to the URL.

2. **Ask the user to log in** (via AskUserQuestion or direct message).

3. **Save the session and close the browser:**
   ```
   mcp__browse-multi__browse_login_complete()
   ```
   This exports cookies, saves to `~/.claude/sessions/<domain>.json`, and stops
   the headed instance. The domain is auto-extracted from the current page URL.

### CLI equivalent

```bash
# Step 1: Open headed browser (auto-names instance login-<domain>)
browse-multi login https://example.com/login

# Step 2: User logs in...

# Step 3: Save session to ~/.claude/sessions/<domain>.json and stop
browse-multi --name login-example.com save-session
browse-multi --name login-example.com stop
```

Or save a session from any running instance:
```bash
$BM save-session              # auto-detects domain from current URL
$BM save-session example.com  # explicit domain override
```

### Available sessions

Check what's available:
```bash
ls ~/.claude/sessions/
```

### Starting instances with session files

```
mcp__browse-multi__browse_start(name: "myagent", session: "~/.claude/sessions/x.com.json")
```

`--session` only applies when the instance starts. To refresh expired sessions:
stop the instance, re-login, and start again with the updated session file.

### Auth failure detection

After navigating to a page that requires auth, check if you were redirected:
```bash
$BM url   # Did you end up on a login page instead of the expected page?
```
Common signals: URL contains `/login`, `/signin`, `/auth`, or the page text includes
"sign in" / "log in" prompts. On 401/403 responses, check `$BM network`.

**Known limitations:**
- Fingerprint-based auth (device binding, TLS fingerprinting) may not transfer.
  Cookie-based auth (most sites) works fine.
- Some sites with aggressive bot detection can invalidate sessions after certain
  interactions (scrolling, rapid navigation). Initial page loads work reliably.

## Headed / Headless Mode

All instances are **headed by default** (visible Chromium window) so the user can
monitor agent activity. On macOS, non-login windows are automatically sent to the
background after launch (~1.5s) so they don't steal focus. Bring them forward via
Cmd+Tab or Mission Control when you want to watch.

Add `--headless` for invisible background browsing:
```bash
$BM --headless goto https://example.com
```

## Quick Reference

```bash
# Navigate and read
$BM goto https://example.com
$BM text                          # cleaned page text (default 50K char limit)
$BM text --limit 5000             # custom limit
$BM html ".main-content"          # innerHTML of element
$BM url                           # current URL

# Interact via snapshot refs
$BM snapshot -i                   # interactive elements with @refs
$BM click @e3                     # click by ref
$BM fill @e4 "test@test.com"     # fill by ref
$BM press Enter

# Interact via CSS selectors
$BM click "button.submit"
$BM fill "#email" "test@test.com"
$BM select "#country" "US"
$BM hover ".menu-trigger"
$BM wait ".loaded"                # wait max 10s
$BM wait ".loaded" --timeout 30000

# Scroll
$BM scroll                       # down one viewport
$BM scroll up                    # up one viewport
$BM scroll ".section"            # element into view

# Screenshot
$BM screenshot                    # default: ~/.browse-multi/browse-multi-screenshot-{name}.png
$BM screenshot /path/to/file.png

# JavaScript
$BM js "document.title"
$BM js "document.querySelector('.price').textContent"
echo 'document.querySelectorAll("a").length' | $BM eval

# Inspect
$BM console                      # captured console messages
$BM network                      # captured network requests

# Tabs
$BM tabs                         # list open tabs
$BM newtab https://other.com     # open new tab
$BM tab 0                        # switch back to first tab
$BM closetab 1                   # close second tab

# Multi-step chain (pipe JSON via stdin)
echo '[["goto","https://example.com"],["snapshot","-i"],["click","@e1"]]' | $BM chain

# Session management
$BM save-session                   # export + save to ~/.claude/sessions/<domain>.json
$BM save-session example.com       # explicit domain override
$BM export-session                 # raw JSON to stdout (legacy)
browse-multi login https://example.com  # headed login flow

# Instance management
browse-multi status                    # all running instances
browse-multi --name a1 stop            # stop one
browse-multi stop --all                # stop all
```

## @ref Lifecycle

`snapshot` assigns @e1, @e2, etc. to elements. These refs are valid until
navigation (`goto`, `back`, `reload`), which clears them. Always re-snapshot
after navigating.

## Concurrency

Each `--name` gets its own Chromium instance. Multiple agents can browse
simultaneously with different names. Port range: 9400-9420 (up to 21 instances).

**Never share a `--name` between agents.** Each agent must use its own unique name.

## Playwright MCP Coexistence

This CLI runs alongside Playwright MCP, not replacing it:
- **Playwright MCP** — interactive sessions (user driving), single instance
- **browse-multi** — agent automation, concurrent instances, session import

## Troubleshooting

- **"No free ports"** — Too many instances. Run `status` and `stop` idle ones.
- **"Server failed to start"** — Check `~/.browse-multi/browse-multi-{name}.log`.
- **"@eN not found"** — Refs are stale. Run `snapshot` again after navigation.
- **Stale state files** — `status` auto-cleans dead instances.
- **Instance won't stop** — Kill the process: check PID in `~/.browse-multi/browse-multi-{name}.json`.
- **Auth not working** — Re-login via `browse_login` flow when auth fails.
