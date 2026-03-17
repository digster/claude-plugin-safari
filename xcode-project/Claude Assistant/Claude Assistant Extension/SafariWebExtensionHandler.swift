//
//  SafariWebExtensionHandler.swift
//  Claude Assistant Extension
//
//  Handles native messages from the browser extension JS layer.
//  Supports two actions:
//    - runClaude: executes the Claude CLI via Process() and returns the output
//    - verifyCli: checks if the CLI binary exists at the given path
//

import SafariServices
import os.log
import Foundation

// Use os_log for compatibility with macOS 10.14+ deployment target
private let log = OSLog(subsystem: "com.digster.Claude-Assistant.Extension", category: "handler")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        // Extract the message dictionary from the JS layer
        let message: [String: Any]?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        } else {
            message = request?.userInfo?["message"] as? [String: Any]
        }

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

    /// Execute the Claude CLI binary with the given prompt and return the output.
    /// Runs on a background queue to avoid blocking the extension handler.
    private func handleRunClaude(context: NSExtensionContext, message: [String: Any]) {
        let cliPath = message["cliPath"] as? String ?? "/Users/ishan/.local/bin/claude"
        let prompt = message["prompt"] as? String ?? ""
        let outputFormat = message["outputFormat"] as? String ?? "json"

        // Verify the CLI binary exists before attempting execution
        guard FileManager.default.isExecutableFile(atPath: cliPath) else {
            sendResponse(context: context, data: [
                "error": "Claude CLI not found at \(cliPath). Update the path in Settings."
            ])
            return
        }

        // Run on a background queue since CLI execution can take time
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            do {
                let result = try self.executeProcess(
                    path: cliPath,
                    arguments: ["-p", prompt, "--output-format", outputFormat]
                )

                // Try to parse JSON output from Claude CLI
                if outputFormat == "json",
                   let jsonData = result.data(using: .utf8),
                   let jsonObj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                    self.sendResponse(context: context, data: jsonObj)
                } else {
                    // Return raw text output
                    self.sendResponse(context: context, data: ["result": result])
                }
            } catch {
                os_log(.error, log: log, "Claude CLI execution failed: %{public}@", error.localizedDescription)
                self.sendResponse(context: context, data: [
                    "error": "CLI execution failed: \(error.localizedDescription)"
                ])
            }
        }
    }

    // MARK: - Verify CLI

    /// Check if the CLI binary exists and is executable at the given path.
    private func handleVerifyCli(context: NSExtensionContext, message: [String: Any]) {
        let cliPath = message["cliPath"] as? String ?? "/Users/ishan/.local/bin/claude"
        let exists = FileManager.default.isExecutableFile(atPath: cliPath)

        sendResponse(context: context, data: [
            "exists": exists,
            "path": cliPath
        ])
    }

    // MARK: - Process Execution

    /// Execute a command-line process and capture its stdout output.
    /// Sets up the environment so that Claude CLI can find its dependencies.
    private func executeProcess(path: String, arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments

        // Set environment variables so the CLI can find its dependencies
        var environment = ProcessInfo.processInfo.environment
        let homeDir = NSHomeDirectory()
        environment["HOME"] = homeDir
        environment["USER"] = NSUserName()

        // Ensure common binary paths are available
        let existingPath = environment["PATH"] ?? ""
        let additionalPaths = [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "\(homeDir)/.local/bin",
            "\(homeDir)/.nvm/versions/node/*/bin",  // Node.js via nvm
            "/usr/bin",
            "/bin"
        ]
        environment["PATH"] = (additionalPaths + [existingPath]).joined(separator: ":")
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        process.waitUntilExit()

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: outputData, encoding: .utf8) ?? ""

        // If the process failed, include stderr in the error
        if process.terminationStatus != 0 {
            let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
            let errorOutput = String(data: errorData, encoding: .utf8) ?? "Unknown error"
            throw NSError(
                domain: "ClaudeAssistant",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "Exit code \(process.terminationStatus): \(errorOutput)"]
            )
        }

        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Response Helper

    /// Send a response dictionary back to the JS layer.
    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: data]
        } else {
            response.userInfo = ["message": data]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
