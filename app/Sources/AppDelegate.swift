import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let mode: RunMode
    private let url: URL
    private var window: NSWindow!
    private var webView: WKWebView!

    init(mode: RunMode, url: URL) {
        self.mode = mode
        self.url = url
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 820), configuration: cfg)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Artemis"
        window.contentView = webView
        window.center()
        // Even in compat-check mode the app must come forward: the microphone
        // prompt is what we're testing, and an invisible prompt just hangs.
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if mode == .compatCheck {
            // Never hang a scripted run. Report what we have and fail loudly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                print("compat-check timed out after 60s (unanswered permission prompt?)")
                exit(4)
            }
        }
        webView.load(URLRequest(url: url))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

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
        // getUserMedia, and evaluateJavaScript cannot marshal a Promise.
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
        print("load failed: \(error.localizedDescription)")
        if mode == .compatCheck { exit(3) }
    }

    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        print("load failed: \(error.localizedDescription)")
        if mode == .compatCheck { exit(3) }
    }

    // Reports every web API the Artemis UI actually depends on. getUserMedia is
    // invoked for real, not merely feature-detected, because the presence of the
    // function says nothing about whether the permission plumbing works.
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
