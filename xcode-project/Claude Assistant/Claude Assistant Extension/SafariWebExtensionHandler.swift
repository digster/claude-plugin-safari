//
//  SafariWebExtensionHandler.swift
//  Claude Assistant Extension
//
//  Handles native messages from the browser extension JS layer.
//  Supports two actions:
//    - runClaude: executes the Claude CLI via NSUserUnixTask (sandbox-safe) and returns the output
//    - verifyCli: checks if the helper script is installed in Application Scripts
//

import SafariServices
import os.log
import Foundation

private let log = OSLog(subsystem: "com.digster.Claude-Assistant.Extension", category: "handler")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        // macOS 14.0+ — SFExtensionMessageKey is always available
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        os_log(.default, log: log, "Received native message: %{public}@", String(describing: message))

        guard let msg = message, let action = msg["action"] as? String else {
            sendResponse(context: context, data: ["error": "No action specified"])
            return
        }

        switch action {
        case "runClaude":
            handleRunClaude(context: context, message: msg)
        case "verifyCli":
            handleVerifyCli(context: context, message: msg)
        default:
            sendResponse(context: context, data: ["error": "Unknown action: \(action)"])
        }
    }

    // MARK: - Run Claude CLI

    /// Execute the Claude CLI via a helper shell script using NSUserUnixTask.
    /// The helper script lives in ~/Library/Application Scripts/<extension-bundle-id>/
    /// and runs outside the app sandbox, allowing it to invoke the CLI binary.
    private func handleRunClaude(context: NSExtensionContext, message: [String: Any]) {
        let cliPath = message["cliPath"] as? String ?? "/Users/ishan/.local/bin/claude"
        let prompt = message["prompt"] as? String ?? ""
        let outputFormat = message["outputFormat"] as? String ?? "json"
        let allowedTools = message["allowedTools"] as? [String] ?? []

        // Locate the Application Scripts directory for this extension
        guard let scriptsDir = try? FileManager.default.url(
            for: .applicationScriptsDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        ) else {
            sendResponse(context: context, data: [
                "error": "Cannot locate Application Scripts directory. Please run the Claude Assistant app to complete setup.",
                "setupRequired": true
            ])
            return
        }

        let scriptURL = scriptsDir.appendingPathComponent("run-claude.sh")

        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            sendResponse(context: context, data: [
                "error": "Helper script not installed. Please open the Claude Assistant app and click 'Install Helper Script'.",
                "setupRequired": true
            ])
            return
        }

        // If allowedTools are requested, verify the helper script supports extra args (v2)
        if !allowedTools.isEmpty {
            if let scriptContent = try? String(contentsOf: scriptURL, encoding: .utf8),
               !scriptContent.contains("shift 3") {
                sendResponse(context: context, data: [
                    "error": "Helper script is outdated and doesn't support --allowedTools. Please open the Claude Assistant app and click 'Reinstall Helper Script'.",
                    "setupRequired": true
                ])
                return
            }
        }

        do {
            let task = try NSUserUnixTask(url: scriptURL)

            // Set up pipes to capture stdout and stderr from the script
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            task.standardOutput = stdoutPipe.fileHandleForWriting
            task.standardError = stderrPipe.fileHandleForWriting

            // Build arguments: base args + --allowedTools flags for each tool
            var arguments = [cliPath, prompt, outputFormat]
            for tool in allowedTools {
                arguments.append("--allowedTools")
                arguments.append(tool)
            }

            os_log(.default, log: log, "Executing helper script with CLI path: %{public}@, allowedTools: %{public}@",
                   cliPath, allowedTools.joined(separator: ", "))

            task.execute(withArguments: arguments) { [weak self] error in
                guard let self = self else { return }

                // Close write ends so reads complete with EOF
                stdoutPipe.fileHandleForWriting.closeFile()
                stderrPipe.fileHandleForWriting.closeFile()

                if let error = error {
                    os_log(.error, log: log, "Helper script execution failed: %{public}@", error.localizedDescription)

                    let errorData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    let errorOutput = String(data: errorData, encoding: .utf8) ?? ""

                    self.sendResponse(context: context, data: [
                        "error": "CLI execution failed: \(error.localizedDescription). \(errorOutput)"
                    ])
                    return
                }

                let outputData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: outputData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

                // Try to parse JSON output from the Claude CLI
                if outputFormat == "json",
                   let jsonData = output.data(using: .utf8),
                   let jsonObj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                    self.sendResponse(context: context, data: jsonObj)
                } else {
                    self.sendResponse(context: context, data: ["result": output])
                }
            }
        } catch {
            os_log(.error, log: log, "Failed to create NSUserUnixTask: %{public}@", error.localizedDescription)
            sendResponse(context: context, data: [
                "error": "Failed to initialize helper script: \(error.localizedDescription)"
            ])
        }
    }

    // MARK: - Verify CLI Setup

    /// Check if the helper script is installed in the Application Scripts directory.
    /// In sandboxed mode, we cannot directly verify the CLI binary path —
    /// only whether the bridge script is in place.
    private func handleVerifyCli(context: NSExtensionContext, message: [String: Any]) {
        let cliPath = message["cliPath"] as? String ?? "/Users/ishan/.local/bin/claude"

        let scriptInstalled: Bool
        if let scriptsDir = try? FileManager.default.url(
            for: .applicationScriptsDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        ) {
            scriptInstalled = FileManager.default.fileExists(
                atPath: scriptsDir.appendingPathComponent("run-claude.sh").path
            )
        } else {
            scriptInstalled = false
        }

        sendResponse(context: context, data: [
            "exists": scriptInstalled,
            "path": cliPath,
            "setupRequired": !scriptInstalled
        ])
    }

    // MARK: - Response Helper

    /// Send a response dictionary back to the JS layer.
    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: data]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
