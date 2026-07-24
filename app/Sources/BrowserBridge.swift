import AppKit
import WebKit

/// Sends links to the user's real browser, and grants the microphone.
///
/// The subtle part is `window.open`. Returning nil from `createWebViewWith`
/// makes `window.open()` evaluate to null in the page — and public/main.js
/// reads exactly that to decide the pop-up was blocked:
///
///     let w = null;
///     try { w = window.open(url, "_blank"); } catch (e) {}
///     if (w) return true;
///     showOpenPill(url, label);
///
/// Without the shim below, Artemis announces "pop-up blocked" every single time
/// while the tab opens fine behind her. The shim returns a truthy stub instead,
/// so main.js needs no changes and stays correct in a plain browser too.
final class BrowserBridge: NSObject, WKUIDelegate, WKScriptMessageHandler {
    static let messageName = "artemisOpenExternal"

    static let openShimJS = """
    (function () {
      const post = (u) => {
        try { window.webkit.messageHandlers.\(messageName).postMessage(String(u)); } catch (e) {}
      };
      window.open = function (url) {
        if (url) post(url);
        // Truthy stub: the page uses this return value to detect pop-up
        // blocking, and nothing was blocked — macOS opened it.
        return { closed: false, focus() {}, blur() {}, close() {}, postMessage() {}, document: null };
      };
      document.addEventListener("click", (e) => {
        const a = e.target && e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        if (!/^https?:/i.test(href)) return;
        if (a.hostname === location.hostname) return;   // stay in-app for our own pages
        e.preventDefault();
        post(a.href);
      }, true);
    })();
    """

    private static func openExternally(_ raw: String) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName, let raw = message.body as? String else { return }
        Self.openExternally(raw)
    }

    // Belt and braces: anything that still reaches the native path goes out too.
    func webView(_ wv: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { Self.openExternally(url.absoluteString) }
        return nil
    }

    /// The only origin ever loaded is our own loopback server, so this is a
    /// grant. The Info.plist usage string is what the user actually sees.
    func webView(_ wv: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // JS dialogs would otherwise be silently dropped in a WKWebView.
    func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = "Artemis"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.runModal()
        completionHandler()
    }
}
