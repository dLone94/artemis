import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    private let mode: RunMode
    private let url: URL
    private let root: URL
    private let config: ArtemisConfig
    private let bridge = BrowserBridge()
    private var server: ServerController!
    private var dictationController: DictationController?
    private var pillController: PillController?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var presentationMode = "full"
    /// Set only on a termination Artemis actually asked for. Anything that
    /// terminates without this is, by definition, the bug being hunted.
    private var intentionalQuit = false
    /// True while AppKit is moving the dashboard between spaces. A fullscreen
    /// transition briefly leaves the app with zero visible windows.
    private var inFullScreenTransition = false

    // Message names the page uses to drive presentation. The page decides WHAT
    // to show (via voice/tool); the native shell owns the actual windows.
    static let presentationMessage = "artemisPresentation"
    static let pillMessage = "artemisPill"

    init(mode: RunMode, url: URL, root: URL, config: ArtemisConfig) {
        self.mode = mode
        self.url = url
        self.root = root
        self.config = config
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // Identify the running binary: a stale build without the pill code once
        // cost a full debugging round. One line, every launch.
        let stamp = Bundle.main.object(forInfoDictionaryKey: "ArtemisBuildStamp") as? String ?? "UNSTAMPED (pre-stamp build)"
        ShellLog.log("ArtemisShell: build [\(stamp)] running from \(Bundle.main.bundlePath)")
        ShellLog.lifecycle("app.didFinishLaunching.begin", mode: presentationMode)
        server = ServerController(root: root, config: config)
        server.onUnexpectedExit = { [weak self] in self?.presentOwnedServerDied() }
        do {
            try server.start()
        } catch {
            ShellLog.lifecycle("server.start.failed", reason: "\(error)", intentional: false)
            presentStartupFailure(error)
            return
        }
        ShellLog.lifecycle("server.start.ok",
                           reason: server.ownsServer ? "spawned (owned)" : "attached (not owned)",
                           serverPID: server.serverPID)
        // Compat-check is intentionally limited to its browser capability
        // probe: no dictation monitors, menu, or native microphone access.
        if mode != .compatCheck {
            let controller = DictationController(config: config)
            controller.installMenuItem()
            dictationController = controller
        }
        buildWindow()
        webView.load(URLRequest(url: url))
        // The pill must survive Artemis resigning active (Terminal foreground).
        // Log the panel's real state at that exact boundary while in pill mode.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, self.presentationMode == "pill" else { return }
            self.pillController?.diagnose("app resigned active")
        }
        ShellLog.lifecycle("app.didFinishLaunching.end", mode: presentationMode,
                           mainWindowVisible: window?.isVisible, serverPID: server.serverPID)
    }

    private func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: BrowserBridge.openShimJS,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: false))
        controller.add(bridge, name: BrowserBridge.messageName)
        // Presentation + pill control come from the page over these channels.
        if mode != .compatCheck {
            controller.add(self, name: Self.presentationMessage)
            controller.add(self, name: Self.pillMessage)
        }
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
        window.delegate = self
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
            observeFullScreenTransitions()
            // A bare async fires during launch activation and macOS drops the
            // toggle — verified live. A short delay lands after activation.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                // Escape hatch for diagnosis and for anyone who does not want the
                // cockpit taking a whole Space.
                if ProcessInfo.processInfo.environment["ARTEMIS_NO_FULLSCREEN"] == "1" {
                    ShellLog.lifecycle("window.toggleFullScreen.skipped", reason: "ARTEMIS_NO_FULLSCREEN=1")
                    return
                }
                guard let window = self?.window,
                      !window.styleMask.contains(.fullScreen) else { return }
                ShellLog.lifecycle("window.toggleFullScreen.request", reason: "launch default")
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

    /// Quit-on-close is only right while the dashboard is the app. In pill or
    /// background mode Artemis runs with NO windows AppKit counts — a
    /// borderless NSPanel doesn't keep an app alive — and returning true here
    /// made AppKit terminate the whole app 4ms after the fullscreen dashboard
    /// ordered out, killing the pill and the server with it: the
    /// invisible-pill bug, verified in AppKit's own termination log.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        applyPresentation("full")
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        // ALWAYS false. Artemis is an always-on assistant: the wake word is
        // armed, a server is running and a floating pill may be on screen, none
        // of which AppKit counts as a window. Tying the process lifetime to the
        // dashboard window meant one click on the close button killed the whole
        // assistant AND its server — proven from the lifecycle log:
        //   window.shouldClose (eventType=2 leftMouseUp, loc=13,874 — the
        //   traffic light) → willClose → shouldTerminateAfterLastWindowClosed
        //   answering true → willTerminate intentional=false.
        // Quitting is now only ever explicit: Cmd-Q, the menu, or
        // "Artemis, shut down".
        let answer = false
        ShellLog.lifecycle("app.shouldTerminateAfterLastWindowClosed",
                           reason: "answering \(answer)", mode: presentationMode,
                           mainWindowVisible: window?.isVisible,
                           pillVisible: pillController?.isVisible,
                           intentional: intentionalQuit,
                           extra: "inFullScreenTransition=\(inFullScreenTransition)")
        return answer
    }

    /// Implemented ONLY to record the decision. AppKit's default is
    /// .terminateNow; nothing here changes that.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        // Reaching here at all now means someone asked: Cmd-Q, the menu, or the
        // voice shutdown (which sets the flag before calling terminate).
        intentionalQuit = true
        ShellLog.lifecycle("app.shouldTerminate", mode: presentationMode,
                           mainWindowVisible: window?.isVisible,
                           pillVisible: pillController?.isVisible,
                           serverPID: server?.serverPID,
                           intentional: intentionalQuit)
        return .terminateNow
    }

    // MARK: window delegate — every edge that can end the app

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        ShellLog.lifecycle("window.shouldClose", mode: presentationMode, intentional: intentionalQuit,
                           extra: eventDescription())
        // An intentional quit is already tearing everything down; let it.
        guard !intentionalQuit else { return true }
        // Otherwise the close button means "get the dashboard out of my way",
        // which is exactly what pill mode is for. Refusing the close and
        // switching presentation keeps the assistant — and the wake word —
        // alive, and leaves the user something visible to click back from.
        ShellLog.lifecycle("window.close.divertedToPill", reason: "close button is not a quit",
                           mode: presentationMode)
        applyPresentation("pill")
        return false
    }

    /// What event, if any, is being dispatched right now — enough to tell a real
    /// HID click from a synthesised one, or from no event at all.
    private func eventDescription() -> String {
        guard let e = NSApp.currentEvent else { return "event=none" }
        let src = e.cgEvent?.getIntegerValueField(.eventSourceStateID) ?? -1
        return "eventType=\(e.type.rawValue) clicks=\(e.clickCount) loc=\(Int(e.locationInWindow.x)),\(Int(e.locationInWindow.y))"
             + " win=\(e.windowNumber) sourceStateID=\(src)"
    }

    func windowWillClose(_ note: Notification) {
        ShellLog.lifecycle("window.willClose", mode: presentationMode,
                           mainWindowVisible: window?.isVisible, intentional: intentionalQuit)
    }

    private func observeFullScreenTransitions() {
        let c = NotificationCenter.default
        for (n, label) in [(NSWindow.willEnterFullScreenNotification, "window.willEnterFullScreen"),
                           (NSWindow.didEnterFullScreenNotification, "window.didEnterFullScreen"),
                           (NSWindow.willExitFullScreenNotification, "window.willExitFullScreen"),
                           (NSWindow.didExitFullScreenNotification, "window.didExitFullScreen")] {
            c.addObserver(forName: n, object: window, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.inFullScreenTransition = label.hasPrefix("window.will")
                ShellLog.lifecycle(label, mode: self.presentationMode,
                                   mainWindowVisible: self.window?.isVisible)
            }
        }
    }

    // MARK: presentation control (full / pill / background)

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        ShellLog.log("ArtemisShell: message [\(message.name)] body=\(String(describing: message.body))")
        switch message.name {
        case Self.presentationMessage:
            let body = String(describing: message.body)
            // "Artemis, shut down" — quitting THIS APP. Never a machine
            // shutdown: that is privileged and lives nowhere near here.
            // applicationWillTerminate then stops dictation and the Node
            // server we own, so no helper is left orphaned.
            if body == "quit" {
                ShellLog.log("ArtemisShell: shutdown requested by voice — quitting Artemis")
                intentionalQuit = true
                ShellLog.lifecycle("app.terminate.requested", reason: "voice shutdown",
                                   mode: presentationMode, serverPID: server?.serverPID, intentional: true)
                pillController?.hide()
                NSApp.terminate(nil)
                return
            }
            applyPresentation(body)
        case Self.pillMessage:
            // The pill asked to restore the full dashboard.
            if String(describing: message.body) == "restore" { applyPresentation("full") }
        default:
            break
        }
    }

    private func applyPresentation(_ mode: String) {
        ShellLog.log("ArtemisShell: presentation → \(mode) (pillController \(pillController == nil ? "nil, creating" : "exists"))")
        presentationMode = (mode == "pill" || mode == "background") ? mode : "full"
        if pillController == nil {
            let pill = PillController(url: config.pillURL)
            pill.onRestore = { [weak self] in self?.applyPresentation("full") }
            pillController = pill
        }
        switch mode {
        case "pill":
            // Pill first, then hide: the user must never face an empty screen
            // wondering where Artemis went. Once the dashboard is fully out
            // (including a fullscreen Space teardown) the panel's ordering is
            // re-asserted — a Space transition can drop a floating panel from
            // the display even though it still reports visible.
            pillController?.show()
            hideMainWindow { [weak self] in
                guard self?.presentationMode == "pill" else { return }
                self?.pillController?.reassert("dashboard hidden")
            }
        case "background":
            pillController?.hide()
            hideMainWindow(then: nil)
        default: // "full"
            pillController?.hide()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        ShellLog.log("ArtemisShell: presentation applied, mode=\(mode)")
    }

    /// orderOut on a full-screen window is unreliable: the app owns that Space
    /// and macOS can strand the user in an empty one. Leave full screen first,
    /// then order out once the transition completes.
    private func hideMainWindow(then completion: (() -> Void)?) {
        guard window.styleMask.contains(.fullScreen) else {
            ShellLog.log("ArtemisShell: hiding main window (not fullscreen)")
            window.orderOut(nil)
            completion?()
            return
        }
        ShellLog.log("ArtemisShell: hiding main window (leaving fullscreen first)")
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(
            forName: NSWindow.didExitFullScreenNotification,
            object: window, queue: .main
        ) { [weak self] _ in
            if let token { NotificationCenter.default.removeObserver(token) }
            ShellLog.log("ArtemisShell: fullscreen exited, ordering main window out")
            self?.window.orderOut(nil)
            completion?()
        }
        window.toggleFullScreen(nil)
    }

    func applicationWillTerminate(_ note: Notification) {
        ShellLog.lifecycle("app.willTerminate", mode: presentationMode,
                           mainWindowVisible: window?.isVisible,
                           pillVisible: pillController?.isVisible,
                           serverPID: server?.serverPID,
                           intentional: intentionalQuit)
        dictationController?.shutdown()
        server?.stop()   // no-op unless we started it
        ShellLog.lifecycle("app.willTerminate.done", serverPID: server?.serverPID)
    }

    func webView(_ wv: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let host = (url.host ?? "").lowercased()
        if host == "127.0.0.1" || host == "localhost" || host == "::1" || host.isEmpty {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
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
        ShellLog.lifecycle("app.fatalAlert", reason: title, intentional: true)
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

    private func presentOwnedServerDied() {
        ShellLog.lifecycle("server.unexpectedExit", mode: presentationMode, serverPID: nil, intentional: false)
        let a = NSAlert()
        a.alertStyle = .critical
        a.messageText = "Artemis's engine stopped."
        a.informativeText = "The local server exited unexpectedly.\n\nLog: \(server.logURL.path)"
        a.addButton(withTitle: "Restart")
        a.addButton(withTitle: "Quit")
        if a.runModal() == .alertFirstButtonReturn {
            do {
                try server.start()
                webView.load(URLRequest(url: url))
            } catch {
                presentStartupFailure(error)
            }
        } else {
            intentionalQuit = true
            NSApp.terminate(nil)
        }
    }

    private func presentLoadFailure(_ error: Error) {
        ShellLog.lifecycle("webview.loadFailed", reason: "\(error.localizedDescription)",
                           mode: presentationMode)
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
