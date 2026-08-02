// Tests for handing a message to WhatsApp.
//
// The thing being protected here is a message to a real person. Two failures
// matter: opening a chat with the wrong number, and telling the user something
// was sent when it is still sitting in a text box.
// Run: node test/whatsapp.test.mjs
// Belt AND braces: even when this file runs alone, a missed mock must never
// type into the real WhatsApp. pressSend refuses under this flag.
process.env.ARTEMIS_DISABLE_UI_AUTOMATION = "1";

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

  // a context whose sender records instead of launching WhatsApp — tests must
  // never drive the real app (sendComposed presses Return via System Events)
  const opened = [];
  const ctx = (contact) => ({
    resolveContact: async () => contact,
    sendWhatsApp: async (url) => { opened.push(url); },
    openWhatsApp: async (url) => { throw new Error("draft fallback not expected here"); }
  });

  // happy path
  opened.length = 0;
  const ok = await skill.execute({ to: "wife", body: "twenty minutes late" },
                                 ctx({ name: "Maria", phone: "+359881234567" }));
  assert.equal(ok.ok, true);
  assert.equal(opened.length, 1, "opened exactly one chat");
  assert.ok(opened[0].startsWith("whatsapp://send?phone=359881234567"), "correct recipient");
  assert.match(opened[0], /twenty\+minutes\+late|twenty%20minutes%20late/, "body carried through");

  // THE claim test, inverted by design (2026-08-01): the confirmed send now
  // completes via keystroke, so success SHOULD say sent — and the fallback
  // tests below still forbid "sent" whenever the keystroke didn't run.
  assert.match(ok.summary, /\bsent\b/i, "confirmed send reports sent");
  assert.match(ok.summary, /Maria/, "names who it's for");

  // unknown contact — no launch, and a useful next step
  opened.length = 0;
  const missing = await skill.execute({ to: "wife", body: "hi" }, ctx(null));
  assert.equal(missing.ok, false);
  assert.equal(opened.length, 0, "nothing opened for an unknown contact");
  assert.match(missing.summary, /don't have a number/i);
  // The model, not just the user, has to be told how to recover. Without this
  // it can only retry the identical call — which is exactly the loop the user
  // hit: read back, confirm, "no number", repeat, forever.
  assert.match(String(missing.content || ""), /add_contact|phone/i,
    "the tool result must tell the model how to fix it");

  // THE LOOP FIX: the user says the number, so it arrives as an argument and
  // the message goes out in that same turn.
  opened.length = 0;
  const saved = {};
  const withNumber = await skill.execute(
    { to: "wife", body: "on my way", phone: "+359 88 123 4567" },
    {
      resolveContact: async () => null,
      sendWhatsApp: async (url) => { opened.push(url); },
      readJson: async () => saved,
      writeJson: async (_n, d) => Object.assign(saved, d)
    }
  );
  assert.equal(withNumber.ok, true, "a supplied number is enough to send");
  assert.equal(opened.length, 1, "opened the chat");
  assert.ok(opened[0].includes("phone=359881234567"), "used the number the user gave");
  // and it must not have to be asked twice
  assert.equal(saved.wife && saved.wife.phone, "359881234567", "remembers it for next time");

  // a supplied number that is junk fails honestly instead of dialling nonsense
  opened.length = 0;
  const junk = await skill.execute({ to: "wife", body: "hi", phone: "12345" }, {
    resolveContact: async () => null, sendWhatsApp: async (u) => opened.push(u),
    readJson: async () => ({}), writeJson: async () => {}
  });
  assert.equal(junk.ok, false);
  assert.equal(opened.length, 0);

  // a known contact still wins when no number is supplied
  opened.length = 0;
  const known = await skill.execute({ to: "mom", body: "hi" }, ctx({ name: "Maria", phone: "+359881234567" }));
  assert.equal(known.ok, true);
  assert.equal(opened.length, 1);

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

  // when both the send automation AND the draft fallback fail, that is
  // reported, not papered over
  const boom = await skill.execute({ to: "wife", body: "hi" }, {
    resolveContact: async () => ({ name: "Maria", phone: "+359881234567" }),
    sendWhatsApp: async () => { throw new Error("automation blocked"); },
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

// ---- preconditions are checked BEFORE the confirmation gate -----------------
// The reported loop: message read back, "yes", "I don't have her number",
// repeat. Confirming an action whose preconditions already fail costs the user a
// whole round and then tells them no.
{
  const { precheckSkill } = await import("../skills.js");
  const ctx = (c) => ({ resolveContact: async () => c });

  const noContact = await precheckSkill("send_message", { to: "wife", body: "hi" }, ctx(null));
  assert.equal(noContact.ok, false, "an unknown contact never reaches the confirmation");
  assert.match(noContact.summary, /what's the number/i, "it asks for the missing piece instead");
  assert.match(String(noContact.content), /phone argument/, "and tells the model how to recover");

  const noPhone = await precheckSkill("send_message", { to: "wife", body: "hi" }, ctx({ name: "Maria", phone: "" }));
  assert.equal(noPhone.ok, false);
  const badPhone = await precheckSkill("send_message", { to: "wife", body: "hi" }, ctx({ name: "Maria", phone: "12345" }));
  assert.equal(badPhone.ok, false, "an undiallable stored number is caught before asking");

  // and the cases that CAN succeed still get their confirmation, unchanged
  assert.equal((await precheckSkill("send_message", { to: "wife", body: "hi", phone: "+359881234567" }, ctx(null))).ok, true,
    "a number supplied inline is enough to proceed");
  assert.equal((await precheckSkill("send_message", { to: "mom", body: "hi" }, ctx({ name: "Maria", phone: "+359881234567" }))).ok, true,
    "a good contact still goes through the gate");

  // skills with no precheck are unaffected
  assert.equal((await precheckSkill("open_url", { url: "https://x.dev" }, {})).ok, true);
  console.log("  ✓ an impossible send asks for what's missing instead of confirming first");
}

// ---- completing the send ----------------------------------------------------
// sendComposed must open the chat FIRST, wait for it to settle, and only then
// press Return. A keystroke into the wrong window is a message to the wrong
// person; order and failure honesty are the whole test.
{
  const { sendComposed, pressSend } = await import("../whatsapp.js");
  const calls = [];
  await sendComposed("whatsapp://send?phone=359881234567&text=hi", {
    open: async (url) => calls.push(["open", url]),
    wait: async (ms) => calls.push(["wait", ms]),
    run: (file, args, cb) => { calls.push(["osascript", file]); cb(null, ""); }
  });
  assert.equal(calls.length, 3, "exactly open → wait → keystroke");
  assert.equal(calls[0][0], "open", "chat opens first");
  assert.ok(calls[0][1].startsWith("whatsapp://send?"), "opens the compose link");
  assert.equal(calls[1][0], "wait", "waits for the chat box to focus");
  assert.ok(calls[1][1] >= 1000, "settle time is generous enough for a cold start");
  assert.equal(calls[2][0], "osascript", "then presses Return via System Events");
  console.log("  ✓ sendComposed opens the chat, settles, then presses send — in that order");

  // a failing keystroke must reject, so the skill can fall back to draft-only
  let rejected = false;
  await sendComposed("whatsapp://send?phone=359881234567&text=hi", {
    open: async () => {},
    wait: async () => {},
    run: (file, args, cb) => cb(new Error("osascript not allowed"))
  }).catch(() => { rejected = true; });
  assert.ok(rejected, "automation failure propagates instead of pretending");
  assert.ok(typeof pressSend === "function");
  console.log("  ✓ a blocked keystroke rejects — no false 'sent'");
}

// ---- the skill never lies about sending -------------------------------------
{
  const skill = getSkill("send_message");
  const ctx = {
    resolveContact: async () => ({ name: "Mom", phone: "+359881234567" }),
    readJson: async () => ({}),
    writeJson: async () => {},
    sendWhatsApp: async () => {},               // automation succeeds
    openWhatsApp: async () => { throw new Error("should not fall back"); }
  };
  const sent = await skill.execute({ to: "Mom", body: "on my way" }, ctx);
  assert.ok(sent.ok);
  assert.ok(/sent/i.test(sent.summary), "success says sent");

  const ctxBlocked = {
    ...ctx,
    sendWhatsApp: async () => { throw new Error("accessibility denied"); },
    openWhatsApp: async () => {}                // draft fallback works
  };
  const draft = await skill.execute({ to: "Mom", body: "on my way" }, ctxBlocked);
  assert.ok(draft.ok);
  assert.ok(!/^sent/i.test(draft.summary), "fallback never claims sent");
  assert.ok(/press enter/i.test(draft.summary), "fallback tells the user to finish it");
  console.log("  ✓ send_message: 'sent' only when the keystroke ran; honest draft otherwise");
}

// ---- macOS Contacts fallback -------------------------------------------------
// The lookup only ever runs with an injected runner in tests (and the env
// kill-switch blocks the real osascript regardless). What matters: parsing,
// relationship mapping, and silent-null on every failure mode.
{
  const { lookupContact, resolveRelation } = await import("../macContacts.js");

  const hit = await lookupContact("Maria", {
    run: (file, args, o, cb) => cb(null, "Maria Topalova\n+359 88 888 1234\n")
  });
  assert.deepEqual(hit, { name: "Maria Topalova", phone: "+359 88 888 1234" });

  assert.equal(await lookupContact("Maria", { run: (f, a, o, cb) => cb(null, "") }), null, "no match → null");
  assert.equal(await lookupContact("Maria", { run: (f, a, o, cb) => cb(new Error("denied")) }), null, "no permission → null");
  assert.equal(await lookupContact("M", { run: () => { throw new Error("should not run"); } }), null, "too-short query never queries");

  let asked = null;
  const spouse = await resolveRelation("wife", {
    run: (f, args, o, cb) => { asked = args[2]; cb(null, "Maria Topalova\n"); }
  });
  assert.equal(spouse, "Maria Topalova");
  assert.equal(asked, "spouse", "'wife' queries the spouse label");
  assert.equal(await resolveRelation("plumber", { run: () => { throw new Error("no"); } }), null, "unknown relations never query");
  console.log("  ✓ Contacts fallback parses hits, maps 'wife'→spouse, and fails to null");
}
