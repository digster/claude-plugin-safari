# Architecture — Claude Assistant Safari Extension

## Overview

A Safari Web Extension that bridges the browser to a local Claude CLI binary. The user configures a text prefix (e.g., "Summarize"), clicks the toolbar icon, and the extension combines the prefix with the current tab's URL to run `claude -p "<prefix> <url>"`. The output is displayed in a popup panel or a full-page pop-out tab.

## Component Diagram

```
┌─────────────┐    runtime.sendMessage    ┌──────────────┐    sendNativeMessage    ┌───────────────────────────────┐
│  popup.js   │ ────────────────────────> │ background.js│ ──────────────────────> │ SafariWebExtensionHandler.swift│
│  (UI)       │ <──────────────────────── │ (router)     │ <────────────────────── │ (NSUserUnixTask → helper script│
│             │                           │              │                         │  → claude CLI)                 │
└─────────────┘                           └──────┬───────┘                         └──────────┬────────────────────┘
                                                 │                                            │
┌─────────────┐    runtime.sendMessage          │ browser.storage.local                      │ Native disk
│ settings.js │ ────────────────────────>       │                                            │
│ (config)    │ <────────────────────────       ▼                                            ▼
└─────────────┘                           ┌──────────────┐                       ┌────────────────────┐
                                          │   Storage    │                       │  Application Support│
┌─────────────┐    reads from storage     │ - settings   │                       │  /ClaudeAssistant/  │
│ result.js   │ ────────────────────>     │ - history    │                       │  - lastResult.json  │
│ (pop-out)   │                           └──────────────┘                       └────────────────────┘
└─────────────┘
```

## Key Components

### Extension Layer (JavaScript)

| File | Purpose |
|------|---------|
| `extension/background.js` | Central message router. Handles all actions (`runClaude`, `cancelClaude`, `clearBadge`, `getSettings`, `saveSettings`, `verifyCli`, etc.). Bridges to native handler via `browser.runtime.sendNativeMessage()`. Stores results for recovery. `cancelClaude` saves cancelled state to disk before sending the native kill signal (handles race conditions). Manages toolbar badge notifications via `browser.action.setBadgeText()`/`setBadgeBackgroundColor()` — green dot on complete, red dot on error, cleared when popup opens. Uses an in-memory `urlToTabId` Map for per-tab badge scoping. |
| `extension/popup/popup.js` | Toolbar popup UI. Shows prefix + URL preview, "Ask Claude" button, loading state with elapsed timer + Stop button, result display with copy/pop-out. Handles `cancelled` status in all restore paths (init, polling, click). Captures `tabId` from active tab and sends it with `runClaude` for badge scoping. Sends `clearBadge` messages when displaying complete/error results. |
| `extension/settings/settings.js` | Configuration page. Prefix textarea, CLI path input with verify button, allowed tools, effort level, model selection, and "Clear All Cache" button (nukes all disk cache + history). |
| `extension/result/result.js` | Full-page pop-out for long responses. Loads last result from storage, renders with markdown. |

### Native Layer (Swift)

| File | Purpose |
|------|---------|
| `SafariWebExtensionHandler.swift` | Receives `sendNativeMessage` calls from JS. Actions: `runClaude` (uses `NSUserUnixTask` to execute a helper script that invokes the CLI), `cancelClaude` (runs helper script with `--cancel` to kill the running process), `verifyCli` (checks if the helper script is installed), `storeResult`/`getStoredResult`/`clearStoredResult`/`clearAllResults` (disk-based result storage to bypass browser.storage.local quota). `getStoredResult` with a URL returns null on cache miss (no fallback to lastResult). Runs sandboxed. |
| `ViewController.swift` | App container UI — shows extension enable status, links to Safari preferences. Handles helper script installation via `NSSavePanel` to `~/Library/Application Scripts/<extension-bundle-id>/`. |
| `run-claude.sh` (installed) | Helper script (v3) placed in Application Scripts dir. Runs **outside** the sandbox via `NSUserUnixTask`. Normal mode: sets up `PATH`/`HOME` env, uses `shift 3` + `"$@"` to forward extra CLI flags, runs Claude as a background child process, writes PID to `/tmp/claude-assistant.pid`, and `wait`s. Cancel mode (`--cancel`): reads PID file and sends SIGTERM. Trap cleans up PID file on exit. |
| `AppDelegate.swift` | Standard app delegate, terminates after last window closes. |

### Data Flow

1. User clicks extension icon → `popup.js` loads, queries active tab URL
2. User clicks "Ask Claude" → `popup.js` sends `runClaude` message to `background.js`
3. `background.js` reads settings, builds prompt string, parses `allowedTools` (comma-separated → array), includes `effort` and `model` strings, calls `browser.runtime.sendNativeMessage()`
4. `SafariWebExtensionHandler.swift` receives message, builds argument list `[cliPath, prompt, outputFormat, --allowedTools, tool1, ..., --effort, level, --model, name]`, runs `run-claude.sh` via `NSUserUnixTask`. `--effort` and `--model` flags are only appended when non-empty.
5. Helper script (v2) uses `shift 3` + `"$@"` to forward extra CLI flags; executes `claude -p "<prompt>" --output-format json --allowedTools <tool> --effort <level> --model <name> ...` outside the sandbox; output piped back to handler → `background.js` → stored on native disk via `storeResult` action → sent to `popup.js`
6. `popup.js` renders result, shows metadata (cost, tokens, duration)

### Storage Schema

**browser.storage.local** (small data, ~5MB Safari quota):
```javascript
{
  settings: {
    prefix: "Summarize",          // Prompt prefix text
    cliPath: "/path/to/claude",   // CLI binary location
    allowedTools: "WebFetch,WebSearch", // Comma-separated tools pre-authorized via --allowedTools
    effort: "",                    // Effort level: "low", "medium", "high", "max" (empty = CLI default)
    model: ""                      // Model alias or full name: "sonnet", "opus", "claude-sonnet-4-6" (empty = CLI default)
  },
  history: [                       // Capped at 25 entries, 100-char previews
    { prompt: "...", url: "...", timestamp: 123, resultPreview: "..." }
  ]
}
```

**Native disk** (`<container>/Library/Application Support/ClaudeAssistant/`):
```
ClaudeAssistant/
├── lastResult.json          # Most-recent result pointer (used by pop-out view)
└── results/                 # Per-URL result cache (SHA-256-hashed filenames)
    ├── a1b2c3d4e5f6a7b8.json   # SHA-256(url)[:16] → cached result
    ├── f9e8d7c6b5a49382.json
    └── ...                     # LRU-evicted at 25 files max
```

Each file contains:
```javascript
{
  result: {
    status: "running" | "complete" | "error",
    prompt: "Summarize https://...",
    url: "https://...",
    startTime: 1234567890,
    endTime: 1234567899,
    response: { result: "...", cost_usd: 0.01, ... }
  }
}
```

`lastResult.json` is always written alongside the per-URL file so the pop-out view (`result.js`) can load the most recent result without knowing the URL. The popup always fetches by URL for cache hits when revisiting pages.

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Persistent background script (not service worker) | Safari's service worker support for extensions is unreliable — proven by reference project experience |
| Popup as primary UI | No content script injection needed, avoids CSP issues on arbitrary sites, minimal permissions |
| App Sandbox **enabled** on both targets | Safari requires sandboxed extensions to appear in preferences. CLI execution uses `NSUserUnixTask` + a helper script installed in Application Scripts, which runs outside the sandbox |
| Helper script installed via NSSavePanel | The containing app uses `NSSavePanel` to get user authorization to write `run-claude.sh` into `~/Library/Application Scripts/<extension-bundle-id>/` — Apple's recommended pattern for sandboxed script installation |
| `--output-format json` from CLI | Structured response includes cost, token counts, duration for richer UI metadata |
| `--allowedTools` pre-authorization | CLI runs headlessly (no TTY) so interactive permission prompts can't be answered. Tools like `WebFetch` are pre-authorized via `--allowedTools` to avoid blocking |
| `--effort` and `--model` flags | Optional CLI flags forwarded only when non-empty. Lets users control response quality/cost and model selection without editing the CLI directly |
| Helper script version detection | Containing app reads the installed script and checks for `"shift 3"` (v2+) and `"PID_FILE"` (v3 cancel support). Outdated scripts trigger a reinstall notice. The check triggers for any extra CLI flags (allowedTools, effort, or model) |
| PID-based request cancellation | v3 helper script runs Claude as a background child (`&`), writes PID to `/tmp/claude-assistant.pid`, and `wait`s. Cancel mode reads PID file and sends SIGTERM. JS saves `cancelled` status to disk *before* sending the kill signal — this handles the race where CLI completes before the kill arrives. The popup Stop button and all result-restore paths (init, polling, click handler) check for `cancelled` status |
| Toolbar badge notification | Uses `browser.action.setBadgeText(' ')` + `setBadgeBackgroundColor()` with per-tab `tabId` to show colored dots: green (#34C759) on complete, red (#FF3B30) on error. Cleared when popup opens and displays the result, or when a tab navigates/closes. In-memory `urlToTabId` Map (no persistence needed — background restart loses in-flight fetches anyway). Badge APIs wrapped in try/catch since they can fail if the tab was already closed |
| `lastResult` on native disk (not browser.storage.local) | Safari MV3 has a ~5MB `browser.storage.local` quota. Claude responses (10-100KB+) caused `Exceeded storage quota` errors. Result data now goes through `sendNativeMessage` → Swift handler → JSON file on disk. The extension's sandboxed Application Support directory is accessible without entitlements |
| Per-URL result cache (`results/` dir) | A singleton `lastResult.json` was overwritten on each new query — revisiting a previous URL found no cache. Now results are also stored in `results/<SHA256-hash>.json` keyed by URL. The popup passes the tab URL when fetching, hitting the per-URL cache. LRU eviction at 25 files (~2.5MB worst case) bounds disk usage. `lastResult.json` remains as a "most recent" pointer for the pop-out view |
| History capped at 25 entries, 100-char previews | Safeguard to keep `browser.storage.local` well within quota; history stays in browser storage since it's small |
| `browser.*` API (not `chrome.*`) in extension code | Safari's Manifest V3 uses the `browser` namespace; `chrome.*` works for some APIs but `browser` is canonical |

## Extension Permissions

- `storage` — persist settings, results, history
- `tabs` — query active tab URL
- `nativeMessaging` — bridge to Swift native handler
- `activeTab` — access current tab info on click

## Build & Run

1. The Xcode project is generated by `xcrun safari-web-extension-converter`
2. Build the "Claude Assistant" scheme in Xcode (`Cmd+R`)
3. Run the containing app → click "Install Helper Script" → save to the pre-selected location
4. Enable extension in Safari → Settings → Extensions
5. Both targets run with `ENABLE_APP_SANDBOX = YES`; CLI access is via `NSUserUnixTask`
