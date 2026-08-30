// Presentation vs. runtime: hiding the dashboard WINDOW must not silence
// Artemis (Part D1). The native shell owns windows; this module owns the one
// policy decision the page keeps making — "may the voice runtime keep running
// while the document is hidden?" — so it stays testable and in one place.
//
//   full        — dashboard visible; a hidden document means the user left
//                 (other Space, minimized) and the old rule holds: no hidden
//                 hot mic, wake pauses until the page is visible again.
//   pill        — dashboard hidden BY DESIGN, floating pill visible. The pill
//                 is the on-screen open-mic indicator, so the voice runtime
//                 stays fully alive. Only meaningful inside the native shell —
//                 a plain browser has no pill window to point at.
//   background  — everything hidden. No visible surface may vouch for an open
//                 microphone, so voice suspends exactly like a hidden tab.
//
// Pure and DOM-free (unit-tested in test/presentationPolicy.test.mjs).

/**
 * Should the voice runtime treat itself as suspended?
 * @param {boolean} documentHidden - the page's document.hidden
 * @param {string} presentationMode - "full" | "pill" | "background"
 * @param {boolean} inShell - running inside the native ArtemisShell
 */
export function voiceSuspended(documentHidden, presentationMode, inShell) {
  if (!documentHidden) return false;
  return !(inShell && presentationMode === "pill");
}
