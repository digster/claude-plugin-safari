//
//  SafariWebExtensionHandler.swift
//  Claude Assistant Extension
//
//  Handles native messages from the browser extension JS layer.
//  Supports actions:
//    - runClaude: executes the Claude CLI via NSUserUnixTask (sandbox-safe) and returns the output
//    - verifyCli: checks if the helper script is installed in Application Scripts
//    - storeResult: writes a result dictionary to disk (bypasses browser.storage.local quota)
//    - getStoredResult: reads the stored result from disk
//    - clearStoredResult: deletes the stored result file
//

import SafariServices
import os.log
import Foundation
import CryptoKit

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
        case "storeResult":
            handleStoreResult(context: context, message: msg)
        case "getStoredResult":
            handleGetStoredResult(context: context, message: msg)
        case "clearStoredResult":
            handleClearStoredResult(context: context, message: msg)
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
        let effort = message["effort"] as? String ?? ""
        let model = message["model"] as? String ?? ""

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

        // If extra CLI flags are requested, verify the helper script supports extra args (v2)
        let needsExtraArgs = !allowedTools.isEmpty || !effort.isEmpty || !model.isEmpty
        if needsExtraArgs {
            if let scriptContent = try? String(contentsOf: scriptURL, encoding: .utf8),
               !scriptContent.contains("shift 3") {
                sendResponse(context: context, data: [
                    "error": "Helper script is outdated and doesn't support extra CLI flags. Please open the Claude Assistant app and click 'Reinstall Helper Script'.",
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

            // Build arguments: base args + optional CLI flags
            var arguments = [cliPath, prompt, outputFormat]
            for tool in allowedTools {
                arguments.append("--allowedTools")
                arguments.append(tool)
            }
            if !effort.isEmpty {
                arguments.append("--effort")
                arguments.append(effort)
            }
            if !model.isEmpty {
                arguments.append("--model")
                arguments.append(model)
            }

            os_log(.default, log: log, "Executing helper script with CLI path: %{public}@, allowedTools: %{public}@, effort: %{public}@, model: %{public}@",
                   cliPath, allowedTools.joined(separator: ", "), effort, model)

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

    // MARK: - Disk Storage for Results
    //
    // These handlers bypass browser.storage.local (which has a ~5MB Safari quota)
    // by writing result data directly to the extension's Application Support directory.
    // The sandboxed extension can freely access its own container's Application Support.

    /// Returns the storage directory URL, creating it if needed.
    /// Path: <container>/Library/Application Support/ClaudeAssistant/
    private func storageDirectory() -> URL? {
        guard let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }

        let storageDir = appSupport.appendingPathComponent("ClaudeAssistant")

        // Create directory if it doesn't exist
        if !FileManager.default.fileExists(atPath: storageDir.path) {
            do {
                try FileManager.default.createDirectory(
                    at: storageDir,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            } catch {
                os_log(.error, log: log, "Failed to create storage directory: %{public}@", error.localizedDescription)
                return nil
            }
        }

        return storageDir
    }

    /// Returns the per-URL result file path using SHA-256 hash of the URL.
    /// Creates the results/ subdirectory if needed.
    /// Path: <storageDir>/results/<first-16-hex-of-SHA256>.json
    private func resultFileURL(for url: String) -> URL? {
        guard let storageDir = storageDirectory() else { return nil }

        let resultsDir = storageDir.appendingPathComponent("results")

        // Create results/ subdirectory if it doesn't exist
        if !FileManager.default.fileExists(atPath: resultsDir.path) {
            do {
                try FileManager.default.createDirectory(
                    at: resultsDir,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            } catch {
                os_log(.error, log: log, "Failed to create results directory: %{public}@", error.localizedDescription)
                return nil
            }
        }

        // SHA-256 hash the URL, take first 16 hex chars (64 bits — collision-safe for 25 files)
        let digest = SHA256.hash(data: Data(url.utf8))
        let hashPrefix = digest.prefix(8).map { String(format: "%02x", $0) }.joined()

        return resultsDir.appendingPathComponent("\(hashPrefix).json")
    }

    /// Evicts oldest per-URL result files beyond the 25-file cap.
    /// Sorts by modification date and deletes the oldest excess files.
    private func evictOldResults() {
        guard let storageDir = storageDirectory() else { return }

        let resultsDir = storageDir.appendingPathComponent("results")
        let fm = FileManager.default

        guard let files = try? fm.contentsOfDirectory(
            at: resultsDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        // Only evict if over the cap
        let maxFiles = 25
        guard files.count > maxFiles else { return }

        // Sort by modification date (newest first)
        let sorted = files.compactMap { url -> (URL, Date)? in
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                  let date = values.contentModificationDate else { return nil }
            return (url, date)
        }.sorted { $0.1 > $1.1 }

        // Delete files beyond the cap
        for (url, _) in sorted.dropFirst(maxFiles) {
            do {
                try fm.removeItem(at: url)
                os_log(.default, log: log, "Evicted old result cache: %{public}@", url.lastPathComponent)
            } catch {
                os_log(.error, log: log, "Failed to evict result cache: %{public}@", error.localizedDescription)
            }
        }
    }

    /// Write a result dictionary to lastResult.json on disk.
    /// Also writes to a per-URL cache file (results/<hash>.json) if the result contains a url field.
    private func handleStoreResult(context: NSExtensionContext, message: [String: Any]) {
        guard let storageDir = storageDirectory() else {
            sendResponse(context: context, data: ["error": "Cannot access storage directory"])
            return
        }

        let resultData = message["result"] as Any
        let fileURL = storageDir.appendingPathComponent("lastResult.json")

        do {
            // Wrap in a container so we can store null/nil as { "result": null }
            let wrapper: [String: Any] = ["result": resultData]
            let jsonData = try JSONSerialization.data(withJSONObject: wrapper, options: [.prettyPrinted])

            // Always write to lastResult.json (most-recent pointer for pop-out view)
            try jsonData.write(to: fileURL, options: .atomic)

            // Also write to per-URL cache if the result contains a url field
            if let resultDict = resultData as? [String: Any],
               let url = resultDict["url"] as? String,
               let perUrlFile = resultFileURL(for: url) {
                try jsonData.write(to: perUrlFile, options: .atomic)
                evictOldResults()
            }

            os_log(.default, log: log, "Stored result to disk (%{public}d bytes)", jsonData.count)
            sendResponse(context: context, data: ["success": true])
        } catch {
            os_log(.error, log: log, "Failed to store result: %{public}@", error.localizedDescription)
            sendResponse(context: context, data: ["error": "Failed to store result: \(error.localizedDescription)"])
        }
    }

    /// Read a stored result from disk.
    /// If a url is provided in the message, looks up the per-URL cache file first.
    /// Falls through to lastResult.json if no URL given or per-URL file not found.
    private func handleGetStoredResult(context: NSExtensionContext, message: [String: Any]) {
        guard let storageDir = storageDirectory() else {
            sendResponse(context: context, data: ["result": NSNull()])
            return
        }

        // Try per-URL cache first if a url is provided
        if let url = message["url"] as? String,
           let perUrlFile = resultFileURL(for: url),
           FileManager.default.fileExists(atPath: perUrlFile.path) {
            do {
                let jsonData = try Data(contentsOf: perUrlFile)
                if let wrapper = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                    sendResponse(context: context, data: wrapper)
                    return
                }
            } catch {
                os_log(.error, log: log, "Failed to read per-URL result: %{public}@", error.localizedDescription)
                // Fall through to lastResult.json
            }
        }

        // Fall through to lastResult.json (most-recent result)
        let fileURL = storageDir.appendingPathComponent("lastResult.json")

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            sendResponse(context: context, data: ["result": NSNull()])
            return
        }

        do {
            let jsonData = try Data(contentsOf: fileURL)
            if let wrapper = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                sendResponse(context: context, data: wrapper)
            } else {
                sendResponse(context: context, data: ["result": NSNull()])
            }
        } catch {
            os_log(.error, log: log, "Failed to read stored result: %{public}@", error.localizedDescription)
            sendResponse(context: context, data: ["result": NSNull()])
        }
    }

    /// Delete a stored result from disk.
    /// If a url is provided in the message, deletes that URL's per-URL cache file.
    /// Otherwise deletes lastResult.json (existing behavior).
    private func handleClearStoredResult(context: NSExtensionContext, message: [String: Any]) {
        guard let storageDir = storageDirectory() else {
            sendResponse(context: context, data: ["success": true])
            return
        }

        if let url = message["url"] as? String,
           let perUrlFile = resultFileURL(for: url) {
            // Delete the per-URL cache file
            if FileManager.default.fileExists(atPath: perUrlFile.path) {
                do {
                    try FileManager.default.removeItem(at: perUrlFile)
                    os_log(.default, log: log, "Cleared per-URL result cache for: %{public}@", url)
                } catch {
                    os_log(.error, log: log, "Failed to clear per-URL result: %{public}@", error.localizedDescription)
                }
            }
        } else {
            // No URL — delete lastResult.json (existing behavior)
            let fileURL = storageDir.appendingPathComponent("lastResult.json")
            if FileManager.default.fileExists(atPath: fileURL.path) {
                do {
                    try FileManager.default.removeItem(at: fileURL)
                    os_log(.default, log: log, "Cleared stored result from disk")
                } catch {
                    os_log(.error, log: log, "Failed to clear stored result: %{public}@", error.localizedDescription)
                }
            }
        }

        sendResponse(context: context, data: ["success": true])
    }

    // MARK: - Response Helper

    /// Send a response dictionary back to the JS layer.
    private func sendResponse(context: NSExtensionContext, data: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: data]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
