import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let mode: RunMode
    private let url: URL
    private let root: URL
    private let config: ArtemisConfig
    private let bridge = BrowserBridge()
    private var server: ServerController!
    private var dictationController: DictationController?
    private var window: NSWindow!
    private var webView: WKWebView!

    init(mode: RunMode, url: URL, root: URL, config: ArtemisConfig) {
        self.mode = mode
        self.url = url
        self.root = root
        self.config = config
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        server = ServerController(root: root, config: config)
        do {
            try server.start()
        } catch {
            presentStartupFailure(error)
            return
        }
        // Compat-check is intentionally limited to its browser capability
        // probe: no dictation monitors, menu, or native microphone access.
        if mode != .compatCheck {
            let controller = DictationController(config: config)
            controller.installMenuItem()
            dictationController = controller
        }
        buildWindow()
        webView.load(URLRequest(url: url))
    }

    private func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: BrowserBridge.openShimJS,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: false))
        controller.add(bridge, name: BrowserBridge.messageName)
        cfg.userContentController = controller

        // UA marker: tells the page it runs in our shell (autoplay already
        // allowed above), so the boot may enter itself without the tap gate.
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 820), configuration: cfg)
        webView.customUserAgent = (WKWebView().value(forKey: "userAgent") as? String ?? "Mozilla/5.0") + " ArtemisShell/1.0"
        webView.navigationDelegate = self
        webView.uiDelegate = bridge

        window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Artemis"
        window.contentView = webView
        window.setFrameAutosaveName("ArtemisMain")
        window.center()
        // Even in compat-check mode the app comes forward: the microphone prompt
        // is part of what's being tested, and an invisible prompt just hangs.
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Full-screen cockpit by default. Deferred a tick so the window is
        // fully key first; compat-check keeps a normal window (a fullscreen
        // space would hide its permission prompts).
        if mode != .compatCheck {
            window.collectionBehavior.insert(.fullScreenPrimary)
            // A bare async fires during launch activation and macOS drops the
            // toggle — verified live. A short delay lands after activation.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let window = self?.window,
                      !window.styleMask.contains(.fullScreen) else { return }
                window.toggleFullScreen(nil)
            }
        }

        if mode == .compatCheck {
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                print("compat-check timed out after 60s (unanswered permission prompt?)")
                exit(4)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        dictationController?.shutdown()
        server?.stop()   // no-op unless we started it
    }

    /// Artemis serves a self-signed certificate so phones can use the mic over
    /// the LAN. Trust it for loopback only — see LoopbackTrust.
    func webView(_ wv: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let cred = LoopbackTrust.credential(for: challenge) {
            completionHandler(.useCredential, cred)
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
        guard mode == .compatCheck else { return }
        // callAsyncJavaScript, not evaluateJavaScript: the probe awaits
        // getUserMedia, and a Promise cannot be marshalled back.
        wv.callAsyncJavaScript(Self.compatProbeJS, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                print((value as? String) ?? "no result")
                exit(0)
            case .failure(let error):
                print("compat-check failed: \(error.localizedDescription)")
                exit(2)
            }
        }
    }

    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        if mode == .compatCheck { print("load failed: \(error.localizedDescription)"); exit(3) }
        presentLoadFailure(error)
    }

    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        if mode == .compatCheck { print("load failed: \(error.localizedDescription)"); exit(3) }
        presentLoadFailure(error)
    }

    // MARK: failure presentation
    // Every failure says what happened. A blank white window is the worst
    // possible outcome and the easiest one to ship by accident.

    private func fatalAlert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.alertStyle = .critical
        a.messageText = title
        a.informativeText = body
        a.addButton(withTitle: "Quit")
        a.runModal()
        NSApp.terminate(nil)
    }

    private func presentStartupFailure(_ error: Error) {
        switch error {
        case ServerError.nodeMissing:
            fatalAlert("Artemis can't find Node.",
                       "Looked in:\n" + NodeLocator.searched.joined(separator: "\n") +
                       "\n\nSet ARTEMIS_NODE to the full path of your node binary and try again.")
        case ServerError.rootMissing(let path):
            fatalAlert("Artemis can't find its files.",
                       "Expected server.js in:\n\(path)\n\n" +
                       "If you moved the project, rebuild with app/build.sh, " +
                       "or set ARTEMIS_ROOT to the new location.")
        case ServerError.staleServer:
            fatalAlert("Artemis is running old code.",
                       "A server on port \(config.port) started before the current files were saved, " +
                       "so it is still serving the previous behaviour.\n\nStop it and reopen Artemis:\n" +
                       "  kill $(lsof -nP -iTCP:\(config.port) -sTCP:LISTEN -t)\n\n" +
                       "Artemis won't attach to it, because doing so would silently give you stale behaviour.")
        case ServerError.foreignServer:
            fatalAlert("Port \(config.port) is already in use.",
                       "Something is answering on that port, but it isn't Artemis. " +
                       "Stop it and reopen Artemis, or set ARTEMIS_PORT to a free port.")
        case ServerError.timeout(let log):
            fatalAlert("The Artemis server didn't start.",
                       (log.isEmpty ? "It produced no output." : "Last output:\n\n" + log) +
                       "\n\nFull log: \(server.logURL.path)")
        default:
            fatalAlert("Artemis failed to start.", "\(error)\n\nLog: \(server.logURL.path)")
        }
    }

    private func presentLoadFailure(_ error: Error) {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Couldn't load the Artemis interface."
        a.informativeText = "\(error.localizedDescription)\n\nLog: \(server.logURL.path)"
        a.addButton(withTitle: "Retry")
        a.addButton(withTitle: "Quit")
        if a.runModal() == .alertFirstButtonReturn {
            webView.load(URLRequest(url: url))
        } else {
            NSApp.terminate(nil)
        }
    }

    static let compatProbeJS = """
      const simdBytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
      const out = {
        secureContext: window.isSecureContext,
        getUserMediaPresent: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        audioWorklet: typeof AudioWorkletNode !== 'undefined',
        wasm: typeof WebAssembly === 'object',
        wasmSimd: (() => { try { return WebAssembly.validate(simdBytes); } catch (e) { return false; } })(),
        mediaRecorder: typeof MediaRecorder !== 'undefined',
        cryptoSubtle: !!(window.crypto && window.crypto.subtle),
        eventSource: typeof EventSource !== 'undefined',
        speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition)
      };
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        out.micGranted = true;
        s.getTracks().forEach(t => t.stop());
      } catch (e) {
        out.micGranted = false;
        out.micError = String(e && e.name);
      }
      return JSON.stringify(out, null, 2);
    """
}
