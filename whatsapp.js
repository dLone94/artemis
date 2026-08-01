// Handing a message to WhatsApp on this Mac.
//
// It opens the chat with the text already typed and stops there — the user
// presses Enter. That is deliberate. The message goes to a real person and it
// came out of a microphone, so a mis-transcription would be something you can't
// unsend. The confirm gate reads the words back before anything happens, and
// this gives a second look at them in WhatsApp's own window.
//
// It also uses Apple's public `whatsapp://` URL scheme rather than driving the
// UI, which means no Accessibility permission and nothing that breaks the next
// time WhatsApp moves a button.

import { execFile } from "child_process";
import { existsSync } from "fs";

const APP_PATH = "/Applications/WhatsApp.app";

export function whatsappInstalled() {
  return existsSync(APP_PATH);
}

/**
 * A spoken or pasted phone number to the bare digits WhatsApp wants.
 *
 * "+359 88 123 4567" -> "359881234567". A leading 00 is the other way people
 * write an international prefix, so it is treated the same as "+".
 *
 * @returns {string|null} null when it isn't a plausible number — better to say
 *   so than to open a chat with a stranger.
 */
export function normalizePhone(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (/[a-z]/i.test(s)) return null;          // a name is not a number
  s = s.replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  if (!/^\d+$/.test(s)) return null;
  // E.164 allows up to 15 digits; anything under 8 is a short code or a typo
  if (s.length < 8 || s.length > 15) return null;
  return s;
}

/** Build the deep link. Encoding matters: bodies contain & and newlines. */
export function composeUrl(phone, text) {
  const digits = normalizePhone(phone);
  if (!digits) throw new Error("invalid phone number");
  const q = new URLSearchParams({ phone: digits, text: String(text == null ? "" : text) });
  return "whatsapp://send?" + q.toString();
}

/**
 * Hand a URL to macOS.
 *
 * The server being able to launch local applications is a new capability, so
 * this is its boundary: only `whatsapp:` gets through, and the URL is passed as
 * an argument array rather than a shell string so nothing in a message body can
 * ever be interpreted as a command.
 */
export function openLocally(url) {
  const u = String(url || "");
  if (!u.startsWith("whatsapp://")) {
    return Promise.reject(new Error("refusing to open a non-WhatsApp URL"));
  }
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [u], (err) => (err ? reject(err) : resolve()));
  });
}

// ---- Completing the send ----------------------------------------------------
// The compose deep link leaves the message typed in the chat box with focus on
// it. Pressing Return there is the entire remaining gesture — automated below
// via System Events, so Artemis can genuinely reply after the user confirms.
// The confirmation gate stays with the caller; this module only performs.

const SEND_KEYSTROKE_SCRIPT = `
tell application "WhatsApp" to activate
delay 0.2
tell application "System Events"
  tell process "WhatsApp"
    set frontmost to true
  end tell
  keystroke return
end tell
`;

// How long the compose deep link needs before the chat box is focused.
// Cold starts are slower; the fallback path covers a miss honestly.
const COMPOSE_SETTLE_MS = 1800;

export function pressSend(opts = {}) {
  // Hard kill-switch: the test suite (and anything else that must never type
  // into real apps) sets this. A missed mock then fails loudly instead of
  // firing a keystroke at whatever window is frontmost.
  if (!opts.run && process.env.ARTEMIS_DISABLE_UI_AUTOMATION === "1") {
    return Promise.reject(new Error("UI automation disabled (ARTEMIS_DISABLE_UI_AUTOMATION=1)"));
  }
  const run = opts.run || execFile;
  return new Promise((resolve, reject) => {
    run("/usr/bin/osascript", ["-e", SEND_KEYSTROKE_SCRIPT], (err) =>
      err ? reject(err) : resolve()
    );
  });
}

// Open the compose deep link, give WhatsApp time to focus the prefilled chat
// box, then press Return in it.
export async function sendComposed(url, opts = {}) {
  const openFn = opts.open || openLocally;
  const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  await openFn(url);
  await wait(opts.settleMs ?? COMPOSE_SETTLE_MS);
  await pressSend(opts);
}
