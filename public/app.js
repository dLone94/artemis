// Artemis frontend — payment poller, per-client dedup, burst cap, controls, feed.
// celebration.js is loaded first and exposes window.celebratePayment / fireTestCelebration.

const POLL_INTERVAL_MS = 5000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // catch-up window on (re)connect
const MAX_REPLAY = 6; // cap a missed-burst replay; the rest stay in history only
const CELEBRATED_KEY = "artemisCelebratedPayments";

// ---- durable per-client celebrated record -------------------------------
// Backs BOTH live and catch-up paths so neither double-fires nor misses.
function loadCelebrated() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CELEBRATED_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveCelebrated(record) {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // trim past 48h
  const trimmed = {};
  Object.keys(record).forEach((id) => {
    if ((record[id] || 0) >= cutoff) trimmed[id] = record[id];
  });
  try {
    localStorage.setItem(CELEBRATED_KEY, JSON.stringify(trimmed));
  } catch (e) {}
  return trimmed;
}

// ---- recent-payments feed -----------------------------------------------
function fmtMoney(amountMinor, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2
    }).format((amountMinor || 0) / 100);
  } catch (e) {
    return "$" + ((amountMinor || 0) / 100).toLocaleString();
  }
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (e) {
    return "";
  }
}

function renderFeed(payments) {
  const list = document.getElementById("paymentFeed");
  const empty = document.getElementById("feedEmpty");
  if (!list) return;
  list.innerHTML = "";
  const sorted = payments.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
  if (empty) empty.style.display = sorted.length ? "none" : "block";
  for (const p of sorted) {
    const li = document.createElement("li");
    li.className = "feed-item";
    const amt = document.createElement("span");
    amt.className = "feed-amount";
    amt.textContent = fmtMoney(p.amount, p.currency);
    const who = document.createElement("span");
    who.className = "feed-who";
    who.textContent = p.customerLabel || "Customer";
    const when = document.createElement("span");
    when.className = "feed-when";
    when.textContent = fmtTime(p.created);
    li.appendChild(amt);
    li.appendChild(who);
    li.appendChild(when);
    list.appendChild(li);
  }
}

// ---- poller: unified live + catch-up ------------------------------------
async function pollOnce() {
  let payments = [];
  try {
    const res = await fetch(`/api/payments/recent?lookbackMs=${LOOKBACK_MS}`);
    if (!res.ok) return;
    const data = await res.json();
    payments = Array.isArray(data.payments) ? data.payments : [];
  } catch (e) {
    return; // offline / server down — retry next tick
  }

  renderFeed(payments);

  const celebrated = loadCelebrated();
  const fresh = payments
    .filter((p) => p && p.id && !celebrated[p.id])
    .sort((a, b) => (b.created || 0) - (a.created || 0)); // newest first

  if (fresh.length === 0) return;

  // Record ALL fresh (even capped) so they never re-fire later.
  fresh.forEach((p) => {
    celebrated[p.id] = Date.now();
  });
  saveCelebrated(celebrated);

  const toReplay = fresh.slice(0, MAX_REPLAY);
  if (fresh.length > MAX_REPLAY) {
    console.info(
      `Artemis celebration: replaying the ${MAX_REPLAY} most recent of ${fresh.length} ` +
        `new payment(s); the rest are in history only (not silently dropped).`
    );
  }

  // oldest -> newest so the most recent lands last
  toReplay
    .slice()
    .reverse()
    .forEach((p) => {
      if (typeof window.celebratePayment === "function") window.celebratePayment(p);
    });
}

// ---- controls ------------------------------------------------------------
function wireControls() {
  const settings = window.getCelebrationSettings();

  const enabledBox = document.getElementById("toggleEnabled");
  if (enabledBox) {
    enabledBox.checked = settings.enabled;
    enabledBox.addEventListener("change", () =>
      window.setCelebrationSettings({ enabled: enabledBox.checked })
    );
  }

  const muteBox = document.getElementById("toggleMute");
  if (muteBox) {
    muteBox.checked = settings.muted;
    muteBox.addEventListener("change", () =>
      window.setCelebrationSettings({ muted: muteBox.checked })
    );
  }

  const testBtn = document.getElementById("testButton");
  if (testBtn) {
    const amounts = [25, 150, 1300]; // small / medium / large
    let i = 0;
    testBtn.addEventListener("click", () => {
      window.fireTestCelebration(amounts[i % amounts.length]);
      i += 1;
    });
  }
}

async function showStripeStatus() {
  const el = document.getElementById("stripeStatus");
  if (!el) return;
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    el.textContent = data.stripeEnabled
      ? "Stripe polling: ON (watching for live payments)"
      : "Stripe polling: OFF — set STRIPE_SECRET_KEY in .env. Test button still works.";
    el.classList.toggle("status-on", !!data.stripeEnabled);
  } catch (e) {
    el.textContent = "Server status unavailable.";
  }
}

// ---- init ----------------------------------------------------------------
wireControls();
showStripeStatus();
pollOnce(); // immediate catch-up on connect
setInterval(pollOnce, POLL_INTERVAL_MS);
