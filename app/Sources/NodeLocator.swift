import Foundation

/// Finds a `node` binary.
///
/// Not as simple as it looks: an app launched from Finder inherits none of the
/// user's shell PATH, so `node` is invisible unless it is searched for
/// explicitly. Version managers put it somewhere unusual more often than not.
/// The login-shell fallback is last because spawning a shell is slow.
enum NodeLocator {
    static let searched = [
        "$ARTEMIS_NODE",
        "~/.local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "(login shell PATH)"
    ]

    static func find() -> URL? {
        let fm = FileManager.default
        if let override = ProcessInfo.processInfo.environment["ARTEMIS_NODE"],
           fm.isExecutableFile(atPath: override) {
            return URL(fileURLWithPath: override)
        }
        let home = fm.homeDirectoryForCurrentUser.path
        for path in ["\(home)/.local/bin/node", "/opt/homebrew/bin/node",
                     "/usr/local/bin/node", "/usr/bin/node"] {
            if fm.isExecutableFile(atPath: path) { return URL(fileURLWithPath: path) }
        }
        return fromLoginShell()
    }

    private static func fromLoginShell() -> URL? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !out.isEmpty, FileManager.default.isExecutableFile(atPath: out) else { return nil }
        return URL(fileURLWithPath: out)
    }
}
