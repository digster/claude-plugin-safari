# Claude Assistant — Safari Extension

A Safari Web Extension that runs the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) on the current page URL with a configurable prompt prefix. Click the toolbar icon, hit "Ask Claude", and see the response right in the popup.

## Features

- **Configurable prefix prompt** — set it to "Summarize", "Explain", "Review the code at", or anything else
- **Popup panel** — compact dark UI showing prefix + URL, response with metadata (cost, tokens, duration)
- **Pop-out view** — open long responses in a full-page tab with better formatting
- **Result recovery** — if the popup closes while Claude is running, the result is preserved and shown when you reopen
- **History** — last 50 queries stored for reference
- **Copy to clipboard** — one-click copy of the response

## Requirements

- macOS 14.0+ (Sonoma)
- Safari 17+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed (default path: `~/.local/bin/claude`)
- Xcode 16+ (to build)

## Setup

1. **Build the Xcode project:**
   ```bash
   open "xcode-project/Claude Assistant/Claude Assistant.xcodeproj"
   ```
   Press `Cmd+R` to build and run.

2. **Enable the extension in Safari:**
   - Safari → Settings → Extensions
   - Check "Claude Assistant"
   - Grant the requested permissions

3. **Configure (optional):**
   - Click the extension icon → gear icon (or Safari → Settings → Extensions → Claude Assistant → Preferences)
   - Set your preferred prefix prompt
   - Verify the Claude CLI path

## Usage

1. Navigate to any webpage
2. Click the Claude Assistant toolbar icon
3. Review the prefix + URL preview
4. Click "Ask Claude"
5. View the response in the popup, or click "Pop Out" for a full-page view

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed component documentation.

```
popup.js  →  background.js  →  SafariWebExtensionHandler.swift  →  claude CLI
  (UI)        (router)           (Process() bridge)                  (local binary)
```

## Development

### Running tests

```bash
node tests/background.test.js
```

### Project structure

```
extension/           # Web extension source (JS, HTML, CSS)
├── background.js    # Message routing, storage, native messaging bridge
├── popup/           # Toolbar popup UI
├── settings/        # Configuration page
├── result/          # Full-page pop-out result view
└── icons/           # Extension icons
xcode-project/       # Generated Xcode project with Swift native handler
tests/               # Unit tests
```

## Important Notes

- The App Sandbox is **disabled** on the extension target to allow `Process()` execution of the Claude CLI. This means the extension cannot be distributed via the Mac App Store — it's designed as a personal developer tool.
- The extension uses `browser.runtime.sendNativeMessage()` to communicate with the Swift handler, which runs the CLI binary directly.

## License

MIT — see [LICENSE](LICENSE)
