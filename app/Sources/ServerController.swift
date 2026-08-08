import Foundation

enum ProbeResult: String {
    case artemis
    case foreign
    case stale      // it IS Artemis, but running code older than what's on disk
    case none
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
        let session = URLSession(configuration: .ephemeral,
                                 delegate: LoopbackSessionDelegate(),
                                 delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: statusURL)
        request.timeoutInterval = timeout
        var result = ProbeResult.none
        let sem = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, _ in
            defer { sem.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            guard json["chatEnabled"] != nil && json["localWake"] != nil else { result = .foreign; return }
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
                result = .stale
                return
            }
            if started < newest {
                result = .stale
                return
            }
            result = .artemis
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 1.0)
        return result
    }

    /// Attach if Artemis is already up, otherwise spawn one.
    /// - Returns: `true` when it spawned a server, `false` when it attached.
    @discardableResult
    func start(readyTimeout: TimeInterval = 20) throws -> Bool {
        switch Self.probe(statusURL: config.statusURL) {
        case .artemis: ownsServer = false; return false
        case .foreign: throw ServerError.foreignServer
        case .stale: throw ServerError.staleServer
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
        p.environment = ProcessInfo.processInfo.environment

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        let logURL = self.logURL
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            if let text = String(data: data, encoding: .utf8) {
                self?.bufferLock.lock()
                self?.outputBuffer += text
                self?.bufferLock.unlock()
            }
            if let fh = try? FileHandle(forWritingTo: logURL) {
                fh.seekToEndOfFile(); fh.write(data); try? fh.close()
            }
        }
        try p.run()
        process = p
        ownsServer = true

        let deadline = Date().addingTimeInterval(readyTimeout)
        while Date() < deadline {
            if Self.probe(statusURL: config.statusURL) == .artemis { return true }
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
        guard ownsServer, let p = process, p.isRunning else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        process = nil
    }
}
