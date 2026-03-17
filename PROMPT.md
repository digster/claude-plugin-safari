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
