# Prompts

## 2026-03-16 — Initial Implementation

Build a Safari Web Extension that lets the user configure a text prefix (e.g., "Summarize"), and on click combines it with the current tab's URL to run `claude -p "Summarize https://abc.com"`. The output is displayed in the browser.

Architecture follows the existing `safari-plugin-random-raindrop-url` project — Manifest V3 extension scaffolded with `xcrun safari-web-extension-converter`, wrapped in a macOS app container.

Key difference: This extension needs to execute a local CLI binary (`/Users/ishan/.local/bin/claude`) via `Process()` in Swift, which requires disabling the App Sandbox on the extension target.

UI: Popup panel (primary) with pop-out tab (for long responses). Dark theme, Linear-inspired design.

## 2026-03-17 (session 1) — Fix Safari Extension Not Appearing in Preferences

The extension builds successfully but doesn't appear in Safari → Settings → Extensions. Root cause: `ENABLE_APP_SANDBOX = NO` on the extension target — Safari requires sandboxed extensions.

Fix:
1. Enable app sandbox on extension target (`ENABLE_APP_SANDBOX = YES`)
2. Replace `Process()` (blocked by sandbox) with `NSUserUnixTask` + helper shell script
3. Helper script (`run-claude.sh`) installed via `NSSavePanel` to `~/Library/Application Scripts/<bundle-id>/`
4. Update deployment target from 10.14 to 14.0
5. Add script setup flow to the containing app's ViewController

## 2026-03-17 (session 2) — Pre-authorize CLI Tools via `--allowedTools`

The extension runs Claude CLI headlessly (no TTY). When Claude needs interactive permission to use tools like `WebFetch`, it responds with "please approve in your terminal" but there's no terminal.

Fix: Pass `--allowedTools` to the CLI to pre-authorize tools. Changes:
1. Update helper script to forward extra args via `shift 3` + `"$@"`
2. Parse `allowedTools` from settings (comma-separated) → array in native message
3. Build `--allowedTools <tool>` args in Swift handler
4. Add Allowed Tools setting to settings UI
5. Add script version detection (outdated script → reinstall notice)
6. Add tests for allowedTools parsing and payload

## 2026-03-17 (session 3) — Fix URL-Specific Cache in Popup

The popup displays the cached `lastResult` from a previous URL even when the user navigates to a different page. The `lastResult` object already stores a `url` field (set by `runClaude()` in background.js), but the popup never validates it against the current tab's URL before displaying.

Fix:
1. Add URL guard to cached result restore: `if (lastResult && lastResult.url === currentUrl)`
2. Add URL guard to `pollForResult()`: early-return when result URL doesn't match current tab URL

## 2026-03-17 (session 5) — Fix sendMessage: Loader and "Ask Claude" Not Working

The "Ask Claude" button doesn't show a loader and doesn't function. Root cause: `browser.runtime.sendMessage(message, resolve)` — Safari's `browser.*` MV3 API returns a Promise, the second arg is NOT a callback. The outer `new Promise` never resolves, so `DOMContentLoaded`'s `Promise.all` hangs and the button stays disabled.

Fix:
1. Replace callback-based `sendMessage` with Promise-based `async function sendMessage(msg)` in all 3 extension files (popup.js, settings.js, result.js)
2. Add try/catch to popup.js `DOMContentLoaded` to surface initialization errors
3. Add else branch to click handler for null/unexpected results
4. Add null check to settings.js save handler
5. Add `.catch()` to background.js message handler chain
6. Update popup test mocks from callback to Promise pattern, add 3 new tests

## 2026-03-17 (session 6) — Fix Storage Quota Exceeded Error: Native Disk Storage

Safari MV3 extensions have a ~5MB `browser.storage.local` quota. Storing full Claude CLI responses (10-100KB+) in `lastResult` exceeded this limit. Solution: move `lastResult` storage to native disk via the existing Swift `SafariWebExtensionHandler`, keep only small data (`settings`, `history`) in `browser.storage.local`.

Changes:
1. **SafariWebExtensionHandler.swift**: Add `storeResult`, `getStoredResult`, `clearStoredResult` actions + `storageDirectory()` helper. Writes to `<container>/Library/Application Support/ClaudeAssistant/lastResult.json`
2. **background.js**: Rewrite `saveLastResult`/`getLastResult` to use `sendNativeMessage` instead of `browser.storage.local`. Update `clearLastResult` handler similarly. Reduce history cap 50→25, preview 200→100 chars. Add `browser.storage.local.remove('lastResult')` migration in `onInstalled`
3. **tests/background.test.js**: Mock `sendNativeMessage` with in-memory disk store for storage actions. Update history cap test 50→25. Add error-handling tests for native message failures

## 2026-03-17 (session 7) — Fix Safari `browser.storage.local.get()` Failures Breaking Popup

After commit `575077b` (moved `lastResult` to native disk), two bugs:
1. **Cached content not showing** — `onInstalled` migration deleted old data without copying; re-processing also fails (bug 2), so no new cache written.
2. **`storageArea.get()` error on re-process** — `runClaude()` → `getSettings()` → `browser.storage.local.get('settings')` throws → popup shows error. Root cause: Safari MV3's `browser.storage.local` API failing, exacerbated by the un-awaited `browser.storage.local.remove('lastResult')` in `onInstalled`.

Fix: Wrap all `browser.storage.local` calls with try/catch + sensible fallbacks:
1. **`getSettings()`** — try/catch, fall back to `DEFAULT_SETTINGS`
2. **`saveSettings()`** — try/catch around `set()`, still returns merged settings
3. **`getHistory()`** — try/catch, fall back to `[]`
4. **`addToHistory()`** — try/catch around `set()`
5. **`onInstalled`** — `await` the `remove()` call, try/catch around both `get` and `remove`
6. **4 new tests** — storage failure fallbacks for `getSettings`, `getHistory`, `saveSettings`, `addToHistory`

## 2026-03-17 (session 8) — Fix Pop-out Page Empty + Cached Results Not Showing

Fix two bugs: (1) pop-out page (result.html) remains empty even when popup just displayed content, (2) cached result not restoring in popup when reopening for a previously-queried URL. Root cause: background.js message listener uses callback-based `sendResponse` + `return true` pattern unreliable in Safari MV3. Fix by switching to Promise-based listener, adding retry logic to result.js, and adding tests.

## 2026-03-17 (session 9) — Add Effort & Model Settings

Add two new optional settings that map to Claude CLI flags:
- **Effort** (`--effort <level>`) — text input, valid values: `low`, `medium`, `high`, `max`
- **Model** (`--model <model>`) — text input, accepts alias (`sonnet`, `opus`) or full name (`claude-sonnet-4-6`)

Both are optional — empty means "use CLI defaults, don't send the flag."

Changes:
1. **settings.html**: Add effort and model text inputs with placeholders and hint text
2. **settings.js**: Add DOM refs, load/save for `effort` and `model` fields
3. **background.js**: Add `effort: ''` and `model: ''` to `DEFAULT_SETTINGS`, include in native payload
4. **SafariWebExtensionHandler.swift**: Extract effort/model from message, append `--effort`/`--model` flags when non-empty, broaden v2 script check
5. **tests/background.test.js**: 10 new tests (defaults, save/load, non-clobbering, native payload inclusion)

## 2026-03-17 (session 10) — Per-URL Result Caching

The extension uses a singleton `lastResult.json` — when a new URL is processed, the previous URL's result is overwritten. Going back to a previously-processed URL finds no cache.

Fix: Store per-URL results in a `results/` subdirectory using SHA-256-hashed filenames. Keep `lastResult.json` as "most recent" pointer for pop-out view. Add LRU eviction (25 files max).

Changes:
1. **SafariWebExtensionHandler.swift**: Add `CryptoKit` import, `resultFileURL(for:)` SHA-256 helper, `evictOldResults()` LRU eviction, modify store/get/clear handlers to support per-URL cache
2. **background.js**: `getLastResult(url)` accepts optional URL param, forward URL in message handler for get/clear
3. **popup.js**: Remove `getLastResult` from initial `Promise.all`, fetch with URL after determining `currentUrl`, pass URL in poll requests
4. **tests/background.test.js**: Per-URL mock with `perUrl` map, isolation tests, payload verification, handler forwarding
5. **tests/popup.test.js**: Track `getLastResultMessages`, verify URL inclusion, update Test 2 for per-URL miss
6. **ARCHITECTURE.md**: Document `results/` directory structure and per-URL caching

## 2026-03-17 (session 11) — Clear All Cache + Fix Stale Fallback

Add "Clear All Cache" button in settings and fix stale-data fallback in Swift handler. When a per-URL cache lookup misses, `handleGetStoredResult` falls through to `lastResult.json` which may belong to a different URL. Fix: return null on per-URL miss. Add a settings button to nuke all cached results + history.

Changes:
1. **SafariWebExtensionHandler.swift**: Add `handleClearAllResults()` (deletes lastResult.json + all files in results/), fix `handleGetStoredResult` fallback (return null when URL provided but not found)
2. **background.js**: Add `clearAllCache()` function (native clear + history removal), message handler case, export
3. **settings.html/css/js**: Add "Clear All Cache" danger button with click handler
4. **tests/background.test.js**: Update mocks for no-fallback behavior, fix existing test, add 15 new tests
5. **ARCHITECTURE.md**: Document `clearAllResults` action and settings button
