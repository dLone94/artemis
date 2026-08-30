import AppKit
import WebKit

/// The floating Artemis pill: a lightweight, always-on-top NSPanel hosting a
/// small WKWebView that loads /pill.html. It renders the SAME live state the
/// dashboard publishes (via the presence bus), so there is no second assistant
/// — just a second view of the one Artemis.
///
/// Presentation modes (Part D1):
///   full        — main dashboard visible, pill hidden
///   pill        — main dashboard hidden, pill floating
///   background  — both hidden; Artemis keeps running per voice/wake settings
///
/// The pill is a non-activating panel so it never steals keyboard focus, is
/// movable by dragging its background, and remembers its position across runs.
///
/// Mini Core: the page declares a size class (compact / wide / approval) via a
/// script message on THIS webview (the main window's handler never reaches it)
/// and the panel animates between frames, anchored at its top-right corner so
/// growth reads as the pill breathing rather than drifting.
final class PillController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private let url: URL
    private var panel: NSPanel?
    /// Is the pill actually on screen? Needed as lifecycle evidence: "the app
    /// has no windows" and "Artemis is invisible" are different facts.
    var isVisible: Bool { panel?.isVisible ?? false }
    /// Restore the dashboard. The pill webview cannot reach AppDelegate's
    /// script handler, so restore is delivered here and forwarded.
    var onRestore: (() -> Void)?
    private var webView: WKWebView?
    private var loadFailed = false
    private var currentSizeClass = "compact"

    /// WKUserContentController retains its handlers strongly; this thin proxy
    /// keeps the controller collectable.
    private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(ucc, didReceive: message)
        }
    }

    init(url: URL) {
        self.url = url
        super.init()
    }

    // MARK: - script messages from pill.html

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "artemisPill" else { return }
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "restore" {
            DispatchQueue.main.async { [weak self] in self?.onRestore?() }
            return
        }
        // Sizing lives on the native bridge; mute/cancel still travel over
        // /api/presence/command like every other surface command.
        if action == "resize" {
            let size = (body["size"] as? String) ?? "compact"
            let width = (body["width"] as? Double) ?? 68
            let height = (body["height"] as? Double) ?? 68
            resize(toClass: size, width: CGFloat(width), height: CGFloat(height))
        }
    }

    /// Animate to a new frame, top-right anchored, clamped to the screen.
    /// Web-declared sizes are sanity-clamped so a bad message can never
    /// produce an absurd panel.
    private func resize(toClass sizeClass: String, width: CGFloat, height: CGFloat) {
        guard let p = panel, sizeClass != currentSizeClass || abs(p.frame.width - width) > 1 else { return }
        currentSizeClass = sizeClass
        // Compact is intentionally a true orb. The previous 200 pt minimum
        // forced an idle "pill" silhouette even when the page requested its
        // 68×68 core-only state.
        let w = min(max(width, 60), 420)
        let h = min(max(height, 60), 240)
        var frame = p.frame
        frame.origin.x = frame.maxX - w          // right edge stays put
        frame.origin.y = frame.maxY - h          // top edge stays put (grows downward)
        frame.size = NSSize(width: w, height: h)
        ShellLog.log("ArtemisPill: resize → \(sizeClass) \(NSStringFromRect(frame))")
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            p.animator().setFrame(frame, display: true)
        } completionHandler: { [weak self] in
            guard let self, let p = self.panel else { return }
            self.clampOnScreen(p)
        }
    }

    /// The pill URL carries the access token as ?key= — never log it whole.
    private var redactedURL: String {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let hadKey = c?.queryItems?.contains { $0.name == "key" } ?? false
        c?.queryItems = nil
        return (c?.url?.absoluteString ?? "?") + (hadKey ? "?key=…" : " (NO key)")
    }

    /// The pill loads from the same self-signed HTTPS server as the dashboard.
    /// Without this trust handler the TLS handshake fails silently and the
    /// panel — transparent, borderless — is "shown" but renders NOTHING: the
    /// invisible-pill bug. Trust is loopback-only, same as the main window.
    func webView(_ wv: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let cred = LoopbackTrust.credential(for: challenge) {
            completionHandler(.useCredential, cred)
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    // A pill that failed to load must not stay an invisible rectangle: remember
    // the failure and retry on the next show() (e.g. the server finished
    // booting in the meantime).
    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        loadFailed = true
        ShellLog.log("ArtemisPill: load FAILED (provisional): \(error.localizedDescription)")
    }

    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        loadFailed = true
        ShellLog.log("ArtemisPill: load FAILED: \(error.localizedDescription)")
    }

    func webView(_ wv: WKWebView, didStartProvisionalNavigation nav: WKNavigation!) {
        ShellLog.log("ArtemisPill: navigation started")
    }

    // Surface the HTTP status the pill page actually got — a 401 login wall
    // renders as a blank transparent panel, i.e. an invisible pill.
    func webView(_ wv: WKWebView,
                 decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse {
            ShellLog.log("ArtemisPill: HTTP \(http.statusCode) for \(http.url?.path ?? "?")")
        }
        decisionHandler(.allow)
    }

    func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
        ShellLog.log("ArtemisPill: page loaded (\(wv.url?.path ?? "?"))")
        diagnose("after page load")
    }

    private func buildIfNeeded() {
        guard panel == nil else { return }
        ShellLog.log("ArtemisPill: building panel, loading \(redactedURL)")
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // Pill 2.0 sizing messages arrive on THIS webview's own handler.
        cfg.userContentController.add(WeakMessageHandler(self), name: "artemisPill")
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 68, height: 68), configuration: cfg)
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground") // transparent; the page paints the pill
        wv.load(URLRequest(url: url))
        self.webView = wv

        // .nonactivatingPanel: clicking the pill does not steal focus from the
        // app the user is working in — essential for a computer-agent overlay.
        let p = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 68, height: 68),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        p.contentView = wv
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .floating                     // always-on-top when shown
        p.isMovableByWindowBackground = true    // drag anywhere on the pill
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.setFrameAutosaveName("ArtemisPill")   // remembers position
        if p.frame.origin == .zero { positionAtDefaultCorner(p) }
        self.panel = p
    }

    private func positionAtDefaultCorner(_ p: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let v = screen.visibleFrame
        let margin: CGFloat = 24
        p.setFrameOrigin(NSPoint(x: v.maxX - p.frame.width - margin, y: v.maxY - p.frame.height - margin))
    }

    /// An autosaved position can point at a monitor that is no longer there.
    /// Clamp the pill back inside the current visible screen bounds so show()
    /// can never present it off-screen.
    private func clampOnScreen(_ p: NSPanel) {
        guard let screen = p.screen ?? NSScreen.main else { return }
        let v = screen.visibleFrame
        var o = p.frame.origin
        o.x = min(max(o.x, v.minX), v.maxX - p.frame.width)
        o.y = min(max(o.y, v.minY), v.maxY - p.frame.height)
        if o != p.frame.origin { p.setFrameOrigin(o) }
        if !v.intersects(p.frame) { positionAtDefaultCorner(p) }
    }

    func show() {
        buildIfNeeded()
        if loadFailed {
            loadFailed = false
            ShellLog.log("ArtemisPill: retrying page load")
            webView?.load(URLRequest(url: url))
        }
        guard let p = panel else {
            ShellLog.log("ArtemisPill: show() but panel is nil")
            return
        }
        ShellLog.log("ArtemisPill: show() pre-clamp frame=\(NSStringFromRect(p.frame)) webViewFrame=\(NSStringFromRect(webView?.frame ?? .zero))")
        clampOnScreen(p)
        p.orderFrontRegardless()
        diagnose("after show()")
        // occlusionState right after orderFront is sampled BEFORE the window
        // server composites the panel — it reads occluded even when the pill
        // ends up perfectly visible. The settled reading is the honest one.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.diagnose("settled 1.5s after show()")
        }
    }

    /// Re-order the panel front WITHOUT activating the app or reloading the
    /// page. Called at presentation-transition boundaries (fullscreen exit,
    /// dashboard order-out) where a Space teardown can drop the panel's
    /// ordering even though it still reports visible.
    func reassert(_ reason: String) {
        guard let p = panel, p.isVisible else { return }
        p.orderFrontRegardless()
        diagnose("reassert (\(reason))")
    }

    /// One line with everything that decides whether the pill can be seen.
    func diagnose(_ tag: String) {
        guard let p = panel else {
            ShellLog.log("ArtemisPill: [\(tag)] panel is nil")
            return
        }
        let s = p.screen
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
        ShellLog.log("ArtemisPill: [\(tag)]"
            + " frame=\(NSStringFromRect(p.frame))"
            + " screen=\(s?.localizedName ?? "none")"
            + " screenFrame=\(s.map { NSStringFromRect($0.frame) } ?? "-")"
            + " screenVisible=\(s.map { NSStringFromRect($0.visibleFrame) } ?? "-")"
            + " level=\(p.level.rawValue)"
            + " behavior=\(p.collectionBehavior.rawValue)"
            + " visible=\(p.isVisible ? "yes" : "NO")"
            + " occluded=\(p.occlusionState.contains(.visible) ? "no" : "YES")"
            + " hidesOnDeactivate=\(p.hidesOnDeactivate)"
            + " floatingPanel=\(p.isFloatingPanel)"
            + " alpha=\(p.alphaValue)"
            + " win#=\(p.windowNumber)"
            + " appActive=\(NSApp.isActive)"
            + " frontmost=\(front)")
    }

    func hide() {
        panel?.orderOut(nil)
    }
}
