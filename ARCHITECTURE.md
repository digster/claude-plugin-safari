# Architecture — Claude Assistant Safari Extension

## Overview

A Safari Web Extension that bridges the browser to a local Claude CLI binary. The user configures a text prefix (e.g., "Summarize"), clicks the toolbar icon, and the extension combines the prefix with the current tab's URL to run `claude -p "<prefix> <url>"`. The output is displayed in a popup panel or a full-page pop-out tab.

## Component Diagram

```
┌─────────────┐    runtime.sendMessage    ┌──────────────┐    sendNativeMessage    ┌───────────────────────────────┐
│  popup.js   │ ────────────────────────> │ background.js│ ──────────────────────> │ SafariWebExtensionHandler.swift│
│  (UI)       │ <──────────────────────── │ (router)     │ <────────────────────── │ (runs Process() → claude CLI) │
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
| `SafariWebExtensionHandler.swift` | Receives `sendNativeMessage` calls from JS. Two actions: `runClaude` (spawns `Process()` to execute CLI) and `verifyCli` (checks binary exists). Sets up environment (`PATH`, `HOME`) for CLI dependencies. |
| `ViewController.swift` | App container UI — shows extension enable status, links to Safari preferences. |
| `AppDelegate.swift` | Standard app delegate, terminates after last window closes. |

### Data Flow

1. User clicks extension icon → `popup.js` loads, queries active tab URL
2. User clicks "Ask Claude" → `popup.js` sends `runClaude` message to `background.js`
3. `background.js` reads settings, builds prompt string, calls `browser.runtime.sendNativeMessage()`
4. `SafariWebExtensionHandler.swift` receives message, spawns `Process()` with `claude -p "<prompt>" --output-format json`
5. Process output returned to `background.js` → stored in `browser.storage.local` → sent to `popup.js`
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
| App Sandbox disabled on extension target | `Process()` (subprocess creation) requires unsandboxed execution; personal tool, no App Store distribution needed |
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
3. Enable extension in Safari → Settings → Extensions
4. Extension target has `ENABLE_APP_SANDBOX = NO` to allow `Process()` execution
