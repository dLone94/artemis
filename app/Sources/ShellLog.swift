import Foundation
import AppKit

/// Persistent shell diagnostics.
///
/// NSLog no longer survives into `log show` on this macOS, so a failed
/// presentation transition left no evidence behind — the invisible-pill bug
/// was undebuggable after the fact. The shell mirrors every diagnostic line
/// to ~/Library/Logs/Artemis/shell.log (next to server.log), newest run
/// appended, so the last real run can always be read back.
enum ShellLog {
    static func redact(_ message: String) -> String {
        let patterns = [
            (#"([?&](?:key|token|access_token|auth_token|code|signature|sig|x-amz-signature)=)[^&#\s]+"#, "$1[redacted]"),
            (#"(artemis_auth=)[^;\s]+"#, "$1[redacted]"),
            (#"(Authorization\s*:\s*)(?:Bearer\s+)?\S+"#, "$1[redacted]"),
            (#"([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)\s*=\s*)\S+"#, "$1[redacted]"),
            (#"((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|credential)\s*[=:]\s*)\S+"#, "$1[redacted]"),
            (#"\b(?:nvapi-|gsk_|sk-ant-|gh[ps]_)[A-Za-z0-9._-]{8,}\b"#, "[redacted]")
        ]
        return patterns.reduce(message) { value, rule in
            let (pattern, replacement) = rule
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return value }
            return regex.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: replacement)
        }
    }

    static let url: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Artemis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("shell.log")
    }()

    private static let queue = DispatchQueue(label: "artemis.shell.log")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// A lifecycle event, with the state that explains it.
    ///
    /// The app was exiting seconds after launch with no crash report, no alert
    /// and no output — nothing in the log said which of the four possible
    /// termination paths ran. Every lifecycle edge now records the same fields
    /// so the path can be READ rather than guessed at.
    static func lifecycle(_ event: String,
                          reason: String = "",
                          mode: String = "",
                          mainWindowVisible: Bool? = nil,
                          pillVisible: Bool? = nil,
                          serverPID: Int32? = nil,
                          intentional: Bool? = nil,
                          extra: String = "") {
        var parts = ["LIFECYCLE", event, "pid=\(ProcessInfo.processInfo.processIdentifier)"]
        if !reason.isEmpty { parts.append("reason=\(reason)") }
        if !mode.isEmpty { parts.append("mode=\(mode)") }
        if let v = mainWindowVisible { parts.append("mainWindowVisible=\(v)") }
        if let v = pillVisible { parts.append("pillVisible=\(v)") }
        if let v = serverPID { parts.append("serverPID=\(v)") }
        if let v = intentional { parts.append("intentional=\(v)") }
        if !extra.isEmpty { parts.append(extra) }
        parts.append("windows=\(NSApplication.shared.windows.count)")
        parts.append("visibleWindows=\(NSApplication.shared.windows.filter { $0.isVisible }.count)")
        parts.append("frontmost=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
        log(parts.joined(separator: " "))
    }

    static func log(_ message: String) {
        let safe = redact(message)
        NSLog("%@", safe) // still visible live when launched from a terminal
        let line = stamp.string(from: Date()) + " " + safe + "\n"
        queue.async {
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            guard let fh = try? FileHandle(forWritingTo: url) else { return }
            defer { try? fh.close() }
            fh.seekToEndOfFile()
            if let data = line.data(using: .utf8) { fh.write(data) }
        }
    }
}
