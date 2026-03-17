# Architecture — Claude Assistant Safari Extension

## Overview

A Safari Web Extension that bridges the browser to a local Claude CLI binary. The user configures a text prefix (e.g., "Summarize"), clicks the toolbar icon, and the extension combines the prefix with the current tab's URL to run `claude -p "<prefix> <url>"`. The output is displayed in a popup panel or a full-page pop-out tab.

## Component Diagram

```
┌─────────────┐    runtime.sendMessage    ┌──────────────┐    sendNativeMessage    ┌───────────────────────────────┐
│  popup.js   │ ────────────────────────> │ background.js│ ──────────────────────> │ SafariWebExtensionHandler.swift│
│  (UI)       │ <──────────────────────── │ (router)     │ <────────────────────── │ (NSUserUnixTask → helper script│
│             │                           │              │                         │  → claude CLI)                 │
└─────────────┘                           └──────┬───────┘                         └───────────────────────────────┘
                                                 │
┌─────────────┐    runtime.sendMessage          │ browser.storage.local
│ settings.js │ ────────────────────────>       │
│ (config)    │ <────────────────────────       ▼
└─────────────┘                           ┌──────────────┐
                                          │   Storage    │
┌─────────────┐    reads from storage     │ - settings   │
│ result.js   │ ────────────────────>     │ - lastResult │
│ (pop-out)   │                           │ - history    │
└─────────────┘                           └──────────────┘
```

## Key Components

### Extension Layer (JavaScript)

| File | Purpose |
|------|---------|
| `extension/background.js` | Central message router. Handles all actions (`runClaude`, `getSettings`, `saveSettings`, `verifyCli`, etc.). Bridges to native handler via `browser.runtime.sendNativeMessage()`. Stores results for recovery. |
| `extension/popup/popup.js` | Toolbar popup UI. Shows prefix + URL preview, "Ask Claude" button, loading state with elapsed timer, result display with copy/pop-out. |
| `extension/settings/settings.js` | Configuration page. Prefix textarea, CLI path input with verify button. |
| `extension/result/result.js` | Full-page pop-out for long responses. Loads last result from storage, renders with markdown. |

### Native Layer (Swift)

| File | Purpose |
|------|---------|
| `SafariWebExtensionHandler.swift` | Receives `sendNativeMessage` calls from JS. Two actions: `runClaude` (uses `NSUserUnixTask` to execute a helper script that invokes the CLI) and `verifyCli` (checks if the helper script is installed). Runs sandboxed. |
| `ViewController.swift` | App container UI — shows extension enable status, links to Safari preferences. Handles helper script installation via `NSSavePanel` to `~/Library/Application Scripts/<extension-bundle-id>/`. |
| `run-claude.sh` (installed) | Helper script placed in Application Scripts dir. Runs **outside** the sandbox via `NSUserUnixTask`. Sets up `PATH`/`HOME` env and `exec`s the Claude CLI binary. |
| `AppDelegate.swift` | Standard app delegate, terminates after last window closes. |

### Data Flow

1. User clicks extension icon → `popup.js` loads, queries active tab URL
2. User clicks "Ask Claude" → `popup.js` sends `runClaude` message to `background.js`
3. `background.js` reads settings, builds prompt string, calls `browser.runtime.sendNativeMessage()`
4. `SafariWebExtensionHandler.swift` receives message, runs `run-claude.sh` via `NSUserUnixTask` with args `[cliPath, prompt, outputFormat]`
5. Helper script executes `claude -p "<prompt>" --output-format json` outside the sandbox; output piped back to handler → `background.js` → stored in `browser.storage.local` → sent to `popup.js`
6. `popup.js` renders result, shows metadata (cost, tokens, duration)

### Storage Schema

```javascript
{
  settings: {
    prefix: "Summarize",          // Prompt prefix text
    cliPath: "/path/to/claude"    // CLI binary location
  },
  lastResult: {
    status: "running" | "complete" | "error",
    prompt: "Summarize https://...",
    url: "https://...",
    startTime: 1234567890,
    endTime: 1234567899,
    response: { result: "...", cost_usd: 0.01, ... }
  },
  history: [
    { prompt: "...", url: "...", timestamp: 123, resultPreview: "..." }
  ]
}
```

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Persistent background script (not service worker) | Safari's service worker support for extensions is unreliable — proven by reference project experience |
| Popup as primary UI | No content script injection needed, avoids CSP issues on arbitrary sites, minimal permissions |
| App Sandbox **enabled** on both targets | Safari requires sandboxed extensions to appear in preferences. CLI execution uses `NSUserUnixTask` + a helper script installed in Application Scripts, which runs outside the sandbox |
| Helper script installed via NSSavePanel | The containing app uses `NSSavePanel` to get user authorization to write `run-claude.sh` into `~/Library/Application Scripts/<extension-bundle-id>/` — Apple's recommended pattern for sandboxed script installation |
| `--output-format json` from CLI | Structured response includes cost, token counts, duration for richer UI metadata |
| `lastResult` stored in `browser.storage.local` | If popup closes during a long-running CLI call, the background continues and the result is recoverable |
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
