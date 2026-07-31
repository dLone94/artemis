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
  cv.width = 220; cv.height = 44;
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
      setNum(cpu, pct + "%");
      cpu.sub.textContent = t.cpu.cores + " CORES · LOAD " + t.cpu.load1.toFixed(2);
      cpu.hist.push(pct); if (cpu.hist.length > HIST) cpu.hist.shift();
      glowBars(cpu.cv, cpu.cvEl, cpu.hist.slice(-15).map((v) => v / 100), CYAN);
    }
    if (t.memory && t.memory.totalBytes) {
      const pct = Math.max(0, Math.min(100, Math.round((t.memory.usedBytes / t.memory.totalBytes) * 100)));
      setNum(mem, pct + "%");
      mem.sub.textContent = (t.memory.usedBytes / 1e9).toFixed(1) + " / " + (t.memory.totalBytes / 1e9).toFixed(0) + " GB";
      mem.hist.push(pct); if (mem.hist.length > HIST) mem.hist.shift();
      spark(mem.cv, mem.cvEl, mem.hist, BLUE, [0, 100]);
    }
    if (t.latency && t.latency.lastFirstWordMs != null) {
      setNum(ttfw, String(Math.round(t.latency.lastFirstWordMs)));
      ttfw.sub.textContent = "TIME TO FIRST WORD";
      ttfw.hist.push(t.latency.lastFirstWordMs); if (ttfw.hist.length > HIST) ttfw.hist.shift();
      spark(ttfw.cv, ttfw.cvEl, ttfw.hist, VIOLET);
    } else { ttfw.sub.textContent = "AWAITING FIRST TURN"; }
    if (t.brain) {
      const chain = t.brain.chain || [];
      brain.num.textContent = chain.length || "—";
      brain.sub.textContent = (t.brain.benched ? "FALLBACK · " : "PRIMARY · ") + (t.brain.name || "").replace("groq:", "").slice(0, 24).toUpperCase();
      glowBars(brain.cv, brain.cvEl, chain.map((c, i) => (t.brain.name === c ? 1 : 0.45 - i * 0.05)), t.brain.benched ? VIOLET : CYAN);
    }
    if (t.budget && t.budget.limitTokens) {
      const left = Math.round((t.budget.remainingTokens / t.budget.limitTokens) * 100);
      setNum(tokens, left + "%");
      tokens.sub.textContent = "OF FREE DAILY POOL REMAINING";
      glowBars(tokens.cv, tokens.cvEl, [left / 100], VIOLET);
    } else {
      tokens.sub.textContent = "NO BUDGET HEADERS YET";
      glowBars(tokens.cv, tokens.cvEl, [0.06, 0.06, 0.06, 0.06], "rgb(70,110,170)");
    }
    const c = t.counts || {};
    const parts = [];
    if (c.unreadMail != null) parts.push(c.unreadMail + " MAIL");
    if (c.reminders != null) parts.push(c.reminders + " DUE");
    counts.num.textContent = parts.length ? (c.unreadMail ?? 0) + (c.reminders ?? 0) : "—";
    counts.sub.textContent = parts.join(" · ") || "NO SIGNALS READABLE";
    glowBars(counts.cv, counts.cvEl, [(c.unreadMail || 0) / 10, (c.reminders || 0) / 10].map((v) => Math.min(1, v + 0.06)), BLUE);
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

  window.addEventListener("artemis-telemetry", (e) => { if (e.detail) poll(e.detail); });
  poll();
  setInterval(() => { if (!document.hidden && !window.__telemetryShared) poll(); }, POLL_MS);
}
