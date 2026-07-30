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
  p.append(num, sub, cv);
  document.body.appendChild(p);
  return { root: p, num, sub, cv: cv.getContext("2d"), cvEl: cv, hist: [] };
}

function spark(g, cvEl, hist, color) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  if (hist.length < 2) return;
  const max = Math.max(...hist, 1e-9), min = Math.min(...hist, 0);
  const span = max - min || 1;
  g.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (HIST - 1)) * w;
    const y = h - 4 - ((v - min) / span) * (h - 10);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = color; g.lineWidth = 1.6;
  g.shadowColor = color; g.shadowBlur = 6;
  g.stroke(); g.shadowBlur = 0;
  // area fill
  g.lineTo((hist.length - 1) / (HIST - 1) * w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color.replace(")", ",0.25)").replace("rgb", "rgba"));
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fill();
}

function bars(g, cvEl, values, color) {
  const w = cvEl.width, h = cvEl.height;
  g.clearRect(0, 0, w, h);
  const n = values.length || 1;
  const bw = Math.max(4, w / n - 6);
  values.forEach((v, i) => {
    const x = (i / n) * w + 3;
    const bh = Math.max(2, v * (h - 8));
    g.fillStyle = color;
    g.shadowColor = color; g.shadowBlur = 5;
    g.fillRect(x, h - 4 - bh, bw, bh);
  });
  g.shadowBlur = 0;
}

const CYAN = "rgb(34,211,238)";
const BLUE = "rgb(59,130,246)";
const VIOLET = "rgb(167,139,250)";

export function mountOpsWall() {
  if (!document.body.classList.contains("cockpit")) return;

  const cpu = panel("opsCpu", "SYSTEM LOAD", "t1");
  const mem = panel("opsMem", "MEMORY", "t2");
  const ttfw = panel("opsTtfw", "RESPONSE MS", "t3");
  const brain = panel("opsBrain", "NEURAL CHAIN", "t4");
  const tokens = panel("opsTokens", "TOKEN BUDGETS", "b1");
  const counts = panel("opsCounts", "SIGNALS", "b2");

  async function poll() {
    let t = null;
    try {
      const r = await fetch("/api/telemetry", { cache: "no-store" });
      if (r.ok) t = await r.json();
    } catch (e) {}
    if (!t) { [cpu, mem, ttfw, brain, tokens, counts].forEach((p) => p.root.dataset.dim = "1"); return; }
    [cpu, mem, ttfw, brain, tokens, counts].forEach((p) => delete p.root.dataset.dim);

    if (t.cpu) {
      const pct = Math.min(100, Math.round((t.cpu.load1 / (t.cpu.cores || 1)) * 100));
      cpu.num.textContent = pct + "%";
      cpu.sub.textContent = t.cpu.cores + " CORES · LOAD " + t.cpu.load1.toFixed(2);
      cpu.hist.push(pct); if (cpu.hist.length > HIST) cpu.hist.shift();
      spark(cpu.cv, cpu.cvEl, cpu.hist, CYAN);
    }
    if (t.memory && t.memory.totalBytes) {
      const pct = Math.round((t.memory.usedBytes / t.memory.totalBytes) * 100);
      mem.num.textContent = pct + "%";
      mem.sub.textContent = (t.memory.usedBytes / 1e9).toFixed(1) + " / " + (t.memory.totalBytes / 1e9).toFixed(0) + " GB";
      mem.hist.push(pct); if (mem.hist.length > HIST) mem.hist.shift();
      spark(mem.cv, mem.cvEl, mem.hist, BLUE);
    }
    if (t.latency && t.latency.lastFirstWordMs != null) {
      ttfw.num.textContent = Math.round(t.latency.lastFirstWordMs);
      ttfw.sub.textContent = "TIME TO FIRST WORD";
      ttfw.hist.push(t.latency.lastFirstWordMs); if (ttfw.hist.length > HIST) ttfw.hist.shift();
      spark(ttfw.cv, ttfw.cvEl, ttfw.hist, VIOLET);
    } else { ttfw.sub.textContent = "AWAITING FIRST TURN"; }
    if (t.brain) {
      const chain = t.brain.chain || [];
      brain.num.textContent = chain.length || "—";
      brain.sub.textContent = (t.brain.benched ? "FALLBACK · " : "PRIMARY · ") + (t.brain.name || "").replace("groq:", "").slice(0, 24).toUpperCase();
      bars(brain.cv, brain.cvEl, chain.map((c, i) => (t.brain.name === c ? 1 : 0.45 - i * 0.05)), t.brain.benched ? VIOLET : CYAN);
    }
    if (t.budget && t.budget.limitTokens) {
      const left = Math.round((t.budget.remainingTokens / t.budget.limitTokens) * 100);
      tokens.num.textContent = left + "%";
      tokens.sub.textContent = "OF FREE DAILY POOL REMAINING";
      bars(tokens.cv, tokens.cvEl, [left / 100, 1 - left / 100], left < 25 ? VIOLET : CYAN);
    } else { tokens.sub.textContent = "NO BUDGET HEADERS YET"; }
    const c = t.counts || {};
    const parts = [];
    if (c.unreadMail != null) parts.push(c.unreadMail + " MAIL");
    if (c.reminders != null) parts.push(c.reminders + " DUE");
    counts.num.textContent = parts.length ? (c.unreadMail ?? 0) + (c.reminders ?? 0) : "—";
    counts.sub.textContent = parts.join(" · ") || "NO SIGNALS READABLE";
    bars(counts.cv, counts.cvEl, [(c.unreadMail || 0) / 10, (c.reminders || 0) / 10].map((v) => Math.min(1, v + 0.06)), BLUE);
  }

  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
}
