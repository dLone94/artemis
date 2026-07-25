// Tests for handing a message to WhatsApp.
//
// The thing being protected here is a message to a real person. Two failures
// matter: opening a chat with the wrong number, and telling the user something
// was sent when it is still sitting in a text box.
// Run: node test/whatsapp.test.mjs
import assert from "node:assert";
import { normalizePhone, composeUrl, openLocally } from "../whatsapp.js";
import { getSkill } from "../skills.js";

// ---- phone normalisation ----------------------------------------------------
{
  // the formats people actually write
  assert.equal(normalizePhone("+359 88 123 4567"), "359881234567");
  assert.equal(normalizePhone("00359881234567"), "359881234567");
  assert.equal(normalizePhone("(359) 88-123-4567"), "359881234567");
  assert.equal(normalizePhone("+1 (555) 123-4567"), "15551234567");
  assert.equal(normalizePhone("359881234567"), "359881234567");
  assert.equal(normalizePhone("  +359881234567  "), "359881234567");

  // and the ones that must not silently become a wrong number
  assert.equal(normalizePhone(""), null, "empty");
  assert.equal(normalizePhone(null), null, "null");
  assert.equal(normalizePhone("1234567"), null, "too short to be international");
  assert.equal(normalizePhone("1234567890123456"), null, "longer than E.164 allows");
  assert.equal(normalizePhone("call mom"), null, "a name is not a number");
  assert.equal(normalizePhone("+359-88-ABC-4567"), null, "letters mid-number");
  console.log("  ✓ phone numbers normalise, and bad ones are refused rather than guessed");
}

// ---- URL composition --------------------------------------------------------
{
  const url = composeUrl("+359 88 123 4567", "on my way");
  assert.ok(url.startsWith("whatsapp://send?"), "uses the WhatsApp scheme");
  const q = new URLSearchParams(url.slice("whatsapp://send?".length));
  assert.equal(q.get("phone"), "359881234567", "phone is normalised in the URL");
  assert.equal(q.get("text"), "on my way");

  // the characters that break naive string concatenation
  for (const body of ["tea & biscuits?", "line one\nline two", "running late 😅", 'he said "yes"', "100% sure"]) {
    const u = composeUrl("359881234567", body);
    const parsed = new URLSearchParams(u.slice("whatsapp://send?".length));
    assert.equal(parsed.get("text"), body, `round-trips: ${JSON.stringify(body)}`);
  }

  // an ampersand must not be able to forge another parameter
  const sneaky = composeUrl("359881234567", "hi&phone=19999999999");
  const sq = new URLSearchParams(sneaky.slice("whatsapp://send?".length));
  assert.equal(sq.get("phone"), "359881234567", "a body cannot override the recipient");

  assert.throws(() => composeUrl("nonsense", "hi"), /invalid phone/, "won't build a URL for a bad number");
  console.log("  ✓ URLs encode correctly and a message body can't rewrite the recipient");
}

// ---- the launch boundary ----------------------------------------------------
{
  // Letting the server launch local applications is a new capability. Only the
  // WhatsApp scheme may pass, or a crafted "url" becomes arbitrary app launch.
  for (const bad of ["http://evil.example", "file:///etc/passwd", "javascript:alert(1)",
                     "x-apple-shortcut://run", "", "WHATSAPP://send?phone=1"]) {
    await assert.rejects(() => openLocally(bad), /non-WhatsApp/, `refuses ${JSON.stringify(bad)}`);
  }
  console.log("  ✓ only whatsapp:// URLs can be opened");
}

// ---- the skill ---------------------------------------------------------------
{
  const skill = getSkill("send_message");
  assert.equal(skill.requiresConfirmation, true, "messaging a person always needs an explicit yes");

  // a context whose opener records instead of launching WhatsApp
  const opened = [];
  const ctx = (contact) => ({
    resolveContact: async () => contact,
    openWhatsApp: async (url) => { opened.push(url); }
  });

  // happy path
  opened.length = 0;
  const ok = await skill.execute({ to: "wife", body: "twenty minutes late" },
                                 ctx({ name: "Maria", phone: "+359881234567" }));
  assert.equal(ok.ok, true);
  assert.equal(opened.length, 1, "opened exactly one chat");
  assert.ok(opened[0].startsWith("whatsapp://send?phone=359881234567"), "correct recipient");
  assert.match(opened[0], /twenty\+minutes\+late|twenty%20minutes%20late/, "body carried through");

  // THE claim test: it must never say the message was sent, because it wasn't
  assert.match(ok.summary, /press Enter/i, "tells the user what's left to do");
  assert.doesNotMatch(ok.summary, /\bsent\b|\bI sent\b/i, "must not claim it was sent");
  assert.match(ok.summary, /Maria/, "names who it's for");

  // unknown contact — no launch, and a useful next step
  opened.length = 0;
  const missing = await skill.execute({ to: "wife", body: "hi" }, ctx(null));
  assert.equal(missing.ok, false);
  assert.equal(opened.length, 0, "nothing opened for an unknown contact");
  assert.match(missing.summary, /don't have a number/i);

  // contact saved without a number
  opened.length = 0;
  const noPhone = await skill.execute({ to: "wife", body: "hi" }, ctx({ name: "Maria", phone: "" }));
  assert.equal(noPhone.ok, false);
  assert.equal(opened.length, 0);
  assert.match(noPhone.summary, /without a phone number/i);

  // stored number that can't be dialled
  opened.length = 0;
  const bad = await skill.execute({ to: "wife", body: "hi" }, ctx({ name: "Maria", phone: "12345" }));
  assert.equal(bad.ok, false);
  assert.equal(opened.length, 0);
  assert.match(bad.summary, /country code/i);

  // a failing opener is reported, not papered over
  const boom = await skill.execute({ to: "wife", body: "hi" }, {
    resolveContact: async () => ({ name: "Maria", phone: "+359881234567" }),
    openWhatsApp: async () => { throw new Error("WhatsApp is not responding"); }
  });
  assert.equal(boom.ok, false);
  assert.match(boom.summary, /couldn't open WhatsApp/i);
  console.log("  ✓ send_message opens the right chat, and never claims more than it did");
}

// ---- saving a contact --------------------------------------------------------
{
  const add = getSkill("add_contact");
  const store = {};
  const ctx = {
    readJson: async () => store,
    writeJson: async (_n, d) => Object.assign(store, d)
  };
  const saved = await add.execute({ alias: "wife", name: "Maria", phone: "+359 88 123 4567" }, ctx);
  assert.equal(saved.ok, true);
  assert.equal(store.wife.phone, "359881234567", "normalised at save time, not at send time");

  const rejected = await add.execute({ alias: "wife", name: "Maria", phone: "12345" }, ctx);
  assert.equal(rejected.ok, false, "an undiallable number fails while you're still talking about it");
  assert.match(rejected.summary, /country code/i);
  console.log("  ✓ contacts normalise on save, so a bad number fails early");
}

console.log("PASS ✅  whatsapp: right recipient, encoded body, and an honest summary");
