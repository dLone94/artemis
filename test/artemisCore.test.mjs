// The Artemis Core's RENDER path, driven for real.
//
// coreState.test.mjs proves the view-model decides correctly. This proves the
// renderer that consumes it does not throw, draws what each state calls for,
// and honours the VoiceOrb contract the rest of the app is still wired to.
//
// It runs the actual shipped class against a recording fake canvas rather than
// a copy of its logic. A headless screenshot would be better for judging how it
// LOOKS, but Chrome cannot capture in this sandbox (it fails on a data: URL
// too), and looks are not what silently regresses — wiring is.
//
// Run: node --test test/artemisCore.test.mjs

import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

// ---- minimal browser surface, installed before importing the module --------
function recordingCtx() {
  const rec = { fillText: [], arcs: [], strokes: 0, fills: 0, clears: 0, gradients: 0 };
  const ctx = {
    _rec: rec,
    canvas: null,
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "",
    shadowBlur: 0, shadowColor: "", textAlign: "", textBaseline: "",
    lineCap: "", letterSpacing: "0px", globalAlpha: 1,
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    clearRect() { rec.clears++; },
    beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {},
    arc(x, y, r, a0, a1) { rec.arcs.push({ x, y, r, a0, a1 }); },
    ellipse() {},
    rect() {},
    clip() { rec.clips = (rec.clips || 0) + 1; },
    fill() { rec.fills++; },
    stroke() { rec.strokes++; },
    fillText(text, x, y) { rec.fillText.push({ text: String(text), x, y }); },
    measureText(t) { return { width: String(t).length * 6 }; },
    createRadialGradient() { rec.gradients++; return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    setLineDash() {}
  };
  return ctx;
}

function installDom({ reducedMotion = false, width = 600, height = 600 } = {}) {
  const rafQueue = [];
  const canvases = [];
  const win = {
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: (q) => ({ matches: reducedMotion && /reduce/.test(q), addListener() {}, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    AudioContext: undefined,
    webkitAudioContext: undefined
  };
  const doc = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      if (tag !== "canvas") return { style: {}, appendChild() {} };
      const ctx = recordingCtx();
      const el = { width: 0, height: 0, style: {}, className: "", getContext: () => ctx, _ctx: ctx };
      ctx.canvas = el;
      canvases.push(el);
      return el;
    }
  };
  const container = {
    children: [],
    appendChild(c) { this.children.push(c); },
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 })
  };

  globalThis.window = win;
  globalThis.document = doc;
  // A CONTROLLED clock. The Core eases every state mix by the real elapsed dt,
  // so with node's live performance.now() a tight loop of _loop() calls sees
  // dt~0 and nothing ever settles. Owning the clock makes motion deterministic.
  const clock = { t: 0 };
  globalThis.performance = { now: () => clock.t };
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;

  return { win, doc, container, canvases, rafQueue, clock, ctx: () => canvases[0]._ctx };
}

// Import once the globals exist — orbShared.js reads window.matchMedia.
installDom();
const { ArtemisCore, CORE_GEOMETRY, CORE_PRESENTATION_GROUPS } = await import("../public/artemisCore.js");
const { CAPABILITIES } = await import("../public/coreCapabilities.js");

/** Build a Core with a fresh fake DOM and force one draw. */
function mount(opts = {}) {
  const dom = installDom(opts);
  const core = new ArtemisCore(dom.container, {});
  return { core, dom, ctx: () => dom.canvases[0]._ctx };
}

/** Force a synchronous redraw regardless of throttling. */
function draw(core) {
  core._draw(core._elapsed || 1);
}

/** Run `frames` animation frames of `ms` each against the controlled clock. */
function run({ core, dom }, frames = 60, ms = 16, each) {
  for (let i = 0; i < frames; i++) {
    dom.clock.t += ms;
    if (each) each(core);
    core._loop();
  }
}

test("the Core mounts a canvas and draws without throwing", () => {
  const { core, dom } = mount();
  assert.strictEqual(dom.container.children.length, 1, "one canvas appended to the stage");
  assert.doesNotThrow(() => draw(core));
  assert.ok(dom.canvases[0]._ctx._rec.clears > 0, "it actually painted a frame");
});

test("it matches the reference identity lockup at the centre", () => {
  const { core, ctx } = mount();
  draw(core);
  const texts = ctx()._rec.fillText.map((f) => f.text);
  assert.ok(texts.includes("ARTEMIS"), `expected ARTEMIS at the centre, drew: ${texts.join("|")}`);
  assert.ok(texts.includes("INTELLIGENCE CORE"), "the reference subtitle must sit under ARTEMIS");
});

test("the active task remains in the Core view model for the dashboard readout", () => {
  const { core, ctx } = mount();
  core.setStatus("thinking");
  core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  ctx()._rec.fillText.length = 0;
  draw(core);
  const texts = ctx()._rec.fillText.map((f) => f.text);
  assert.strictEqual(core.view.label, "EXECUTING");
  assert.strictEqual(core.view.task, "Opening media");
  assert.deepStrictEqual(texts.filter((text) => text === "ARTEMIS" || text === "INTELLIGENCE CORE"),
    ["ARTEMIS", "INTELLIGENCE CORE"], "live activity must not crowd the reference lockup");
  core.destroy();
});

test("left state orbs reuse the physical Core material and carry distinct state signals", () => {
  const css = read("public/reference.css");
  assert.match(css, /\.v4-mini-core::before[\s\S]*artemis-core-material\.png/,
    "left state orbs must use the same glass-and-metal material as the main Core");
  for (const state of ["idle", "listening", "thinking", "executing", "speaking", "approval", "error"]) {
    assert.match(css, new RegExp(`data-v4-state="${state}"[\\s\\S]{0,500}\\.v4-mini-core`),
      `${state} needs its own miniature-Core treatment`);
  }
  assert.match(css, /width:\s*min\(100%,\s*88px\)/,
    "the left assemblies must have the substantial proportions in the reference");
});

test("all five depth layers paint", () => {
  // Each layer is a named method; this asserts they exist AND that a frame
  // actually routes through them rather than silently no-opping.
  const { core } = mount();
  for (const layer of ["_drawField", "_drawOrbital", "_drawTraffic", "_drawIris", "_drawNucleus"]) {
    assert.strictEqual(typeof core[layer], "function", `missing layer: ${layer}`);
  }
  const calls = [];
  for (const layer of ["_drawField", "_drawOrbital", "_drawTraffic", "_drawIris", "_drawNucleus"]) {
    const original = core[layer].bind(core);
    core[layer] = (...a) => { calls.push(layer); return original(...a); };
  }
  draw(core);
  assert.deepStrictEqual(calls, ["_drawField", "_drawOrbital", "_drawTraffic", "_drawIris", "_drawNucleus"],
    "layers must paint back-to-front in depth order");
});

test("the nucleus is a lit body, not a flat black disk", () => {
  const { core, ctx } = mount();
  ctx()._rec.gradients = 0;
  ctx()._rec.strokes = 0;
  draw(core);
  assert.ok(ctx()._rec.gradients > 0, "the nucleus needs a radial gradient body");
  // Filaments + interference + motes all add strokes/fills inside the nucleus.
  assert.ok(ctx()._rec.strokes > 20, `expected internal detail, got ${ctx()._rec.strokes} strokes`);
});

test("the reference Core material owns the dense chassis while Canvas supplies four live axial beacons", () => {
  const { core, ctx } = mount({ width: 800, height: 800 });
  ctx()._rec.arcs.length = 0;
  draw(core);
  const R = core._radius;
  const css = read("public/reference.css");
  assert.match(css, /background:\s*url\("artemis-core-material\.png"\)/,
    "the local generated material must supply the photorealistic chassis");
  assert.match(css, /transform:\s*scale\(0\.66\)/,
    "the solid chassis must float inside, not fill, the orbital field");

  const beaconRadius = R * 0.41;
  const beacons = ctx()._rec.arcs.filter((arc) => {
    const distance = Math.hypot(arc.x, arc.y);
    const onAxis = Math.min(Math.abs(arc.x), Math.abs(arc.y)) < R * 0.015;
    return onAxis && Math.abs(distance - beaconRadius) < R * 0.035 && arc.r <= 5;
  });
  assert.ok(beacons.length >= 4, `expected four cardinal beacons, found ${beacons.length}`);
  core.destroy();
});

test("a real tool start opens OUTBOUND traffic toward the capability", () => {
  const { core } = mount();
  const live = () => [...core._pkNode].filter((n) => n !== -1).length;
  assert.strictEqual(live(), 0, "no traffic before a tool runs");

  core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  assert.ok(live() > 0, "tool start must emit a packet");
  const i = [...core._pkNode].findIndex((n) => n !== -1);
  assert.strictEqual(core._pkDir[i], 1, "the first packet must travel Core -> capability");
  core.destroy();
});

test("a real tool result sends INBOUND traffic back, tinted by the outcome", () => {
  const { core } = mount();
  core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  core.toolEvent({ name: "play_media", family: "media", phase: "end", ok: true });
  const inbound = [...core._pkNode].map((n, i) => ({ n, i }))
    .filter((p) => p.n !== -1 && core._pkDir[p.i] === -1);
  assert.ok(inbound.length >= 3, `expected a return burst, got ${inbound.length}`);
  assert.ok(inbound.every((p) => core._pkKind[p.i] === 1), "success must tint the return");

  const fail = mount().core;
  fail.toolEvent({ name: "delete_email", family: "email", phase: "start" });
  fail.toolEvent({ name: "delete_email", family: "email", phase: "end", ok: false });
  const errs = [...fail._pkNode].map((n, i) => i).filter((i) => fail._pkNode[i] !== -1 && fail._pkKind[i] === -1);
  assert.ok(errs.length > 0, "a failure must be visually distinct from a success");
  core.destroy(); fail.destroy();
});

test("traffic is never invented for an unknown capability", () => {
  const { core } = mount();
  core.toolEvent({ name: "mystery", family: "teleportation", phase: "start" });
  assert.strictEqual([...core._pkNode].filter((n) => n !== -1).length, 0);
  assert.strictEqual(core._activeNode, -1);
  core.destroy();
});

test("packets actually travel and then retire", () => {
  const { core } = mount();
  core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  const i = [...core._pkNode].findIndex((n) => n !== -1);
  const t0 = core._pkT[i];
  core._stepPackets(0.2);
  assert.ok(core._pkT[i] > t0, "an outbound packet must advance");
  core._stepPackets(5);
  assert.strictEqual(core._pkNode[i], -1, "a finished packet must return to the pool");
  core.destroy();
});

test("LISTENING drives the iris from REAL amplitude", () => {
  const m = mount();
  m.core.setStatus("listening");
  run(m, 90);                                   // settle in silence
  const quiet = m.core._irisOpen;

  run(m, 90, 16, (c) => c.feed(0.9));           // now she is hearing speech
  assert.ok(m.core._irisOpen > quiet + 0.1,
    `speech must open the iris (quiet ${quiet.toFixed(3)} -> loud ${m.core._irisOpen.toFixed(3)})`);

  run(m, 120);                                  // silence again
  assert.ok(m.core._irisOpen < quiet + 0.06, "the iris must close back down when she stops hearing you");
  m.core.destroy();
});

test("LISTENING is substantially different from STANDBY", () => {
  const idle = mount();
  run(idle, 60);
  const listen = mount();
  listen.core.setStatus("listening");
  run(listen, 60, 16, (c) => c.feed(0.7));
  assert.ok(listen.core._irisOpen > idle.core._irisOpen * 1.8, "the aperture must visibly open");
  assert.ok(listen.core._energy > idle.core._energy * 2, "energy must clearly rise");
  idle.core.destroy(); listen.core.destroy();
});

test("WAITING suspends motion rather than animating normally", () => {
  const m = mount();
  m.core.setStatus("listening");
  m.core.setPendingConfirm(true);
  run(m, 90);
  assert.strictEqual(m.core.view.label, "WAITING");
  assert.ok(m.core._holdMix > 0.7, `the suspended mix must engage, got ${m.core._holdMix.toFixed(3)}`);
  assert.ok(m.core._irisOpen < 0.35, `the aperture closes while waiting, got ${m.core._irisOpen.toFixed(3)}`);
  m.core.destroy();
});

test("ERROR disrupts in a controlled way instead of flooding the view", () => {
  const m = mount();
  m.core.setStatus("error");
  m.core.setError("Could not reach Gmail");
  run(m, 90);
  assert.strictEqual(m.core.view.label, "FAULT");
  assert.ok(m.core._faultMix > 0.7, `the fault mix must engage, got ${m.core._faultMix.toFixed(3)}`);
  assert.ok(m.core.view.energy < 0.4, "an error must stay low-energy, not catastrophic");
  m.core.destroy();
});

test("REASONING moves several layers independently, not as one object", () => {
  // The failure mode this guards is "spin the whole visualization as one
  // rigid thing". Measured, not grepped: sample each track's actual arc angle
  // across two frames and prove they move at different rates in OPPOSITE
  // directions.
  const m = mount({ width: 800, height: 800 });
  m.core.setStatus("thinking");
  run(m, 90);
  assert.ok(m.core._workMix > 0.7, "the computation mix must engage while reasoning");

  const R = m.core._radius;
  // Discover the computation tracks from what was actually drawn rather than
  // hardcoding radii — the layout constants are free to move, the behaviour
  // (two multi-segment tracks, counter-rotating, different rates) is not.
  const tracksIn = (rec) => {
    const byRadius = new Map();
    for (const a of rec.arcs) {
      if (a.a0 == null) continue;
      if (a.r < R * 0.5 || a.r > R * 0.95) continue; // the computation band
      const key = Math.round(a.r);
      if (!byRadius.has(key)) byRadius.set(key, []);
      byRadius.get(key).push(a.a0);
    }
    // Segmented tracks emit several arcs at one radius; rings emit one.
    return [...byRadius.entries()]
      .filter(([, angles]) => angles.length >= 3)
      .sort((x, y) => y[1].length - x[1].length)
      .slice(0, 2)
      .sort((x, y) => x[0] - y[0]); // inner first
  };

  const sample = () => {
    m.ctx()._rec.arcs.length = 0;
    draw(m.core);
    return tracksIn(m.ctx()._rec);
  };

  const t0 = sample();
  assert.strictEqual(t0.length, 2, `expected two segmented computation tracks, found ${t0.length}`);
  m.core._elapsed += 0.5;
  const t1 = sample();

  const dA = t1[0][1][0] - t0[0][1][0];
  const dB = t1[1][1][0] - t0[1][1][0];
  assert.ok(dA > 0, `the inner track must advance, moved ${dA}`);
  assert.ok(dB < 0, `the outer track must counter-rotate, moved ${dB}`);
  assert.ok(Math.abs(Math.abs(dA) - Math.abs(dB)) > 1e-4,
    `the tracks must move at different rates (${dA} vs ${dB})`);
  m.core.destroy();
});

test("the orbital field is expansive while the physical nucleus stays compact", () => {
  const D = 800;
  const { core } = mount({ width: D, height: D });
  assert.ok(core._radius >= D * 0.46, `expected a larger Core, got ${core._radius}`);
  assert.ok(CORE_GEOMETRY.nucleus >= 0.2 && CORE_GEOMETRY.nucleus <= 0.24,
    `the pupil must retain dark breathing room, got ${CORE_GEOMETRY.nucleus}`);
  assert.ok(CORE_GEOMETRY.trackC >= 0.8,
    `the computation field must remain spacious, got ${CORE_GEOMETRY.trackC}`);
  core.destroy();
});

test("the Core still cannot overflow its slot at that larger size", () => {
  // Growing the Core is only safe if the outermost element still fits. Nodes
  // sit at 0.96R and labels at 0.89R; both must stay inside the half-extent.
  for (const [w, h] of [[800, 800], [1600, 500], [420, 420]]) {
    const { core } = mount({ width: w, height: h });
    draw(core);
    const half = Math.min(w, h) / 2;
    for (let i = 0; i < core._nodeX.length; i++) {
      const d = Math.hypot(core._nodeX[i], core._nodeY[i]);
      assert.ok(d <= half, `node ${i} escapes the slot at ${w}x${h}: ${d.toFixed(1)} > ${half}`);
    }
    core.destroy();
  }
});

test("RESEARCHING produces BOTH outbound and inbound flow", () => {
  // The distinguishing behaviour of research: a query leaves, information
  // comes back. One direction only would just be EXECUTING with a new word.
  const m = mount();
  m.core.setStatus("thinking");
  m.core.toolEvent({ name: "web_search", family: "research", phase: "start" });
  assert.strictEqual(m.core.view.label, "RESEARCHING");

  const seen = new Set();
  // Sample across enough frames for the alternating emitter to cover both.
  for (let f = 0; f < 400; f++) {
    m.dom.clock.t += 16;
    m.core._loop();
    for (let p = 0; p < m.core._pkNode.length; p++) {
      if (m.core._pkNode[p] !== -1) seen.add(m.core._pkDir[p]);
    }
  }
  assert.ok(seen.has(1), "research must send a query outward");
  assert.ok(seen.has(-1), "research must bring information back inward");
  m.core.destroy();
});

test("EXECUTING locks directionally onto exactly one capability", () => {
  const m = mount();
  m.core.setStatus("thinking");
  m.core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  const mediaIndex = CAPABILITIES.findIndex((c) => c.title === "MEDIA");
  assert.strictEqual(m.core._activeNode, mediaIndex, "the active channel must target MEDIA");
  assert.strictEqual(m.core.view.label, "EXECUTING");

  run(m, 40);
  const targets = new Set();
  for (let p = 0; p < m.core._pkNode.length; p++) {
    if (m.core._pkNode[p] !== -1) targets.add(m.core._pkNode[p]);
  }
  assert.deepStrictEqual([...targets], [mediaIndex], "traffic must go only to the active capability");
  m.core.destroy();
});

test("the state label tracks real status changes", () => {
  const { core } = mount();
  const labelAfter = (status) => {
    core.setStatus(status);
    return core.view.label;
  };
  assert.strictEqual(labelAfter("listening"), "LISTENING");
  assert.strictEqual(labelAfter("thinking"), "PROCESSING");
  assert.strictEqual(labelAfter("speaking"), "SPEAKING");
  assert.strictEqual(labelAfter("error"), "FAULT");
});

test("all real capability nodes remain hit-testable behind six legible presentation groups", () => {
  const { core, ctx } = mount();
  draw(core);
  const texts = ctx()._rec.fillText.map((f) => f.text);
  assert.deepStrictEqual(
    CORE_PRESENTATION_GROUPS.map((group) => group.title),
    ["RESEARCH", "COMMS", "MEDIA", "MEMORY", "FINANCE", "BRIEF"]
  );
  for (const group of CORE_PRESENTATION_GROUPS) {
    assert.ok(texts.includes(group.title), `presentation group missing: ${group.title}`);
  }
  const covered = CORE_PRESENTATION_GROUPS.flatMap((group) => group.nodes).sort((a, b) => a - b);
  assert.deepStrictEqual(covered, CAPABILITIES.map((_, index) => index),
    "presentation grouping must cover every real capability exactly once");
  for (let i = 0; i < CAPABILITIES.length; i++) {
    const hit = core.moonInfoAt(core._hitCenterX + core._nodeX[i], core._hitCenterY + core._nodeY[i]);
    assert.strictEqual(hit?.index, i, `real capability node ${i} must stay interactive`);
  }
});

test("a real tool event illuminates the capability that owns it", () => {
  const { core } = mount();
  const mediaIndex = CAPABILITIES.findIndex((c) => c.title === "MEDIA");
  assert.strictEqual(core._nodeTarget[mediaIndex], 0, "quiet before the tool runs");

  core.toolEvent({ name: "play_media", family: "media", phase: "start" });
  assert.strictEqual(core._nodeTarget[mediaIndex], 1, "MEDIA lights while its tool runs");
  assert.strictEqual(core.view.label, "EXECUTING");
  assert.strictEqual(core.view.task, "Opening media");

  // Nothing else may light.
  for (let i = 0; i < CAPABILITIES.length; i++) {
    if (i !== mediaIndex) assert.strictEqual(core._nodeTarget[i], 0, `${CAPABILITIES[i].title} must stay quiet`);
  }
  core.destroy();
});

test("an unknown tool family lights no node at all", () => {
  const { core } = mount();
  core.toolEvent({ name: "mystery", family: "teleportation", phase: "start" });
  for (let i = 0; i < CAPABILITIES.length; i++) {
    assert.strictEqual(core._nodeTarget[i], 0);
  }
  core.destroy();
});

test("capability nodes stay hit-testable for the context-card click", () => {
  // main.js binds stage clicks through moonInfoAt to open a capability card.
  // Losing this would silently remove a working feature.
  const { core } = mount();
  draw(core);
  const i = 3;
  const hit = core.moonInfoAt(core._hitCenterX + core._nodeX[i], core._hitCenterY + core._nodeY[i]);
  assert.ok(hit, "a click on a node must resolve");
  assert.strictEqual(hit.index, i);
  assert.strictEqual(hit.title, CAPABILITIES[i].title);
  assert.ok(hit.what && hit.say, "the card needs its description and example");
});

test("a click in empty space resolves to nothing", () => {
  const { core } = mount();
  draw(core);
  assert.strictEqual(core.moonInfoAt(-9999, -9999), null);
});

test("it publishes window.__artemisAmp — three other views read it", () => {
  const { core } = mount();
  core.feed(0.8);
  core._loop();
  assert.strictEqual(typeof window.__artemisAmp, "number");
  assert.ok(window.__artemisAmp > 0, "a fed amplitude must reach the shared channel");
});

test("reduced motion draws a static frame and schedules no animation", () => {
  const dom = installDom({ reducedMotion: true });
  const core = new ArtemisCore(dom.container, {});
  assert.strictEqual(core.reduced, true);
  assert.strictEqual(dom.rafQueue.length, 0, "no rAF may be scheduled under reduced motion");
  assert.ok(dom.canvases[0]._ctx._rec.clears > 0, "but it still renders once");

  // A state change must repaint immediately rather than wait for a frame.
  const before = dom.canvases[0]._ctx._rec.clears;
  core.setStatus("listening");
  assert.ok(dom.canvases[0]._ctx._rec.clears > before, "state changes repaint under reduced motion");
  assert.strictEqual(core._listenMix, 1, "the static listening frame must still express its real state");
  assert.strictEqual(core._energy, core.view.energy, "the static frame must apply semantic energy without easing");

  const quietIris = core._irisOpen;
  core.feed(0.8);
  assert.ok(core.cur.amp >= 0.8, "real amplitude must reach a reduced-motion frame");
  assert.ok(core._irisOpen > quietIris, "real voice amplitude must still open the static iris");
  assert.strictEqual(window.__artemisAmp, core.cur.amp, "the shared amplitude channel remains live");

  const afterFirstFeed = dom.canvases[0]._ctx._rec.clears;
  for (let i = 0; i < 20; i++) core.feed(i / 20);
  assert.strictEqual(dom.canvases[0]._ctx._rec.clears, afterFirstFeed,
    "high-frequency microphone samples must not animate a reduced-motion frame");

  core.setPendingConfirm(true);
  assert.strictEqual(core._holdMix, 1, "approval waiting must remain visually distinct without animation");
  core.destroy();
});

test("overlapping tool runs keep their real capability active until the last result", () => {
  const { core } = mount();
  const research = CAPABILITIES.findIndex((capability) => capability.title === "RESEARCH");
  core.toolEvent({ name: "web_search", family: "research", phase: "start" });
  core.toolEvent({ name: "open_url", family: "web", phase: "start" });
  assert.strictEqual(core._nodeRuns[research], 2);
  assert.strictEqual(core._nodeTarget[research], 1);

  core.toolEvent({ name: "web_search", family: "research", phase: "end", ok: true });
  assert.strictEqual(core._nodeRuns[research], 1, "one result cannot release its overlapping sibling");
  assert.strictEqual(core._nodeTarget[research], 1);
  assert.strictEqual(core._activeNode, research);

  core.toolEvent({ name: "open_url", family: "web", phase: "end", ok: true });
  assert.strictEqual(core._nodeRuns[research], 0);
  assert.strictEqual(core._activeNode, -1);
  core.destroy();
});

test("a failed overlapping result remains visible after a later sibling succeeds", () => {
  const { core } = mount();
  const research = CAPABILITIES.findIndex((capability) => capability.title === "RESEARCH");
  core.toolEvent({ name: "web_search", family: "research", phase: "start" });
  core.toolEvent({ name: "open_url", family: "web", phase: "start" });
  core.toolEvent({ name: "web_search", family: "research", phase: "end", ok: false });
  core.toolEvent({ name: "open_url", family: "web", phase: "end", ok: true });
  assert.strictEqual(core._nodeResult[research], -1,
    "one real failure must not be overwritten by an overlapping success");
  core.destroy();
});

test("idle throttles redraws; active work does not", () => {
  // Idle animation must be cheap. The rAF still ticks (it owns the amplitude
  // publish) but the expensive canvas work is skipped between throttle windows.
  const { core } = mount();
  core._energy = 0.12;          // calm
  core.cur.amp = 0;
  core._lastDraw = performance.now();
  const before = core.ctx._rec.clears;
  core._loop();
  assert.strictEqual(core.ctx._rec.clears, before, "a calm frame right after a draw must skip painting");

  core.setStatus("thinking");
  core._energy = 0.7;           // busy
  core._loop();
  assert.ok(core.ctx._rec.clears > before, "a busy frame must paint");
  core.destroy();
});

test("the Core scales to its container and never assumes fixed pixels", () => {
  const small = mount({ width: 320, height: 320 });
  const large = mount({ width: 1200, height: 1200 });
  assert.ok(large.core._radius > small.core._radius, "the Core must scale with its slot");
  // Bounded by the SHORTER axis so a wide window makes margins, not overlap.
  const wide = mount({ width: 1600, height: 400 });
  assert.ok(wide.core._radius <= 400 * 0.5, "a wide slot must not let the Core overflow vertically");
});

test("a degenerate (zero-size) container cannot crash the render loop", () => {
  const { core } = mount({ width: 0, height: 0 });
  assert.doesNotThrow(() => draw(core));
});

test("precomputed geometry and fixed-size pools are never replaced or grown", () => {
  // The old globe transformed ~1,400 objects per frame. The rule that keeps
  // this cheap is that ALL geometry is precomputed and the traffic/wave
  // systems are fixed-size pools — so the buffers must be the same objects,
  // at the same length, after a long active run.
  const m = mount();
  const before = {
    pk: m.core._pkNode, wave: m.core._waveLife, frag: m.core._fragA,
    iris: m.core._irisBase, node: m.core._nodeLevel,
    lens: [m.core._pkNode.length, m.core._fragA.length, m.core._irisBase.length]
  };

  m.core.setStatus("thinking");
  m.core.toolEvent({ name: "web_search", family: "research", phase: "start" });
  run(m, 600, 16, (c) => c.feed(0.8));   // ~10s of the busiest state

  assert.strictEqual(m.core._pkNode, before.pk, "the packet pool must not be reallocated");
  assert.strictEqual(m.core._waveLife, before.wave, "the wave pool must not be reallocated");
  assert.strictEqual(m.core._fragA, before.frag, "field geometry must not be rebuilt per frame");
  assert.strictEqual(m.core._irisBase, before.iris, "iris geometry must not be rebuilt per frame");
  assert.strictEqual(m.core._nodeLevel, before.node, "node state must not be reallocated");
  assert.deepStrictEqual(
    [m.core._pkNode.length, m.core._fragA.length, m.core._irisBase.length],
    before.lens,
    "no pool may grow under sustained load"
  );
  m.core.destroy();
});

test("idle stays cheap over time", () => {
  // Idle must throttle painting rather than repaint every frame.
  const m = mount();
  run(m, 30);                       // settle into standby
  const start = m.ctx()._rec.clears;
  run(m, 120);                      // ~2 seconds at 60fps
  const painted = m.ctx()._rec.clears - start;
  assert.ok(painted < 60, `idle painted ${painted} of 120 frames — throttling regressed`);
  assert.ok(painted > 0, "idle must still breathe");
  m.core.destroy();
});

test("the VoiceOrb contract the rest of the app calls is intact", () => {
  // Every one of these has a live caller: main.js, cockpit.js, celebration.js
  // and dashboardV2.js all still talk to this object as `window.__orb`.
  const { core } = mount();
  for (const method of [
    "setStatus", "feed", "resize", "ignite", "moonInfoAt", "toolEvent",
    "_ensureAudio", "connectMic", "connectMediaElement", "stopAudio"
  ]) {
    assert.strictEqual(typeof core[method], "function", `missing ${method}() — a caller will break`);
  }
  assert.strictEqual(typeof core.status, "string");
  assert.strictEqual(typeof core.cur.amp, "number");
  assert.strictEqual(typeof core.reduced, "boolean");
});

test("connectMediaElement keeps the WebKit-safe synthetic envelope", () => {
  // Creating a real MediaElementSource here breaks TTS playback on WebKit/Orion.
  // The retired orb deliberately did not; neither may the Core.
  const { core } = mount();
  core.connectMediaElement({});
  assert.strictEqual(core._audioActive, false, "must not route the element through the analyser");
  assert.strictEqual(core._synthSpeak, true, "must fall back to the synthetic envelope");
});
