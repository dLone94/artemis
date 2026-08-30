// Capability domains and the tool families that light them up — ONE source of
// truth, shared by the Artemis Core (the hero visualization), the v2 skill
// list, the About guide's context cards, and the retired VoiceOrb on /orb.html.
//
// This used to live inside voiceOrb.js. It moved here when the Core replaced
// the globe, because the data is about what Artemis can DO — it was never about
// how a sphere is drawn, and two visualizations now render from it.
//
// FAMILY_NAMES are the real `family` values the server puts on the SSE `tool`
// event (see the tool registry). CAPABILITY_OF_FAMILY maps each one onto the
// capability node that should illuminate while that tool runs. Both arrays are
// index-aligned and must stay that way; test/coreState.test.mjs enforces it.

/** The capability nodes rendered around the Core, in ring order. */
export const CAPABILITIES = Object.freeze([
  { title: "RESEARCH", what: "Web research with sources.", say: "should I invest in… / research…" },
  { title: "MAIL", what: "Reads, checks and trashes Gmail — trash only, always asks.", say: "check my email · delete number 2" },
  { title: "MESSAGES", what: "WhatsApp unread checks and drafted sends you approve.", say: "any WhatsApp messages?" },
  { title: "MEDIA", what: "Opens sites, plays music and video.", say: "play some jazz · open YouTube" },
  { title: "MEMORY", what: "Notes, reminders and meeting notes.", say: "take notes · what were my meeting notes?" },
  { title: "FINANCE", what: "Live market figures, always with source and date.", say: "what's the dollar to shilling?" },
  { title: "BRIEF", what: "Your morning rundown: mail, day, money minute, world.", say: "give me my brief" },
  { title: "FOLLOW-UPS", what: "Who owes you a reply, and whom you owe. Nudges you send.", say: "any follow-ups?" },
  { title: "SCHOOL", what: "Investing lessons from zero, one at a time.", say: "teach me investing · next lesson" },
  { title: "PLAN", what: "Your Money Map: staged plan from your own numbers.", say: "my money map" },
  { title: "RADAR", what: "Weekly sourced sweep of your opportunity themes.", say: "run the radar" }
].map(Object.freeze));

/** Real `family` values emitted on the SSE tool event. */
export const FAMILY_NAMES = Object.freeze([
  "research",
  "web",
  "email",
  "messages",
  "media",
  "navigate",
  "memory",
  "notes",
  "finance",
  "briefing",
  "followups",
  "followups_nudge",
  "school",
  "map",
  "map_update",
  "radar",
  "radar_update",
  "meeting"
]);

/** family index -> CAPABILITIES index. Index-aligned with FAMILY_NAMES. */
export const CAPABILITY_OF_FAMILY = new Int8Array([0, 0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7, 8, 9, 9, 10, 10, 4]);

/**
 * Which capability node should light for a tool family?
 * Returns an index into CAPABILITIES, or -1 when the family is unknown —
 * an unknown family must light nothing rather than guess.
 */
export function capabilityForFamily(family) {
  if (typeof family !== "string") return -1;
  const key = family.trim().toLowerCase();
  const i = FAMILY_NAMES.indexOf(key);
  return i < 0 ? -1 : CAPABILITY_OF_FAMILY[i];
}

// Legacy alias: the VoiceOrb on /orb.html still calls these "moons".
export const MOON_INFO = CAPABILITIES;
