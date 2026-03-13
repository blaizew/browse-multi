---
name: browse-multi
description: |
  Concurrent browser automation via persistent headless Chromium daemons with CLI interface.
  Each agent gets its own named instance (~200ms/command after first call).
  Use when an agent or sub-agent needs to browse the web, scrape a page, interact with a site,
  fill forms, take screenshots, or extract content — especially when multiple agents need to
  browse concurrently. Triggers on: "browse this site," "scrape this page," "navigate to,"
  "check this URL," "take a screenshot of," "fill out this form," "read this page," or any
  task where a sub-agent needs web access beyond what WebFetch provides (JS-heavy sites,
  authenticated pages, multi-step interactions). Also use when spawning parallel research
  agents that each need their own browser.
  Do NOT use for: simple URL fetching where WebFetch works (static pages, APIs), interactive
  browsing where the user is driving (use Playwright MCP instead).
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
- A sub-agent needs to browse a JS-heavy or authenticated website
- Multiple agents need concurrent browser access (each gets its own instance)
- You need to interact with a page: click buttons, fill forms, navigate flows
- WebFetch fails or returns incomplete content (JS rendering required)
- You need screenshots, DOM snapshots, or console/network inspection

**Don't use when:**
- A simple `WebFetch` can get the content (static HTML, public APIs)
- The user is interactively browsing — use Playwright MCP instead
- You just need to download a file — use `curl` or `WebFetch`

## Setup

The MCP server is registered automatically by the plugin. Chromium is installed
via `npm install` (postinstall script). No manual configuration needed.

**Why MCP is required:** Claude Code runs Bash commands inside a macOS Seatbelt
sandbox that blocks Chromium from launching (Mach port registration is denied).
The MCP server runs outside the sandbox and handles instance lifecycle (start/stop).
Once running, all browse commands go through Bash as HTTP requests to 127.0.0.1 —
which works fine from inside the sandbox.

## Usage

### Step 1: Start an instance via MCP

```
mcp__browse-multi__browse_start(name: "myagent")
mcp__browse-multi__browse_start(name: "myagent", session: "/path/to/cookies.json", headed: true)
```

### Step 2: Send commands via Bash

```bash
browse-multi --name myagent goto https://example.com
browse-multi --name myagent text
browse-multi --name myagent screenshot ./page.png
```

Or use a shorthand:
```bash
BM="browse-multi --name myagent"
$BM goto https://example.com
$BM snapshot -i
$BM click @e3
```

### Step 3: Stop when done

```
mcp__browse-multi__browse_stop(name: "myagent")
mcp__browse-multi__browse_stop()  # stop all
mcp__browse-multi__browse_status()
```

**`--name` is required** for all commands except `status` and `help`.
Each agent MUST use a unique name (e.g., `--name agent-1`, `--name research`).

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

# Session export
$BM export-session > ~/session.json

# Instance management
browse-multi status                    # all running instances
browse-multi --name a1 stop            # stop one
browse-multi stop --all                # stop all
```

## @ref Lifecycle

`snapshot` assigns @e1, @e2, etc. to elements. These refs are valid until
navigation (`goto`, `back`, `reload`), which clears them. Always re-snapshot
after navigating.

## Session Import (Authenticated Browsing)

**IMPORTANT:** browse-multi instances do NOT inherit Playwright MCP's login sessions
automatically. Before spawning sub-agents that need to browse authenticated sites,
the master agent MUST export session cookies and pass them explicitly.

### Automatic export workflow (master agent responsibility)

Before launching sub-agents that will browse authenticated sites:

1. **Check if a session file already exists** for the target site:
   ```bash
   ls *-session.json
   ```

2. **If no session file exists, export it from Playwright MCP:**
   ```
   mcp__playwright__browser_navigate(url: "https://target-site.com")
   mcp__playwright__browser_run_code(code: "async (page) => { const state = await page.context().storageState(); return JSON.stringify(state); }")
   ```
   Then save the output to a session file (e.g., `<site>-session.json`) using the Write tool.

3. **Pass the session file when starting browse-multi for sub-agents:**
   ```
   mcp__browse-multi__browse_start(name: "agent-name", session: "/path/to/<site>-session.json")
   ```

4. **Include in sub-agent prompts:**
   > For browsing <site>, the browse-multi instance "agent-name" is already started
   > with session cookies. Use `browse-multi --name agent-name <command>` via Bash.

If a session file is missing or auth fails, export a fresh one using the workflow above.

### Manual login workflow

Alternatively, log in manually in headed mode and export the session:

```bash
browse-multi --name login --headed goto https://mysite.com
# ... log in in the browser window ...
browse-multi --name login export-session > mysite-session.json
browse-multi --name login stop

# Start agents with the session
mcp__browse-multi__browse_start(name: "agent1", session: "mysite-session.json")
browse-multi --name agent1 goto https://mysite.com/dashboard
```

### Session lifecycle

`--session` only applies when the instance starts. To refresh expired sessions:
stop the instance and start again with an updated session file.

**Known limitations:**
- Fingerprint-based auth (device binding, TLS fingerprinting) may not transfer.
  Cookie-based auth (most sites) works fine.
- Some sites with aggressive bot detection can invalidate sessions after certain
  interactions (scrolling, rapid navigation). Initial page loads work reliably.

## Concurrency

Each `--name` gets its own Chromium instance. Multiple agents can browse
simultaneously with different names. Port range: 9400-9420 (up to 21 instances).

**Never share a `--name` between agents.** Each agent must use its own unique name.

## Troubleshooting

- **"No free ports"** — Too many instances. Run `browse-multi status` and stop idle ones.
- **"Server failed to start"** — Check `~/.browse-multi/browse-multi-{name}.log`.
- **"@eN not found"** — Refs are stale. Run `snapshot` again after navigation.
- **Stale state files** — `browse-multi status` auto-cleans dead instances.
- **Auth not working** — Session cookies may have expired. Re-export and restart.
