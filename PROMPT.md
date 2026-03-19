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

## 2026-03-17 (session 12) — Add Stop Button to Cancel Running Requests

The Claude CLI can take many minutes (6+ min). Currently there's no way to cancel a running request — the user is stuck watching "Thinking... 6m 19s". Add a Stop button that kills the running CLI process and updates the UI immediately.

Approach: PID-based tracking in the helper script (v3). Instead of `exec` (which replaces the shell), run claude as a background child (`&`), write PID to `/tmp/claude-assistant.pid`, and `wait`. A `--cancel` flag reads the PID and kills the process.

Changes:
1. **ViewController.swift**: Update `helperScriptContent` to v3 with PID tracking + cancel mode, add `cancelSupportMarker` constant
2. **SafariWebExtensionHandler.swift**: Add `cancelClaude` action that runs helper script with `--cancel` arg (best-effort)
3. **background.js**: Add `cancelClaude(url)` (saves cancelled state first, then sends native kill), modify `runClaude()` to check for cancelled state after CLI completes (race condition handling), add message handler case
4. **popup.html**: Add stop button with stop-square SVG + cancelled status message area
5. **popup.css**: Stop button styles (red/danger), cancelled message styles (amber), loading layout restructured
6. **popup.js**: Wire stop button click handler, handle `cancelled` status in init/polling/click paths, add show/hideCancelled helpers
7. **tests/background.test.js**: 11 new tests (cancel state, native message, resilience, race conditions, message handler)
8. **tests/popup.test.js**: 4 new tests (stop button, cancelled init, cancelled polling, cancelled click handler)

## 2026-03-18 (session 1) — Green Dot Badge Notification on Toolbar Icon

Fetches can take 30+ seconds. When the user switches tabs or closes the popup, there's no visual indicator that the fetch completed. Add a green dot badge on the extension toolbar icon so the user can glance at it and know a result is ready without opening the popup.

Use `browser.action.setBadgeText()` / `browser.action.setBadgeBackgroundColor()` (available in Safari MV3, no extra permissions needed) with per-tab `tabId` to show a colored dot when a fetch finishes. Clear it when the popup is opened and the result is displayed.

Changes:
1. **background.js**: Add `urlToTabId` Map, `setBadge`/`clearBadge`/`clearBadgeForUrl` helpers, modify `runClaude(url, tabId)` and `cancelClaude(url)` for badge integration, add `clearBadge` message action, add `tabs.onUpdated`/`onRemoved` listeners for cleanup
2. **popup.js**: Capture `currentTabId` from active tab, send with `runClaude`, send `clearBadge` messages when displaying complete/error results (init, click, poll)
3. **tests/background.test.js**: Add `browser.action` mock, tab event listener mocks, 14 new badge test cases
4. **tests/popup.test.js**: Add `clearBadgeMessages`/`runClaudeMessages` tracking, add `id` to mock tabs, 5 new badge test cases

## 2026-03-18 (session 2) — Smaller Green Dot via Canvas Compositing

Safari's `setBadgeText(' ')` renders a large, fixed-size badge (~40% of icon). Replace with canvas-based icon compositing for a smaller, subtler dot (~15% of icon size) in the top-right corner.

Replace `setBadgeText`/`setBadgeBackgroundColor` with `setIcon({ imageData })`:
1. Load original icon PNGs (16px, 32px) into a canvas
2. Draw a small green circle in the top-right corner
3. Call `browser.action.setIcon({ imageData, tabId })` to apply per-tab
4. Cache generated `ImageData` so canvas work happens once per color
5. Popup sends single unconditional `clearBadge` with `tabId` on init (replaces per-branch URL-based clears)

## 2026-03-18 (session 4) — Cache Explorer + Remove LRU Eviction Cap

Add a full-page Cache Explorer (sidebar+detail view) for browsing all cached Claude results. Remove the 25-file LRU eviction cap since native disk has no meaningful size constraint.

Changes:
1. **SafariWebExtensionHandler.swift**: Add `listCachedResults` (lists all per-URL cache files sorted by modification date with metadata) and `deleteCachedResult` (deletes single file by URL via SHA-256 lookup) actions. Remove `evictOldResults()` method and its call from `handleStoreResult()`
2. **background.js**: Add `listCachedResults()`/`deleteCachedResult(url)` helper functions + message handler cases
3. **cache-explorer/**: NEW 3-file full-page (HTML/CSS/JS) with 300px sidebar listing all cached URLs (status dots, timestamps, cost) + detail panel showing full rendered markdown content with metadata. Copy/Delete/Clear All/Refresh functionality
4. **popup.html/js/css**: Add cache explorer icon button in header
5. **settings.html/css/js**: Add "Browse Cache" secondary button
6. **ARCHITECTURE.md/README.md**: Document new component and actions

## 2026-03-18 (session 5) — Fix Cache Explorer URL + Icon

The Cache Explorer page was added recently but was never registered in the Xcode project's build resources. When the button is clicked, Safari tries to load a URL pointing to a resource that doesn't exist in the bundled `.appex`, causing `NSURLErrorDomain error -1100`. Separately, the icon used for the Cache Explorer button is a square/columns icon instead of a list icon.

Fix:
1. **`project.pbxproj`**: Add 4 entries (PBXBuildFile, PBXFileReference, PBXGroup child, PBXResourcesBuildPhase) mirroring how `popup`/`settings` folders are registered
2. **`popup.html`**: Replace sidebar/columns SVG with bulleted list icon (3 circles + 3 horizontal bars)

## 2026-03-19 (session 1) — Export Cached Summaries as Markdown

Add export functionality to the Cache Explorer page. Two export modes: (1) single result — downloads as a `.md` file with metadata table + response content, (2) bulk export — creates a `.zip` archive containing individual `.md` files for all cached results. Uses vendored JSZip library (~97KB) placed in `extension/lib/`. Handles edge cases: error/cancelled results, empty responses, duplicate hostnames (deduplication suffix), invalid URLs (fallback filename). Register `lib/` folder in Xcode project so it's bundled into the `.appex`.

## 2026-03-18 (session 3) — Fix Spinner Hangs Forever After Canvas Badge Commit

Commit `c11862c` replaced `setBadgeText` with canvas-composited dot overlays. This introduced two critical bugs: (1) `setBadge()` changed from sync to async and all call sites in `runClaude()` were `await`ed — badge rendering now blocks result delivery; (2) `createDotIcon()` sets `img.src` before `onload`/`onerror` handlers, and in Safari's extension background page `safari-web-extension://` image loads may not fire events — hanging the Promise forever.

Fix:
1. Make all `setBadge()`/`clearBadgeForUrl()` calls in `runClaude()` fire-and-forget (no `await`)
2. Fix `createDotIcon()`: attach handlers before `img.src`, add `img.complete` check, add 3s timeout via `Promise.race`
3. Update `Image` mock in tests to fire `onload` from `src` setter (matches handler-before-src pattern), add microtask flushes for fire-and-forget badge assertions
