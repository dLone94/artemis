import { MOON_INFO } from "./voiceOrb.js";

const body = document.body;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

window.ArtemisDashboard = Object.freeze({
  version: body.classList.contains("dashboard-v2") ? "v2" : "v1",
  setLayout(version) {
    try {
      if (version === "v1") window.localStorage.setItem("artemisDashboardLayout", "v1");
      else window.localStorage.removeItem("artemisDashboardLayout");
    } catch (e) {}
    window.location.reload();
  }
});

if (body.classList.contains("dashboard-v2")) initializeDashboardV2();

function initializeDashboardV2() {
  const required = {
    header: document.querySelector(".hud-top"),
    stage: document.getElementById("sceneStage"),
    state: document.getElementById("hudState"),
    tool: document.getElementById("hudToolOrb"),
    comms: document.querySelector(".hud-left"),
    context: document.querySelector(".hud-right"),
    dock: document.getElementById("dock")
  };
  if (Object.values(required).some((node) => !node)) {
    body.classList.remove("dashboard-v2");
    document.documentElement.dataset.dashboardLayout = "v1";
    return;
  }

  const shell = document.createElement("main");
  shell.className = "v2-shell";
  shell.setAttribute("aria-label", "Artemis command center");
  shell.innerHTML = shellMarkup();
  body.appendChild(shell);

  const slot = (name) => shell.querySelector(`[data-v2-slot="${name}"]`);
  slot("header").appendChild(required.header);
  slot("stage").appendChild(required.stage);
  slot("hub-readouts").append(required.state, required.tool);
  slot("comms").appendChild(required.comms);
  slot("context").appendChild(required.context);
  slot("dock").appendChild(required.dock);

  const brand = required.header.querySelector(".hud-brand");
  if (brand) {
    const lockup = document.createElement("div");
    lockup.className = "v2-lockup";
    const subtitle = document.createElement("div");
    subtitle.className = "v2-subtitle";
    subtitle.textContent = "PERSONAL VOICE AGENT";
    brand.replaceWith(lockup);
    lockup.append(brand, subtitle);
  }

  const skillNodes = buildSkillBand(shell);
  const panels = new Map(
    Array.from(shell.querySelectorAll("[data-v2-panel]")).map((node) => [node.dataset.v2Panel, node])
  );
  const pulseTimers = new Map();
  let specialistCount = null;
  let specialistState = "connecting";

  function updateCounts() {
    const summary = shell.querySelector("[data-v2-skill-summary]");
    const specialistText = specialistState === "connecting"
      ? "CONNECTING"
      : specialistState === "ok" ? String(specialistCount) : "—";
    if (summary) {
      summary.textContent = `${MOON_INFO.length} SKILLS ONLINE · ${specialistText} SPECIALISTS`;
      summary.dataset.state = specialistState;
    }

    const opsSkills = document.getElementById("opsSkills");
    if (!opsSkills) return;
    const num = opsSkills.querySelector(".ops-num");
    const sub = opsSkills.querySelector(".ops-sub");
    if (num) {
      num.textContent = String(MOON_INFO.length);
      delete num.dataset.dim;
    }
    if (sub) {
      sub.textContent = specialistState === "connecting"
        ? "SKILLS ONLINE · CONNECTING SPECIALISTS"
        : specialistState === "ok"
          ? `SKILLS ONLINE · ${specialistCount} SPECIALISTS`
          : "SKILLS ONLINE · SPECIALISTS UNAVAILABLE";
    }
  }

  updateCounts();
  fetch("/api/agents", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("agents unavailable");
      return response.json();
    })
    .then((data) => {
      if (!Array.isArray(data?.agents)) throw new Error("invalid agents response");
      specialistCount = data.agents.length;
      specialistState = "ok";
      updateCounts();
    })
    .catch(() => {
      specialistState = "error";
      updateCounts();
    });

  let opsMounted = false;
  function mountOpsPanels() {
    if (opsMounted) return true;
    const ids = ["opsCpu", "opsMem", "opsBrain", "opsTtfw", "opsTokens", "opsCounts", "opsUp", "opsSkills"];
    const roots = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    if (ids.some((id) => !roots[id])) return false;

    slot("system").append(roots.opsCpu, roots.opsMem);
    slot("neural").append(roots.opsBrain, roots.opsTtfw);
    slot("context-stats").append(roots.opsTokens, roots.opsCounts, roots.opsUp, roots.opsSkills);
    opsMounted = true;
    body.classList.add("v2-ops-mounted");
    updateCounts();
    requestAnimationFrame(() => {
      scheduleGeometry();
      window.dispatchEvent(new Event("resize"));
    });
    return true;
  }

  function waitForOpsPanels() {
    if (mountOpsPanels()) return;
    const observer = new MutationObserver(() => {
      if (!mountOpsPanels()) return;
      observer.disconnect();
    });
    observer.observe(body, { childList: true });
    window.setTimeout(() => observer.disconnect(), 3000);
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", waitForOpsPanels, { once: true });
  } else {
    waitForOpsPanels();
  }

  const map = shell.querySelector(".v2-map");
  const hub = shell.querySelector("[data-v2-hub]");
  const spokes = shell.querySelector(".v2-spokes");
  let geometryFrame = 0;
  let lastStageSize = "";

  function scheduleGeometry() {
    if (geometryFrame) return;
    geometryFrame = requestAnimationFrame(updateGeometry);
  }

  function updateGeometry() {
    geometryFrame = 0;
    const mapRect = map.getBoundingClientRect();
    const hubRect = hub.getBoundingClientRect();
    if (mapRect.width < 1 || mapRect.height < 1 || hubRect.width < 1) return;

    const rects = Object.fromEntries(
      Array.from(panels, ([name, panel]) => [name, panel.getBoundingClientRect()])
    );
    spokes.setAttribute("viewBox", `0 0 ${Math.round(mapRect.width)} ${Math.round(mapRect.height)}`);

    const rel = (x, y) => [x - mapRect.left, y - mapRect.top];
    const hubPoints = {
      west: rel(hubRect.left, hubRect.top + hubRect.height / 2),
      north: rel(hubRect.left + hubRect.width / 2, hubRect.top),
      south: rel(hubRect.left + hubRect.width / 2, hubRect.bottom),
      east: rel(hubRect.right, hubRect.top + hubRect.height / 2)
    };
    const panelPoint = (rect, edge, ratio) => {
      if (edge === "left") return rel(rect.left, rect.top + rect.height * ratio);
      if (edge === "right") return rel(rect.right, rect.top + rect.height * ratio);
      if (edge === "top") return rel(rect.left + rect.width * ratio, rect.top);
      return rel(rect.left + rect.width * ratio, rect.bottom);
    };
    const mid = (a, b, amount = 0.5) => a + (b - a) * amount;
    const routes = {};

    {
      const [sx, sy] = hubPoints.west;
      const [ex, ey] = panelPoint(rects.system, "right", 0.68);
      const mx = mid(sx, ex, 0.52);
      routes.system = compactSpokePoints([[sx, sy], [mx, sy], [mx, ey], [ex, ey]]);
    }
    {
      const [sx, sy] = hubPoints.north;
      const [ex, ey] = panelPoint(rects.neural, "bottom", 0.34);
      const ry = Math.max(8, sy - Math.max(18, mapRect.height * 0.025));
      routes.neural = compactSpokePoints([[sx, sy], [sx, ry], [ex, ry], [ex, ey]]);
    }
    {
      const [sx, sy] = hubPoints.south;
      const [ex, ey] = panelPoint(rects.comms, "right", 0.34);
      const ry = Math.min(mapRect.height - 8, sy + Math.max(18, mapRect.height * 0.025));
      const mx = mid(sx, ex, 0.48);
      routes.comms = compactSpokePoints([[sx, sy], [sx, ry], [mx, ry], [mx, ey], [ex, ey]]);
    }
    {
      const [sx, sy] = hubPoints.east;
      const [ex, ey] = panelPoint(rects.context, "left", 0.34);
      const mx = mid(sx, ex, 0.52);
      routes.context = compactSpokePoints([[sx, sy], [mx, sy], [mx, ey], [ex, ey]]);
    }

    for (const [name, points] of Object.entries(routes)) {
      const group = spokes.querySelector(`[data-v2-spoke="${name}"]`);
      if (!group) continue;
      const centerPath = spokePath(points);
      group.querySelectorAll(".v2-spoke-idle, .v2-spoke-activity")
        .forEach((path) => path.setAttribute("d", centerPath));
      group.querySelector(".v2-spoke-rail--bright").setAttribute("d", offsetSpokePath(points, -1.5));
      group.querySelector(".v2-spoke-rail--dim").setAttribute("d", offsetSpokePath(points, 1.5));
      group.querySelector(".v2-spoke-ticks").setAttribute("d", spokeTicksPath(points));
      group.querySelector(".v2-spoke-junction").setAttribute("d", spokeJunctionPath(points));
      group.querySelector(".v2-spoke-chevrons").setAttribute("d", spokeChevronsPath(points));
      group.querySelector(".v2-spoke-nodes").innerHTML = spokeBends(points)
        .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="3.5"></circle>`)
        .join("");

      const gradient = spokes.querySelector(`#v2SpokeGradient-${name}`);
      const [startX, startY] = points[0];
      const [endX, endY] = points[points.length - 1];
      gradient.setAttribute("x1", startX);
      gradient.setAttribute("y1", startY);
      gradient.setAttribute("x2", endX);
      gradient.setAttribute("y2", endY);
    }

    const stageRect = required.stage.getBoundingClientRect();
    const stageSize = `${Math.round(stageRect.width)}x${Math.round(stageRect.height)}`;
    if (stageSize !== lastStageSize) {
      lastStageSize = stageSize;
      window.__orb?.resize?.();
    }
  }

  function pulseSpoke(name) {
    const group = spokes.querySelector(`[data-v2-spoke="${name}"]`);
    if (!group) return;
    group.classList.remove("is-pulsing");
    void group.getBoundingClientRect();
    group.classList.add("is-pulsing");
    window.clearTimeout(pulseTimers.get(name));
    pulseTimers.set(name, window.setTimeout(() => group.classList.remove("is-pulsing"), 1200));
  }

  window.addEventListener("resize", scheduleGeometry, { passive: true });
  const resizeObserver = new ResizeObserver(scheduleGeometry);
  resizeObserver.observe(map);
  resizeObserver.observe(hub);
  panels.forEach((panel) => resizeObserver.observe(panel));
  document.fonts?.ready?.then(scheduleGeometry);
  const syncAfterEntry = () => {
    scheduleGeometry();
    window.setTimeout(scheduleGeometry, reducedMotion ? 0 : 1250);
  };
  if (body.classList.contains("hud-in")) {
    syncAfterEntry();
  } else {
    const entryObserver = new MutationObserver(() => {
      if (!body.classList.contains("hud-in")) return;
      entryObserver.disconnect();
      syncAfterEntry();
    });
    entryObserver.observe(body, { attributes: true, attributeFilter: ["class"] });
  }
  scheduleGeometry();

  const log = document.getElementById("cmdLog");
  const logObserver = new MutationObserver((records) => {
    const lines = [];
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches(".hud-line")) lines.push(added);
        lines.push(...added.querySelectorAll(".hud-line"));
      }
    }
    if (!lines.length) return;
    pulseSpoke("comms");
    if (lines.some((line) => line.dataset.kind === "artemis")) pulseSpoke("neural");
  });
  logObserver.observe(log, { childList: true });

  let lastTelemetryPulse = 0;
  let telemetrySide = false;
  window.addEventListener("artemis-telemetry", (event) => {
    if (!event.detail) return;
    const now = performance.now();
    if (now - lastTelemetryPulse < 1800) return;
    lastTelemetryPulse = now;
    pulseSpoke(telemetrySide ? "context" : "system");
    telemetrySide = !telemetrySide;
  });

  const familyRoute = Object.freeze({
    research: { skill: "RESEARCH", spoke: "context" }, web: { skill: "RESEARCH", spoke: "context" },
    email: { skill: "MAIL", spoke: "comms" }, email_delete: { skill: "MAIL", spoke: "comms" },
    messages: { skill: "MESSAGES", spoke: "comms" }, message: { skill: "MESSAGES", spoke: "comms" }, contacts: { skill: "MESSAGES", spoke: "comms" },
    media: { skill: "MEDIA", spoke: "comms" }, navigate: { skill: "MEDIA", spoke: "comms" },
    memory: { skill: "MEMORY", spoke: "context" }, notes: { skill: "MEMORY", spoke: "context" }, reminder: { skill: "MEMORY", spoke: "context" }, meeting: { skill: "MEMORY", spoke: "context" },
    finance: { skill: "FINANCE", spoke: "context" }, briefing: { skill: "BRIEF", spoke: "context" },
    followups: { skill: "FOLLOW-UPS", spoke: "context" }, followups_nudge: { skill: "FOLLOW-UPS", spoke: "context" },
    school: { skill: "SCHOOL", spoke: "context" }, map: { skill: "PLAN", spoke: "context" }, map_update: { skill: "PLAN", spoke: "context" },
    radar: { skill: "RADAR", spoke: "context" }, radar_update: { skill: "RADAR", spoke: "context" }
  });
  const activeSkillRuns = new Map();
  const settleTimers = new Map();

  window.addEventListener("artemis-tool", (event) => {
    const data = event.detail || {};
    const phase = data.phase === "start" || data.phase === "end" ? data.phase : "";
    const family = String(data.family || "").trim().toLowerCase();
    if (!phase || !family) return;

    const route = familyRoute[family];
    const title = route?.skill;
    const skill = title ? skillNodes.get(title) : null;
    if (phase === "start") {
      pulseSpoke("neural");
      pulseSpoke(route?.spoke || "context");
      if (!skill) return;
      window.clearTimeout(settleTimers.get(title));
      skill.classList.remove("is-success", "is-failure");
      activeSkillRuns.set(title, (activeSkillRuns.get(title) || 0) + 1);
      skill.classList.add("is-executing");
      skill.setAttribute("aria-label", `${title}: ${String(data.name || "tool").replace(/_/g, " ")} running`);
      return;
    }

    pulseSpoke("context");
    if (!skill) return;
    const remaining = Math.max(0, (activeSkillRuns.get(title) || 1) - 1);
    activeSkillRuns.set(title, remaining);
    if (remaining) return;
    skill.classList.remove("is-executing");
    skill.classList.add(data.ok === true ? "is-success" : "is-failure");
    skill.setAttribute("aria-label", `${title}: ${data.ok === true ? "complete" : "failed"}`);
    settleTimers.set(title, window.setTimeout(() => {
      skill.classList.remove("is-success", "is-failure");
      skill.removeAttribute("aria-label");
    }, 1800));
  });

  installPerformanceGuard(shell, panels);
}

function shellMarkup() {
  return `
    <div class="v2-header-slot" data-v2-slot="header"></div>
    <section class="v2-map" aria-label="Artemis subsystem architecture">
      <svg class="v2-spokes" aria-hidden="true" preserveAspectRatio="none">
        <defs>
          ${["system", "neural", "comms", "context"].map(spokeGradientMarkup).join("")}
        </defs>
        ${spokeMarkup("system", "0s")}
        ${spokeMarkup("neural", "-2s")}
        ${spokeMarkup("comms", "-4s")}
        ${spokeMarkup("context", "-6s")}
      </svg>

      <section class="v2-panel v2-panel--system" data-v2-panel="system" aria-labelledby="v2SystemTitle">
        <header class="v2-panel-heading"><h2 id="v2SystemTitle">SYSTEM</h2><i aria-hidden="true"></i></header>
        <div class="v2-panel-content v2-system-content">
          <div class="v2-system-motif" aria-hidden="true">${wireSphereMarkup()}</div>
          <div class="v2-system-stats" data-v2-slot="system"></div>
        </div>
      </section>

      <section class="v2-panel v2-panel--neural" data-v2-panel="neural" aria-labelledby="v2NeuralTitle">
        <header class="v2-panel-heading"><h2 id="v2NeuralTitle">NEURAL CHAIN</h2><i aria-hidden="true"></i></header>
        <div class="v2-panel-content v2-neural-stats" data-v2-slot="neural"></div>
      </section>

      <section class="v2-panel v2-panel--comms" data-v2-panel="comms" aria-labelledby="v2CommsTitle">
        <header class="v2-panel-heading"><h2 id="v2CommsTitle">COMMS</h2><i aria-hidden="true"></i></header>
        <div class="v2-panel-content v2-comms-content" data-v2-slot="comms"></div>
      </section>

      <section class="v2-panel v2-panel--context" data-v2-panel="context" aria-labelledby="v2ContextTitle">
        <header class="v2-panel-heading"><h2 id="v2ContextTitle">CONTEXT &amp; MEMORY</h2><i aria-hidden="true"></i></header>
        <div class="v2-panel-content v2-context-content">
          <div class="v2-context-main" data-v2-slot="context"></div>
          <div class="v2-context-stats" data-v2-slot="context-stats"></div>
        </div>
      </section>

      <div class="v2-center-column">
        <section class="v2-hub" data-v2-hub aria-label="Artemis orchestration core">
          <div class="v2-stage-slot" data-v2-slot="stage"></div>
          ${hubRingMarkup()}
          <div class="v2-hub-readouts" data-v2-slot="hub-readouts"></div>
        </section>
        <section class="v2-skills" aria-labelledby="v2SkillsSummary">
          <div class="v2-skills-heading">
            <h2 id="v2SkillsSummary" data-v2-skill-summary aria-live="polite">${MOON_INFO.length} SKILLS ONLINE · CONNECTING SPECIALISTS</h2>
            <span>CAPABILITY DOMAINS</span>
          </div>
          <ul class="v2-skill-list" data-v2-skills></ul>
        </section>
      </div>
    </section>
    <div class="v2-dock-slot" data-v2-slot="dock"></div>`;
}

function spokeMarkup(name, delay) {
  return `<g class="v2-spoke" data-v2-spoke="${name}" style="--v2-spoke-delay:${delay};--v2-spoke-paint:url(#v2SpokeGradient-${name})">
    <path class="v2-spoke-base v2-spoke-rail v2-spoke-rail--dim" d="M0 0" pathLength="1"></path>
    <path class="v2-spoke-base v2-spoke-rail v2-spoke-rail--bright" d="M0 0" pathLength="1"></path>
    <path class="v2-spoke-ticks" d="M0 0"></path>
    <path class="v2-spoke-idle" d="M0 0" pathLength="1"></path>
    <path class="v2-spoke-activity" d="M0 0" pathLength="1"></path>
    <g class="v2-spoke-nodes"></g>
    <path class="v2-spoke-junction" d="M0 0"></path>
    <path class="v2-spoke-chevrons" d="M0 0"></path>
  </g>`;
}

function spokeGradientMarkup(name) {
  return `<linearGradient id="v2SpokeGradient-${name}" gradientUnits="userSpaceOnUse">
    <stop class="v2-spoke-gradient v2-spoke-gradient--hub" offset="0"></stop>
    <stop class="v2-spoke-gradient v2-spoke-gradient--rise" offset="0.2"></stop>
    <stop class="v2-spoke-gradient v2-spoke-gradient--full" offset="0.48"></stop>
    <stop class="v2-spoke-gradient v2-spoke-gradient--full" offset="1"></stop>
  </linearGradient>`;
}

function compactSpokePoints(points) {
  const compact = [];
  for (const point of points) {
    const previous = compact[compact.length - 1];
    if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.5) compact.push(point);
  }
  return compact;
}

function spokePath(points) {
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join("");
}

function spokeDirection(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length, length];
}

function offsetSpokePath(points, offset) {
  if (points.length < 2) return spokePath(points);
  const directions = points.slice(0, -1).map((point, index) => spokeDirection(point, points[index + 1]));
  const shifted = points.map(([x, y], index) => {
    if (index === 0 || index === points.length - 1) {
      const direction = directions[index === 0 ? 0 : directions.length - 1];
      return [x - direction[1] * offset, y + direction[0] * offset];
    }

    const previous = directions[index - 1];
    const next = directions[index];
    const denominator = 1 + previous[0] * next[0] + previous[1] * next[1];
    if (Math.abs(denominator) < 0.01) return [x - next[1] * offset, y + next[0] * offset];
    const normalX = -previous[1] - next[1];
    const normalY = previous[0] + next[0];
    return [x + normalX * offset / denominator, y + normalY * offset / denominator];
  });
  return spokePath(shifted);
}

function spokeTicksPath(points) {
  const ticks = [];
  let tickIndex = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [dx, dy, length] = spokeDirection(points[index], points[index + 1]);
    const normalX = -dy;
    const normalY = dx;
    for (let distance = 12; distance <= length - 12; distance += 24) {
      const centerX = points[index][0] + dx * distance;
      const centerY = points[index][1] + dy * distance;
      const half = tickIndex % 4 === 0 ? 3.5 : 2.75;
      ticks.push(`M${centerX - normalX * half} ${centerY - normalY * half}L${centerX + normalX * half} ${centerY + normalY * half}`);
      tickIndex += 1;
    }
  }
  return ticks.join("");
}

function spokeBends(points) {
  return points.slice(1, -1).filter((point, index) => {
    const previous = spokeDirection(points[index], point);
    const next = spokeDirection(point, points[index + 2]);
    return Math.abs(previous[0] * next[1] - previous[1] * next[0]) > 0.01;
  });
}

function spokeJunctionPath(points) {
  if (points.length < 2) return "";
  const [dx, dy] = spokeDirection(points[0], points[1]);
  const normalX = -dy;
  const normalY = dx;
  const centerX = points[0][0] + dx * 7;
  const centerY = points[0][1] + dy * 7;
  const radius = 3.75;
  return `M${centerX + dx * radius} ${centerY + dy * radius}`
    + `L${centerX + normalX * radius} ${centerY + normalY * radius}`
    + `L${centerX - dx * radius} ${centerY - dy * radius}`
    + `L${centerX - normalX * radius} ${centerY - normalY * radius}Z`;
}

function spokeChevronsPath(points) {
  if (points.length < 2) return "";
  const end = points[points.length - 1];
  const [dx, dy] = spokeDirection(points[points.length - 2], end);
  const normalX = -dy;
  const normalY = dx;
  return [1.5, 8].map((inset) => {
    const tipX = end[0] - dx * inset;
    const tipY = end[1] - dy * inset;
    const wingX = tipX - dx * 6;
    const wingY = tipY - dy * 6;
    return `M${wingX + normalX * 3.25} ${wingY + normalY * 3.25}`
      + `L${tipX} ${tipY}`
      + `L${wingX - normalX * 3.25} ${wingY - normalY * 3.25}`;
  }).join("");
}

function hubRingMarkup() {
  return `<svg class="v2-hub-rings" viewBox="0 0 200 200" aria-hidden="true">
    <g class="v2-hub-outer-rotor"><circle class="v2-hub-ring v2-hub-ring--outer" cx="100" cy="100" r="96" pathLength="100"></circle></g>
    <circle class="v2-hub-ring v2-hub-ring--solid" cx="100" cy="100" r="86"></circle>
    <g class="v2-hub-inner-rotor"><circle class="v2-hub-ring v2-hub-ring--dash" cx="100" cy="100" r="79" pathLength="100"></circle></g>
    <g class="v2-hub-radar"><path d="M100 100 100 8A92 92 0 0 1 128.4 12.5Z"></path></g>
    <path class="v2-hub-ticks" d="M100 1v9M100 190v9M1 100h9M190 100h9M28 28l7 7M165 165l7 7M28 172l7-7M165 35l7-7"></path>
    <g class="v2-hub-nodes">
      <circle cx="100" cy="4" r="3.7"></circle><circle cx="196" cy="100" r="3.7"></circle>
      <circle cx="100" cy="196" r="3.7"></circle><circle cx="4" cy="100" r="3.7"></circle>
    </g>
  </svg>`;
}

function wireSphereMarkup() {
  return `<svg viewBox="0 0 92 92">
    <circle cx="46" cy="46" r="34"></circle><ellipse cx="46" cy="46" rx="16" ry="34"></ellipse>
    <ellipse cx="46" cy="46" rx="34" ry="15"></ellipse><path d="M12 46h68M46 12v68"></path>
    <path d="M21 23c14 9 36 9 50 0M21 69c14-9 36-9 50 0"></path>
    <circle class="v2-motif-node" cx="18" cy="34" r="2"></circle><circle class="v2-motif-node" cx="69" cy="24" r="2"></circle>
    <circle class="v2-motif-node" cx="72" cy="60" r="2"></circle><circle class="v2-motif-node" cx="35" cy="78" r="2"></circle>
  </svg>`;
}

function buildSkillBand(shell) {
  const iconPaths = Object.freeze({
    BRIEF: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 11h6M9 15h6"/>',
    RADAR: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 12l5-5M4 12h2M18 12h2M12 4v2"/>',
    PLAN: '<path d="M5 18c2-5 4-8 8-11l3-2 3 3-2 3c-3 4-6 6-11 8z"/><path d="M8 16l-3 3M14 8l3 3"/>',
    RESEARCH: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5M8 10.5h5M10.5 8v5"/>',
    MAIL: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m4 7 8 6 8-6"/>',
    MEDIA: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    MESSAGES: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    MEMORY: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    SCHOOL: '<path d="M4 5.5c3-1 5-.5 8 1.5v12c-3-2-5-2.5-8-1.5z"/><path d="M20 5.5c-3-1-5-.5-8 1.5v12c3-2 5-2.5 8-1.5z"/>',
    FINANCE: '<path d="M4 19h16M6 16v-4M11 16V8M16 16v-6M20 6l-4 4-4-2-5 4"/>',
    "FOLLOW-UPS": '<path d="M9 8 5 12l4 4"/><path d="M6 12h7a5 5 0 0 1 5 5v1"/><path d="m15 5 4 3-4 3"/>'
  });
  const order = ["BRIEF", "RADAR", "PLAN", "RESEARCH", "MAIL", "MEDIA", "MESSAGES", "MEMORY", "SCHOOL", "FINANCE", "FOLLOW-UPS"];
  const info = new Map(MOON_INFO.map((entry) => [entry.title, entry]));
  const list = shell.querySelector("[data-v2-skills]");
  const nodes = new Map();

  order.forEach((title, index) => {
    const item = document.createElement("li");
    const tooltipId = `v2-skill-tip-${index}`;
    item.className = "v2-skill";
    item.dataset.skill = title;
    item.tabIndex = 0;
    item.setAttribute("aria-describedby", tooltipId);
    item.innerHTML = `<span class="v2-skill-ring"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[title]}</svg><i class="v2-skill-status" aria-hidden="true"></i></span><strong></strong><span class="v2-skill-tooltip" id="${tooltipId}" role="tooltip"></span>`;
    item.querySelector("strong").textContent = title;
    item.querySelector(".v2-skill-tooltip").textContent = info.get(title)?.what || "Capability details unavailable.";
    list.appendChild(item);
    nodes.set(title, item);
  });
  return nodes;
}

function installPerformanceGuard(shell, panels) {
  const lowPower = (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4)
    || (navigator.deviceMemory && navigator.deviceMemory < 4);
  if (lowPower) body.classList.add("v2-low-motion");
  if (reducedMotion || lowPower) return;

  let flickerTimer = 0;
  const startFlicker = () => {
    if (flickerTimer || body.classList.contains("v2-low-motion")) return;
    flickerTimer = window.setInterval(() => {
      const options = Array.from(panels.values());
      const panel = options[Math.floor(Math.random() * options.length)];
      if (!panel) return;
      panel.classList.add("v2-flicker");
      window.setTimeout(() => panel.classList.remove("v2-flicker"), 360);
    }, 15000);
  };

  if (body.classList.contains("hud-in")) startFlicker();
  else {
    const gate = new MutationObserver(() => {
      if (!body.classList.contains("hud-in")) return;
      gate.disconnect();
      startFlicker();
    });
    gate.observe(body, { attributes: true, attributeFilter: ["class"] });
  }

  let frames = 0;
  let first = 0;
  const sample = (now) => {
    if (!first) first = now;
    frames += 1;
    if (frames < 45) {
      requestAnimationFrame(sample);
      return;
    }
    if (now - first > 1250) {
      body.classList.add("v2-low-motion");
      window.clearInterval(flickerTimer);
    }
  };
  requestAnimationFrame(sample);
}
