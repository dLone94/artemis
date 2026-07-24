import Foundation

/// How to reach this particular Artemis.
///
/// Assuming `http://127.0.0.1:4100` is wrong for a real install. This machine
/// runs with `ARTEMIS_HOST=0.0.0.0`, `ARTEMIS_HTTPS=1` and an access token — so
/// the app has to speak HTTPS, tolerate the self-signed loopback certificate,
/// and authenticate, or it just gets a 401 and shows a login page inside its own
/// window. The settings are read from the project's `.env`, the same file the
/// server reads, so the two can't disagree.
struct ArtemisConfig {
    let port: String
    let usesHTTPS: Bool
    let accessToken: String?

    var scheme: String { usesHTTPS ? "https" : "http" }

    /// Status URL for probing, carrying the token when there is one.
    ///
    /// Without the key this returns 401 rather than JSON whenever the server is
    /// bound to the LAN — and a probe that reads 401 as "nothing there" would
    /// make the app try to spawn a second server onto an occupied port.
    var statusURL: URL {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "127.0.0.1"
        c.port = Int(port)
        c.path = "/api/status"
        if let token = accessToken, !token.isEmpty {
            c.queryItems = [URLQueryItem(name: "key", value: token)]
        }
        return c.url!
    }

    /// First load carries `?key=`; the server answers with a cookie and a 302,
    /// and every later request rides the cookie.
    var initialURL: URL {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "127.0.0.1"
        c.port = Int(port)
        c.path = "/"
        if let token = accessToken, !token.isEmpty {
            c.queryItems = [URLQueryItem(name: "key", value: token)]
        }
        return c.url!
    }

    /// Environment wins over `.env`, matching how server.js loads it.
    static func load(root: URL) -> ArtemisConfig {
        let env = ProcessInfo.processInfo.environment
        let file = parseDotEnv(at: root.appendingPathComponent(".env"))
        func value(_ key: String) -> String? {
            if let v = env[key], !v.isEmpty { return v }
            if let v = file[key], !v.isEmpty { return v }
            return nil
        }
        let truthy = { (s: String?) -> Bool in
            guard let s = s?.lowercased() else { return false }
            return ["1", "true", "yes", "on"].contains(s)
        }
        return ArtemisConfig(
            port: value("ARTEMIS_PORT") ?? value("PORT") ?? "4100",
            usesHTTPS: truthy(value("ARTEMIS_HTTPS")),
            accessToken: value("ARTEMIS_ACCESS_TOKEN")
        )
    }

    /// Deliberately small: `KEY=value`, `#` comments, optional surrounding
    /// quotes. Anything fancier belongs in the server, not here.
    static func parseDotEnv(at url: URL) -> [String: String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<eq]).trimmingCharacters(in: .whitespaces)
            var val = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if val.count >= 2, (val.hasPrefix("\"") && val.hasSuffix("\"")) || (val.hasPrefix("'") && val.hasSuffix("'")) {
                val = String(val.dropFirst().dropLast())
            }
            guard !key.isEmpty else { continue }
            out[key] = val
        }
        return out
    }
}

/// Accepts the self-signed certificate — but only for loopback.
///
/// Artemis generates its own cert so a phone's microphone works over the LAN.
/// WKWebView and URLSession both reject it by default. Trusting it is correct
/// here and only here: the check is pinned to 127.0.0.1/localhost, so this can
/// never silently accept a bad certificate from anywhere else.
enum LoopbackTrust {
    static func isLoopback(_ host: String?) -> Bool {
        guard let h = host?.lowercased() else { return false }
        return h == "127.0.0.1" || h == "localhost" || h == "::1"
    }

    static func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              isLoopback(challenge.protectionSpace.host),
              let trust = challenge.protectionSpace.serverTrust
        else { return nil }
        return URLCredential(trust: trust)
    }
}

/// URLSession delegate that trusts the loopback certificate, used for probing.
final class LoopbackSessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let cred = LoopbackTrust.credential(for: challenge) {
            completionHandler(.useCredential, cred)
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
