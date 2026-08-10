// The capability contract.
//
// public/capabilities.js is a set of PROMISES shown to the user in two places
// (the index.html constellation and the About guide). The dangerous failure is
// not a typo — it is a card that says "LIVE" for something that was renamed,
// gutted, or never built. These tests bind each claim to the machinery that
// would have to exist for it to be true.
//
// Run: node --test test/capabilities.test.mjs
import assert from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const { CAPABILITIES, STATE_LABEL, capability } = await import("../public/capabilities.js");

const STATES = new Set(["live", "optional", "planned"]);
const REQUIRED = [
  "id", "label", "icon", "blurb", "state",
  "href", "sayExamples", "local", "connected", "safety"
];

// ---- (a) shape ---------------------------------------------------------------
test("every capability carries the full contract", () => {
  assert.ok(CAPABILITIES.length > 0, "there must be capabilities to render");

  const ids = new Set();
  for (const cap of CAPABILITIES) {
    const where = `capability "${cap.id || "<no id>"}"`;
    for (const field of REQUIRED) {
      assert.ok(cap[field] != null && cap[field] !== "", `${where} is missing ${field}`);
    }
    assert.ok(!ids.has(cap.id), `${where} has a duplicate id`);
    ids.add(cap.id);

    assert.ok(STATES.has(cap.state), `${where} has invalid state "${cap.state}"`);
    assert.ok(STATE_LABEL[cap.state], `${where} state has no display label`);

    assert.ok(cap.blurb.length <= 90,
      `${where} blurb is ${cap.blurb.length} chars — the constellation and card layouts assume <= 90`);

    assert.ok(Array.isArray(cap.sayExamples), `${where} sayExamples must be an array`);
    assert.ok(cap.sayExamples.length >= 2 && cap.sayExamples.length <= 3,
      `${where} must offer 2-3 spoken examples, got ${cap.sayExamples.length}`);
    cap.sayExamples.forEach((s) =>
      assert.ok(typeof s === "string" && s.trim(), `${where} has an empty say example`));

    assert.equal(capability(cap.id), cap, `${where} must be findable by id`);
  }
});

// ---- (b) honesty -------------------------------------------------------------
test("nothing unbuilt is advertised as live", () => {
  const home = capability("home");
  assert.ok(home, "the home capability should still be listed as a roadmap item");
  assert.notEqual(home.state, "live",
    "home & life admin is not implemented — marking it live would be a lie to the user");
  assert.equal(home.state, "planned");
});

test("every capability href resolves to something that exists", () => {
  const ids = new Set(CAPABILITIES.map((c) => c.id));
  for (const cap of CAPABILITIES) {
    if (cap.href.startsWith("about.html#")) {
      const anchor = cap.href.split("#")[1];
      assert.ok(anchor.startsWith("cap-"), `${cap.id} anchor must be a cap- anchor, got ${anchor}`);
      const target = anchor.slice("cap-".length);
      assert.ok(ids.has(target),
        `${cap.id} links to #${anchor}, but no capability generates that anchor`);
    } else {
      // a real route: it must map to a file that is actually served
      const file = cap.href === "/gym" ? "public/gym.html" : "public" + cap.href;
      assert.ok(existsSync(join(ROOT, file)),
        `${cap.id} links to ${cap.href} but ${file} does not exist`);
    }
  }
});

test("the About guide generates an anchor for every capability", () => {
  // The hrefs above are only safe because the guide is generated from the SAME
  // array — assert that, rather than trusting a hand-maintained anchor list.
  const guide = read("public/capabilityGuide.js");
  assert.ok(guide.includes('from "./capabilities.js"'),
    "the guide must render from the shared capability array");
  assert.ok(/CAPABILITIES\.forEach/.test(guide),
    "the guide must iterate every capability, not a subset");
  assert.ok(/card\.id\s*=\s*"cap-"\s*\+\s*cap\.id/.test(guide),
    "each card's anchor must be derived from the capability id");
});

// ---- (c) a live claim needs real machinery ----------------------------------
test("every live capability is backed by a registered tool family", () => {
  const registry = read("toolRegistry.js");
  const skills = read("skills.js");

  // capability id -> markers that must appear in the registry (or skills.js)
  const BACKING = {
    money: ["map", "ledger"],
    gym: ["gym"],
    brief: ["briefing"],
    notes: ["vault"],
    email: ["email"],
    meetings: ["meeting"],
    research: ["research", "web_research"]
  };

  for (const cap of CAPABILITIES.filter((c) => c.state === "live")) {
    const markers = BACKING[cap.id];
    assert.ok(markers,
      `"${cap.id}" claims to be live but this test has no expected tool family for it — ` +
      "add one, or the capability is unverifiable");
    const found = markers.some((m) =>
      registry.includes(`"${m}"`) || skills.includes(`"${m}"`));
    assert.ok(found,
      `"${cap.id}" is marked live but none of [${markers.join(", ")}] appears in the tool registry — ` +
      "a capability cannot claim live without its machinery");
  }
});

// ---- (d) the constellation is actually wired in ------------------------------
test("index.html wires the constellation to the shared array", () => {
  const index = read("public/index.html");
  assert.ok(index.includes("constellation.js"),
    "index.html must load the constellation module");
  assert.ok(index.includes("constellation.css"),
    "index.html must load the constellation styles");

  // index.html reaches capabilities.js THROUGH constellation.js; assert the
  // chain rather than a string that would pass while the data went stale.
  const constellation = read("public/constellation.js");
  assert.ok(constellation.includes('from "./capabilities.js"'),
    "the constellation must render from the shared capability array");
  assert.ok(/CAPABILITIES\.forEach/.test(constellation),
    "the constellation must plot every capability");
});

test("the constellation renders honest state and accessible targets", () => {
  const constellation = read("public/constellation.js");
  const css = read("public/constellation.css");

  assert.ok(constellation.includes("a.href = cap.href"),
    "each orb must be a real link so keyboard Enter follows it");
  assert.ok(/aria-label/.test(constellation),
    "each orb must carry an accessible name including its blurb");
  assert.ok(/STATE_LABEL\[cap\.state\]/.test(constellation),
    "optional and planned states must be rendered, not hidden");

  assert.ok(/min-width:\s*44px/.test(css) && /min-height:\s*44px/.test(css),
    "orb targets must be at least 44px");
  assert.ok(/prefers-reduced-motion/.test(css),
    "the drift animation must be disabled under prefers-reduced-motion");
});
