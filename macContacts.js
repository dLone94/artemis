// Reading a phone number from the user's macOS Contacts — the address book
// they already maintain — so Artemis stops asking for numbers that live ten
// pixels away. Read-only, used only as a fallback after the local alias
// store, and every found number is cached there so Contacts is consulted at
// most once per person. First launch triggers the macOS Contacts permission
// prompt, attributed to the app that owns the server process.
import { execFile } from "node:child_process";

// name → first matching person's display name + first phone number
const LOOKUP_SCRIPT = `
on run argv
  set queryName to item 1 of argv
  tell application "Contacts"
    set matches to (every person whose name contains queryName)
    if (count of matches) is 0 then return ""
    set thePerson to item 1 of matches
    set phoneValues to value of phones of thePerson
    if (count of phoneValues) is 0 then return ""
    return (name of thePerson) & "\n" & (item 1 of phoneValues)
  end tell
end run
`;

// relationship label ("spouse", "mother", …) → the related person's name,
// read from the user's own "me" card
const RELATION_SCRIPT = `
on run argv
  set queryLabel to item 1 of argv
  tell application "Contacts"
    set meCard to my card
    repeat with rel in (related names of meCard)
      set relLabel to (label of rel) as text
      ignoring case
        if relLabel contains queryLabel then return value of rel
      end ignoring
    end repeat
    return ""
  end tell
end run
`;

// The words people actually say → the labels Contacts actually stores.
const RELATION_ALIASES = {
  wife: "spouse",
  husband: "spouse",
  spouse: "spouse",
  mom: "mother",
  mum: "mother",
  mother: "mother",
  dad: "father",
  father: "father",
  brother: "brother",
  sister: "sister",
  son: "son",
  daughter: "daughter",
  partner: "partner",
};

function runScript(script, arg, opts) {
  if (!opts.run && process.env.ARTEMIS_DISABLE_UI_AUTOMATION === "1") {
    return Promise.resolve(""); // test runs must never touch the real address book
  }
  const run = opts.run || execFile;
  return new Promise((resolve) => {
    run(
      "/usr/bin/osascript",
      ["-e", script, String(arg || "")],
      { timeout: 6000 },
      (err, stdout) => resolve(err ? "" : String(stdout || ""))
    );
  });
}

/** "wife" → the spouse's actual name from the me-card, or null. */
export async function resolveRelation(word, opts = {}) {
  const label = RELATION_ALIASES[(word || "").toLowerCase().trim()];
  if (!label) return null;
  const out = (await runScript(RELATION_SCRIPT, label, opts)).trim();
  return out || null;
}

/** Name → { name, phone } from the first Contacts match with a phone, or null. */
export async function lookupContact(name, opts = {}) {
  const query = (name || "").trim();
  if (query.length < 2) return null;
  const out = (await runScript(LOOKUP_SCRIPT, query, opts)).trim();
  if (!out) return null;
  const newline = out.indexOf("\n");
  if (newline < 0) return null;
  const displayName = out.slice(0, newline).trim();
  const phone = out.slice(newline + 1).trim();
  if (!phone) return null;
  return { name: displayName || query, phone };
}
