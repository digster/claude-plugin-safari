# Prompts

## 2026-03-16 — Initial Implementation

Build a Safari Web Extension that lets the user configure a text prefix (e.g., "Summarize"), and on click combines it with the current tab's URL to run `claude -p "Summarize https://abc.com"`. The output is displayed in the browser.

Architecture follows the existing `safari-plugin-random-raindrop-url` project — Manifest V3 extension scaffolded with `xcrun safari-web-extension-converter`, wrapped in a macOS app container.

Key difference: This extension needs to execute a local CLI binary (`/Users/ishan/.local/bin/claude`) via `Process()` in Swift, which requires disabling the App Sandbox on the extension target.

UI: Popup panel (primary) with pop-out tab (for long responses). Dark theme, Linear-inspired design.

## 2026-03-17 — Fix Safari Extension Not Appearing in Preferences

The extension builds successfully but doesn't appear in Safari → Settings → Extensions. Root cause: `ENABLE_APP_SANDBOX = NO` on the extension target — Safari requires sandboxed extensions.

Fix:
1. Enable app sandbox on extension target (`ENABLE_APP_SANDBOX = YES`)
2. Replace `Process()` (blocked by sandbox) with `NSUserUnixTask` + helper shell script
3. Helper script (`run-claude.sh`) installed via `NSSavePanel` to `~/Library/Application Scripts/<bundle-id>/`
4. Update deployment target from 10.14 to 14.0
5. Add script setup flow to the containing app's ViewController
