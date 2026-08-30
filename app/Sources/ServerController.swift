import Foundation

enum ProbeResult: String {
    case artemis
    case foreign
    case stale      // it IS Artemis, but running code older than what's on disk
    case orphan     // it IS Artemis, but the app that owned it is gone
    case none
}

/// What a probe learned, beyond the verdict. The PID matters: reclaiming an
/// orphan means terminating THAT process and nothing else — never "some node".
struct ProbeDetail {
    var result: ProbeResult
    var serverPID: Int32?
    var ownerPID: Int32?
    var standalone: Bool = false
}

enum ServerError: Error {
    case nodeMissing
    case rootMissing(String)
    case foreignServer
    case staleServer
    case timeout(String)
}

/// Owns the Node server — but only if it started it.
///
/// The user often runs `node server.js` in a terminal. Attaching to that and
/// then killing it on quit would be a nasty surprise, so `ownsServer` gates
/// every termination.
final class ServerController {
    let root: URL
    let config: ArtemisConfig
    private(set) var ownsServer = false
    private var process: Process?
    private var stopping = false
    private var ready = false
    /// Fired on the main queue when an owned server exits after a successful start.
    var onUnexpectedExit: (() -> Void)?
    /// PID of the server we spawned, for lifecycle evidence. nil when attached.
    var serverPID: Int32? { ownsServer ? process?.processIdentifier : nil }
    private var outputBuffer = ""
    private let bufferLock = NSLock()

    let logURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Artemis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("server.log")
    }()

    init(root: URL, config: ArtemisConfig) {
        self.root = root
        self.config = config
    }

    /// Is something answering there, and is it Artemis?
    ///
    /// Identified by fields only Artemis serves — a bare "it responded" check
    /// would happily attach the app to an unrelated dev server.
    static func probe(statusURL: URL, timeout: TimeInterval = 2.0) -> ProbeResult {
        probeDetail(statusURL: statusURL, timeout: timeout).result
    }

    /// Is a PID still alive? signal 0 asks without touching it.
    static func pidAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    static func probeDetail(statusURL: URL, timeout: TimeInterval = 2.0) -> ProbeDetail {
        let session = URLSession(configuration: .ephemeral,
                                 delegate: LoopbackSessionDelegate(),
                                 delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: statusURL)
        request.timeoutInterval = timeout
        var detail = ProbeDetail(result: .none)
        let sem = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, _ in
            defer { sem.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            guard json["chatEnabled"] != nil && json["localWake"] != nil else { detail.result = .foreign; return }
            // Ownership first: an Artemis server whose owning app has died is an
            // orphan, and attaching to it is how "the app is running" became a
            // lie. A server started from a terminal declares itself standalone
            // and is never reclaimed — that one belongs to the user.
            if let owner = json["owner"] as? [String: Any] {
                detail.serverPID = (owner["pid"] as? NSNumber)?.int32Value
                detail.ownerPID = (owner["ownerPid"] as? NSNumber)?.int32Value
                detail.standalone = (owner["standalone"] as? Bool) ?? false
                if let ownerPID = detail.ownerPID, !detail.standalone, !Self.pidAlive(ownerPID) {
                    detail.result = .orphan
                    return
                }
            }
            // Attaching to a running Artemis is only safe if it is running the
            // CURRENT code. A long-lived process keeps its modules in memory, so
            // a server started before an edit serves the old behaviour while the
            // files on disk look right — which made "it's fixed now" wrong twice
            // in one session. The server reports when it started and how new its
            // files were; if it predates them, treat it as unusable.
            guard let code = json["code"] as? [String: Any],
                  let started = code["startedMs"] as? Double,
                  let newest = code["newestFileMs"] as? Double else {
                // No version handshake at all: the server predates the
                // handshake itself, so it is running old code by definition.
                // Attaching anyway made dictation stream raw PCM to a server
                // that ignored the encoding parameters — silent empty result.
                detail.result = .stale
                return
            }
            if started < newest {
                detail.result = .stale
                return
            }
            detail.result = .artemis
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 1.0)
        return detail
    }

    /// End an orphaned Artemis server — that exact PID, bounded, nothing else.
    private static func reclaim(_ detail: ProbeDetail) {
        guard let pid = detail.serverPID, pid > 0, pidAlive(pid) else { return }
        ShellLog.lifecycle("server.orphan.reclaim", reason: "owner \(detail.ownerPID.map(String.init) ?? "?") is gone",
                           serverPID: pid)
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while pidAlive(pid) && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if pidAlive(pid) {
            ShellLog.lifecycle("server.orphan.kill", reason: "ignored SIGTERM", serverPID: pid)
            kill(pid, SIGKILL)
            let hard = Date().addingTimeInterval(1)
            while pidAlive(pid) && Date() < hard { Thread.sleep(forTimeInterval: 0.05) }
        }
        ShellLog.lifecycle("server.orphan.reclaimed", reason: pidAlive(pid) ? "STILL RUNNING" : "gone", serverPID: pid)
    }

    /// Attach if Artemis is already up, otherwise spawn one.
    /// - Returns: `true` when it spawned a server, `false` when it attached.
    @discardableResult
    func start(readyTimeout: TimeInterval = 20) throws -> Bool {
        let detail = Self.probeDetail(statusURL: config.statusURL)
        ShellLog.lifecycle("server.probe", reason: detail.result.rawValue,
                           serverPID: detail.serverPID,
                           extra: "ownerPID=\(detail.ownerPID.map(String.init) ?? "none") standalone=\(detail.standalone)")
        stopping = false
        ready = false
        switch detail.result {
        case .artemis: ownsServer = false; return false
        case .foreign: throw ServerError.foreignServer
        case .stale: throw ServerError.staleServer
        case .orphan:
            // Reclaim, then fall through and spawn a server this app owns.
            Self.reclaim(detail)
        case .none: break
        }

        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("server.js").path)
        else { throw ServerError.rootMissing(root.path) }
        guard let node = NodeLocator.find() else { throw ServerError.nodeMissing }

        FileManager.default.createFile(atPath: logURL.path, contents: nil)

        let p = Process()
        p.executableURL = node
        p.arguments = ["server.js"]
        p.currentDirectoryURL = root
        // Environment is inherited so server.js reads .env exactly as it does
        // from a terminal. Nothing is forced: the app already derived its URL
        // from the same file, so overriding here could only create a mismatch.
        // Ownership is declared to the child so it can watch us back: if this
        // app dies, the server sees the PID vanish and exits itself.
        var env = ProcessInfo.processInfo.environment
        env["ARTEMIS_OWNER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["ARTEMIS_OWNER_TOKEN"] = UUID().uuidString
        env["PORT"] = config.port
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        let logURL = self.logURL
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else {
                h.readabilityHandler = nil
                return
            }
            if let text = String(data: data, encoding: .utf8) {
                let safeText = ShellLog.redact(text)
                self?.bufferLock.lock()
                self?.outputBuffer += safeText
                self?.bufferLock.unlock()
                if let safeData = safeText.data(using: .utf8),
                   let fh = try? FileHandle(forWritingTo: logURL) {
                    fh.seekToEndOfFile(); fh.write(safeData); try? fh.close()
                }
            }
        }
        try p.run()
        process = p
        ownsServer = true
        ShellLog.lifecycle("server.spawn", reason: "no existing Artemis server",
                           serverPID: p.processIdentifier, extra: "node=\(node.path)")
        // A child that dies on its own must be visible, not silently absent.
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                ShellLog.lifecycle("server.exit", reason: "status=\(proc.terminationStatus) reason=\(proc.terminationReason.rawValue)",
                                   serverPID: proc.processIdentifier)
                guard let self, self.ownsServer, self.ready, !self.stopping else { return }
                self.ownsServer = false
                self.process = nil
                self.ready = false
                self.onUnexpectedExit?()
            }
        }

        let deadline = Date().addingTimeInterval(readyTimeout)
        while Date() < deadline {
            if Self.probe(statusURL: config.statusURL) == .artemis {
                ready = true
                return true
            }
            if !p.isRunning { throw ServerError.timeout(recentOutput) }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw ServerError.timeout(recentOutput)
    }

    /// Last 30 lines the server printed — the actual reason it failed.
    var recentOutput: String {
        bufferLock.lock(); defer { bufferLock.unlock() }
        return outputBuffer.split(separator: "\n").suffix(30).joined(separator: "\n")
    }

    func stop() {
        stopping = true
        ready = false
        guard ownsServer, let p = process, p.isRunning else {
            ShellLog.lifecycle("server.stop.skipped",
                               reason: ownsServer ? "not running" : "attached, not owned",
                               serverPID: process?.processIdentifier)
            return
        }
        let pid = p.processIdentifier
        ShellLog.lifecycle("server.stop.begin", reason: "SIGTERM", serverPID: pid)
        p.terminate()                                   // SIGTERM
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        // Bounded last resort: a server that ignores SIGTERM must not be left
        // behind to masquerade as a live Artemis on the next launch.
        if p.isRunning {
            ShellLog.lifecycle("server.stop.kill", reason: "did not exit within 3s", serverPID: pid)
            kill(pid, SIGKILL)
            let hard = Date().addingTimeInterval(1)
            while p.isRunning && Date() < hard { Thread.sleep(forTimeInterval: 0.05) }
        }
        ShellLog.lifecycle("server.stop.done", reason: p.isRunning ? "STILL RUNNING" : "exited", serverPID: pid)
        process = nil
    }
}
