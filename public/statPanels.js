// The ops wall: a top row + corner stat panels in the InterLink/JARVIS
// language — big glowing numbers, mini charts, corner brackets — every value
// bound to something Artemis actually measures. No invented data: a source
// that can't be read renders "—" and says nothing.
//
// Layout is additive: panels are fixed-position slabs dropped into the free
// screen strips (top row under the status bar, gaps beside the dock), so the
// existing cockpit keeps working untouched.

const POLL_MS = 3000;
const HIST = 40; // samples kept per sparkline
const REDUCED_MOTION = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Seconds as the coarsest useful unit: "2H13M", "45M", "30S". */
function shortWait(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + "H" + String(Math.round((sec % 3600) / 60)).padStart(2, "0") + "M";
  if (sec >= 60) return Math.round(sec / 60) + "M";
  return Math.max(1, Math.round(sec)) + "S";
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function panel(id, label, spot) {
  const p = el("div", "ops-panel ops-" + spot);
  p.id = id;
  p.append(el("div", "ops-label", label));
  const num = el("div", "ops-num", "—");
  const sub = el("div", "ops-sub", "");
  const cv = document.createElement("canvas");
  cv.className = "ops-chart";
  cv.width = 220; cv.height = 64;
  p.append(num, sub, cv, el("div", "ops-scan"));
  document.body.appendChild(p);
  return { root: p, num, sub, cv: cv.getContext("2d"), cvEl: cv, hist: [] };
}

// count-up: numbers interpolate to new values. Numeric state lives on the
// panel object — parsing displayed text back out of the DOM while an earlier
// animation was mid-write is how SYSTEM LOAD once read "-755%".
function setNum(pn, text) {
  const target = parseFloat(text);
  if (!Number.isFinite(target)) { pn.num.textContent = text; pn._val = undefined; return; }
  const suffix = String(text).replace(/^-?[\d.]+/, "");
  const from = Number.isFinite(pn._val) ? pn._val : 0;
  if (REDUCED_MOTION) {
    if (pn._anim) cancelAnimationFrame(pn._anim);
    pn._anim = 0;
    pn._val = target;
    pn.num.textContent = Math.round(target) + suffix;
    return;
  }
  if (Math.abs(from - target) < 0.5 && pn._val !== undefined) {
    pn._val = target; pn.num.textContent = Math.round(target) + suffix; return;
  }
  if (pn._anim) cancelAnimationFrame(pn._anim);
  const t0 = performance.now(), DUR = 700;
  const lo = Math.min(from, target), hi = Math.max(from, target);
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / DUR);
    const v = Math.max(lo, Math.min(hi, from + (target - from) * (1 - Math.pow(1 - k, 3))));
    pn._val = v;
    pn.num.textContent = Math.round(v) + suffix;
    pn._anim = k < 1 ? requestAnimationFrame(tick) : 0;
  };
  pn._anim = requestAnimationFrame(tick);
}

function flatLine(g, cvEl, color) {
  const w = cvEl.width, h = cvEl.height;
  g.strokeStyle = color.replace("rgb", "rgba").replace(")", ",0.25)");
  g.setLineDash([3, 5]);
  g.beginPath(); g.moveTo(0, h - 8); g.lineTo(w, h - 8); g.stroke();
  g.setLineDash([]);
}

// gradient bars with glow (flat rectangles read as dead pixels)
function glowBars(g, cvEl, values, color) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  const n = values.length || 1;
  const bw = Math.max(3, w / n - 4);
  values.forEach((v, i) => {
    const x = (i / n) * w + 2;
    const bh = Math.max(2, v * (h - 8));
    const grad = g.createLinearGradient(0, h - bh, 0, h);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(30,64,175,0.85)");
    g.fillStyle = grad;
    g.shadowColor = color; g.shadowBlur = 7;
    g.fillRect(x, h - 4 - bh, bw, bh);
  });
  g.shadowBlur = 0;
}

// segmented strip: UPTIME's minutes-of-hour ticker
function segStrip(g, cvEl, filled, total, color) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  const sw = w / total;
  for (let i = 0; i < total; i++) {
    const on = i < filled;
    g.fillStyle = on ? color : "rgba(56,120,180,0.18)";
    g.shadowColor = color; g.shadowBlur = on ? 4 : 0;
    g.fillRect(i * sw + 1, h / 2 - 4, Math.max(1, sw - 2), 8);
  }
  g.shadowBlur = 0;
}

// horizontal usage bar: track + fill bound to pct (0..100)
function hbar(g, cvEl, pct, color, y = 4, hh = 10) {
  const w = cvEl.width;
  g.fillStyle = "rgba(56,120,180,0.18)";
  g.fillRect(0, y, w, hh);
  const fw = Math.max(2, (Math.max(0, Math.min(100, pct)) / 100) * w);
  const grad = g.createLinearGradient(0, y, fw, y);
  grad.addColorStop(0, "rgba(30,64,175,0.9)");
  grad.addColorStop(1, color);
  g.fillStyle = grad; g.shadowColor = color; g.shadowBlur = 6;
  g.fillRect(0, y, fw, hh);
  g.shadowBlur = 0;
}

// usage bar on top + history sparkline beneath — one panel, two truths
function barAndSpark(g, cvEl, pct, hist, color) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  hbar(g, cvEl, pct, color);
  const top = 20, hh = h - top - 2;
  if (hist.length < 2) {
    g.strokeStyle = color.replace("rgb", "rgba").replace(")", ",0.2)");
    g.setLineDash([3, 5]);
    g.beginPath(); g.moveTo(0, top + hh - 4); g.lineTo(w, top + hh - 4); g.stroke();
    g.setLineDash([]);
    return;
  }
  g.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (HIST - 1)) * w;
    const y = top + hh - 3 - (Math.max(0, Math.min(100, v)) / 100) * (hh - 6);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = color; g.lineWidth = 1.4;
  g.shadowColor = color; g.shadowBlur = 5;
  g.stroke(); g.shadowBlur = 0;
}

// skeleton: n stub+track rows at low opacity — "loading", never a void
function skeletonRows(g, cvEl, n) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  const rh = Math.min(12, (h - 8) / n - 4);
  for (let i = 0; i < n; i++) {
    const y = 4 + i * (rh + 6);
    g.fillStyle = "rgba(103,232,249,0.14)";
    g.fillRect(0, y, 34, rh);
    g.fillStyle = "rgba(56,120,180,0.12)";
    g.fillRect(42, y, w - 42, rh);
  }
}

// dimmed model slots — the chain's structure before the first live reading
function dimSlots(g, cvEl, n, primary) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  const bw = Math.max(4, w / n - 6);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w + 3;
    const bh = (i === primary ? 0.85 : 0.5) * (h - 10);
    g.fillStyle = i === primary ? "rgba(34,211,238,0.34)" : "rgba(34,211,238,0.18)";
    g.fillRect(x, h - 5 - bh, bw, bh);
  }
}

const CYAN = "rgb(34,211,238)";
const BLUE = "rgb(59,130,246)";
const VIOLET = "rgb(167,139,250)";

export function mountOpsWall() {
  if (!document.body.classList.contains("cockpit")) return;

  const uptime = panel("opsUp", "UPTIME", "b3");
  const skills = panel("opsSkills", "SUBSYSTEMS", "b4");
  const cpu = panel("opsCpu", "SYSTEM LOAD", "t1");
  const mem = panel("opsMem", "MEMORY", "t2");
  const ttfw = panel("opsTtfw", "RESPONSE MS", "t3");
  const brain = panel("opsBrain", "NEURAL CHAIN", "t4");
  const tokens = panel("opsTokens", "TOKEN BUDGETS", "b1");
  const counts = panel("opsCounts", "SIGNALS", "b2");

  async function poll(shared) {
    let t = shared || null;
    if (!t) {
      try {
        const r = await fetch("/api/telemetry", { cache: "no-store" });
        if (r.ok) t = await r.json();
      } catch (e) {}
    }
    if (!t) { [cpu, mem, ttfw, brain, tokens, counts].forEach((p) => p.root.dataset.dim = "1"); return; }
    [cpu, mem, ttfw, brain, tokens, counts].forEach((p) => delete p.root.dataset.dim);

    if (t.cpu) {
      const pct = Math.min(100, Math.round((t.cpu.load1 / (t.cpu.cores || 1)) * 100));
      setNum(cpu, pct + "%"); delete cpu.num.dataset.dim;
      cpu.sub.textContent = t.cpu.cores + " CORES · LOAD " + t.cpu.load1.toFixed(2);
      cpu.hist.push(pct); if (cpu.hist.length > HIST) cpu.hist.shift();
      barAndSpark(cpu.cv, cpu.cvEl, pct, cpu.hist, CYAN);
    }
    if (t.memory && t.memory.totalBytes) {
      const pct = Math.max(0, Math.min(100, Math.round((t.memory.usedBytes / t.memory.totalBytes) * 100)));
      setNum(mem, pct + "%"); delete mem.num.dataset.dim;
      mem.sub.textContent = (t.memory.usedBytes / 1e9).toFixed(1) + " / " + (t.memory.totalBytes / 1e9).toFixed(0) + " GB";
      mem.hist.push(pct); if (mem.hist.length > HIST) mem.hist.shift();
      barAndSpark(mem.cv, mem.cvEl, pct, mem.hist, BLUE);
    }
    if (t.latency && t.latency.lastFirstWordMs != null) {
      setNum(ttfw, String(Math.round(t.latency.lastFirstWordMs))); delete ttfw.num.dataset.dim;
      ttfw.sub.textContent = "TIME TO FIRST WORD";
      ttfw.hist.push(t.latency.lastFirstWordMs); if (ttfw.hist.length > HIST) ttfw.hist.shift();
      spark(ttfw.cv, ttfw.cvEl, ttfw.hist, VIOLET);
    } else { ttfw.sub.textContent = "AWAITING FIRST TURN"; }
    if (t.brain) {
      const chain = t.brain.chain || [];
      if (chain.length) { brain.num.textContent = chain.length; delete brain.num.dataset.dim; }
      // Which brain is answering, and — when it is not her first choice — when
      // the good one comes back. Being served by a fallback is something you
      // should read here, not infer from her getting worse at things.
      const active = (t.brain.current || t.brain.name || "").replace("groq:", "").replace("ollama:", "LOCAL ");
      const head = chain[0];
      const onFallback = chain.length > 0 && !chain[0].current;
      const wait = onFallback && head && head.availableInSec ? " · BEST BACK IN " + shortWait(head.availableInSec) : "";
      brain.sub.textContent = (onFallback ? "FALLBACK · " : "PRIMARY · ") + active.slice(0, 24).toUpperCase() + wait;
      glowBars(brain.cv, brain.cvEl, chain.map((c, i) => (c.current ? 1 : 0.45 - i * 0.05)), onFallback ? VIOLET : CYAN);
      // The BRAIN card renders this same real chain as discrete nodes — one
      // poll, one source of truth, no second fetch loop.
      window.dispatchEvent(new CustomEvent("artemis-brain-chain", {
        detail: { chain, onFallback }
      }));
    }
    if (t.budget && t.budget.limitTokens) {
      const left = Math.round((t.budget.remainingTokens / t.budget.limitTokens) * 100);
      setNum(tokens, left + "%"); delete tokens.num.dataset.dim;
      tokens.sub.textContent = "OF FREE DAILY POOL REMAINING";
      glowBars(tokens.cv, tokens.cvEl, [left / 100], VIOLET);
    } else {
      tokens.sub.textContent = "NO BUDGET HEADERS YET";
      skeletonRows(tokens.cv, tokens.cvEl, 3);
    }
    const c = t.counts || {};
    const parts = [];
    if (c.unreadMail != null) parts.push(c.unreadMail + " MAIL");
    if (c.reminders != null) parts.push(c.reminders + " DUE");
    const total = (c.unreadMail || 0) + (c.reminders || 0);
    counts.num.textContent = String(total);
    if (total) delete counts.num.dataset.dim; else counts.num.dataset.dim = "1";
    counts.sub.textContent = parts.join(" · ") || "QUIET · NOTHING WAITING";
    if (total) glowBars(counts.cv, counts.cvEl, [(c.unreadMail || 0) / 10, (c.reminders || 0) / 10].map((v) => Math.min(1, v + 0.06)), BLUE);
    else { counts.cv.clearRect(0, 0, counts.cvEl.width, counts.cvEl.height); hbar(counts.cv, counts.cvEl, 0, BLUE, counts.cvEl.height / 2 - 5); }
  }

  // static-ish panels
  let upSec = 0;
  setInterval(() => {
    upSec += 1;
    const h = Math.floor(upSec / 3600), m = Math.floor((upSec % 3600) / 60);
    uptime.num.textContent = (h ? h + "h " : "") + m + "m";
    uptime.sub.textContent = "SESSION ONLINE";
    segStrip(uptime.cv, uptime.cvEl, m, 60, CYAN);
  }, 1000);
  skills.num.textContent = "19";
  skills.sub.textContent = "SKILLS ONLINE · 18 SPECIALISTS";
  glowBars(skills.cv, skills.cvEl, Array.from({ length: 9 }, (_, i) => 0.4 + (i % 3) * 0.22), CYAN);

  // placeholder states, drawn immediately — before any data exists
  setNum(cpu, "0%"); cpu.num.dataset.dim = "1"; barAndSpark(cpu.cv, cpu.cvEl, 0, [], CYAN);
  setNum(mem, "0%"); mem.num.dataset.dim = "1"; barAndSpark(mem.cv, mem.cvEl, 0, [], BLUE);
  ttfw.num.textContent = "···"; ttfw.num.dataset.dim = "1"; flatLine(ttfw.cv, ttfw.cvEl, VIOLET);
  ttfw.sub.textContent = "AWAITING FIRST TURN";
  brain.num.textContent = "5"; brain.num.dataset.dim = "1";
  brain.sub.textContent = "PRIMARY · LLAMA-3.3-70B-VERSATILE";
  dimSlots(brain.cv, brain.cvEl, 5, 0);
  tokens.num.textContent = "···"; tokens.num.dataset.dim = "1";
  tokens.sub.textContent = "NO BUDGET HEADERS YET";
  skeletonRows(tokens.cv, tokens.cvEl, 3);
  counts.num.textContent = "0"; counts.num.dataset.dim = "1";
  counts.sub.textContent = "QUIET · NOTHING WAITING";
  hbar(counts.cv, counts.cvEl, 0, BLUE, counts.cvEl.height / 2 - 5);
  segStrip(uptime.cv, uptime.cvEl, 0, 60, CYAN);
  uptime.num.textContent = "0m"; uptime.sub.textContent = "SESSION ONLINE";

  window.addEventListener("artemis-telemetry", (e) => { if (e.detail) poll(e.detail); });
  poll();
  setInterval(() => { if (!document.hidden && !window.__telemetryShared) poll(); }, POLL_MS);
}
