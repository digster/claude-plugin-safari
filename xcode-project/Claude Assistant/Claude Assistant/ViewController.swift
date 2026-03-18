//
//  ViewController.swift
//  Claude Assistant
//
//  Created by Ishan on 16-03-2026.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.digster.Claude-Assistant.Extension"

/// Helper script content that bridges the sandboxed extension to the CLI binary.
/// The script runs outside the sandbox via NSUserUnixTask, allowing it to exec the Claude CLI.
/// v3: PID tracking for cancellation support. Runs claude as a background child, writes PID
/// to /tmp/claude-assistant.pid, and waits. A --cancel flag reads the PID and kills the process.
/// Still uses shift 3 + "$@" for backward compatibility checks.
private let helperScriptContent = """
#!/bin/bash
# Helper script for Claude Assistant Safari Extension (v3)
# Supports PID tracking for cancellation.
# Cancel mode: run-claude.sh --cancel
# Normal mode: run-claude.sh <cli_path> <prompt> <format> [extra flags...]

PID_FILE="/tmp/claude-assistant.pid"

# Cancel mode — kill the running process and exit
if [ "$1" = "--cancel" ]; then
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill -TERM "$PID" 2>/dev/null
    rm -f "$PID_FILE"
  fi
  exit 0
fi

export HOME="$HOME"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"
CLI="$1"; PROMPT="$2"; FORMAT="$3"
shift 3

# Clean up PID file on exit (normal completion or signal)
trap 'rm -f "$PID_FILE"' EXIT

# Run CLI as background child and track its PID for cancellation
"$CLI" -p "$PROMPT" --output-format "$FORMAT" "$@" &
CLAUDE_PID=$!
echo "$CLAUDE_PID" > "$PID_FILE"
wait "$CLAUDE_PID"
"""

/// Marker string used to detect whether the installed helper script supports extra CLI flags.
/// If the installed script doesn't contain this, the user needs to reinstall.
private let scriptVersionMarker = "shift 3"

/// Marker string for v3 cancel support detection.
/// If the installed script contains this, it supports --cancel mode.
private let cancelSupportMarker = "PID_FILE"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// Path to the extension's Application Scripts directory
    private var extensionScriptsPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Scripts/\(extensionBundleIdentifier)")
    }

    /// URL of the helper script within the extension's scripts directory
    private var helperScriptURL: URL {
        extensionScriptsPath.appendingPathComponent("run-claude.sh")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")
        self.webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Check extension enabled state
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else { return }

            DispatchQueue.main.async {
                // macOS 14.0+ always uses "Settings" terminology
                webView.evaluateJavaScript("show(\(state.isEnabled), true)")
            }
        }

        // Check if the helper script is installed and up-to-date (supports extra CLI flags)
        let scriptInstalled = FileManager.default.fileExists(atPath: helperScriptURL.path)
        var scriptUpToDate = false
        if scriptInstalled,
           let content = try? String(contentsOf: helperScriptURL, encoding: .utf8) {
            scriptUpToDate = content.contains(scriptVersionMarker)
        }
        DispatchQueue.main.async {
            webView.evaluateJavaScript("showSetupStatus(\(scriptInstalled), \(scriptUpToDate))")
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }

        switch body {
        case "open-preferences":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
                DispatchQueue.main.async {
                    NSApplication.shared.terminate(nil)
                }
            }
        case "install-script":
            installHelperScript()
        default:
            break
        }
    }

    // MARK: - Helper Script Installation

    /// Present NSSavePanel to let the user authorize writing the helper script
    /// to the extension's Application Scripts directory. This is Apple's recommended
    /// approach for sandboxed apps to install user scripts.
    private func installHelperScript() {
        let panel = NSSavePanel()
        panel.directoryURL = extensionScriptsPath
        panel.nameFieldStringValue = "run-claude.sh"
        panel.message = "Save the helper script to enable Claude CLI access from the Safari extension."
        panel.prompt = "Install"
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false

        panel.begin { [weak self] response in
            guard let self = self, response == .OK, let url = panel.url else { return }

            do {
                try helperScriptContent.write(to: url, atomically: true, encoding: .utf8)

                // Make the script executable (chmod 755)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o755],
                    ofItemAtPath: url.path
                )

                DispatchQueue.main.async {
                    self.webView.evaluateJavaScript("showSetupStatus(true, true)")
                }
            } catch {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Installation Failed"
                    alert.informativeText = "Could not install the helper script: \(error.localizedDescription)"
                    alert.alertStyle = .critical
                    alert.runModal()
                }
            }
        }
    }
}
