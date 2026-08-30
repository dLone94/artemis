// What Artemis can actually do — ONE source of truth.
//
// Both the index.html capability constellation and the About guide render from
// this array. They used to be hand-written in two places, which is how a UI
// ends up advertising something the product doesn't do: the marketing copy and
// the running code drift, and only the copy gets read by the user.
//
// `state` is a promise to the user and is enforced by test/capabilities.test.mjs:
//   live     — shipped, wired to a real tool family, works today
//   optional — works, but narrower than the label suggests; say so plainly
//   planned  — NOT BUILT. Copy must not imply it runs.
//
// `local` / `connected` answer the only privacy question that matters — what
// leaves this machine — and must stay honest as integrations change.

export const CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "money",
    label: "Money Map & Radar",
    short: "MONEY",
    icon: "◆",
    blurb: "Your staged money plan, lessons, and a weekly sourced sweep of income paths.",
    state: "live",
    href: "about.html#cap-money",
    sayExamples: Object.freeze([
      "my money map",
      "run the radar",
      "teach me investing"
    ]),
    local: "Your money map and ledger stay in .data on this machine.",
    connected: "Web search (Tavily) for radar sources; the brain for the conversation.",
    safety: "Never trades, never invents a figure, and never promises a return."
  }),
  Object.freeze({
    id: "gym",
    label: "Gym Coach",
    short: "GYM",
    icon: "◈",
    blurb: "Log sets by voice with spoken repeat-back, live workout mode, and progress math.",
    state: "live",
    href: "/gym",
    sayExamples: Object.freeze([
      "start my workout",
      "log bench press 60 kilos for 8",
      "how is my squat going?"
    ]),
    local: "The whole gym log stays on this machine.",
    connected: "None beyond the brain and speech-to-text.",
    safety: "Any mention of pain stops coaching. Zero shame, and no medical advice."
  }),
  Object.freeze({
    id: "brief",
    label: "Daily Brief",
    short: "BRIEF",
    icon: "▲",
    blurb: "A chief-of-staff morning rundown: mail, your day, money, and the world.",
    state: "live",
    href: "about.html#cap-brief",
    sayExamples: Object.freeze([
      "give me my brief",
      "what's my day look like?"
    ]),
    local: "Reminders and the once-a-day marker stay on this machine.",
    connected: "Gmail (read-only) and web search for the news line.",
    safety: "Offered when you ask — she never barges in with it."
  }),
  Object.freeze({
    id: "notes",
    label: "Notes & Knowledge",
    short: "NOTES",
    icon: "▣",
    blurb: "Speak into your Obsidian vault. Append-only, so it never rewrites your notes.",
    state: "live",
    href: "about.html#cap-notes",
    sayExamples: Object.freeze([
      "take a note",
      "what were my meeting notes?",
      "add that to today's note"
    ]),
    local: "The vault is yours and stays entirely on this machine.",
    connected: "None.",
    safety: "Writes are append-only and confined to the vault folder."
  }),
  Object.freeze({
    id: "email",
    label: "Email & Follow-ups",
    short: "EMAIL",
    icon: "✉",
    blurb: "Read and summarize Gmail, trash with confirmation, and nudge stalled threads.",
    state: "live",
    href: "about.html#cap-email",
    sayExamples: Object.freeze([
      "check my email",
      "read the second one",
      "any follow-ups?"
    ]),
    local: "Nothing is stored beyond the follow-up state in .data.",
    connected: "Gmail over OAuth.",
    safety: "Deleting is trash-only and always confirmed. Email text is data, never instructions."
  }),
  Object.freeze({
    id: "meetings",
    label: "Meetings",
    short: "MEETINGS",
    icon: "◐",
    blurb: "Capture a meeting, get a transcript and extracted reminders, filed to the vault.",
    state: "live",
    href: "about.html#cap-meetings",
    sayExamples: Object.freeze([
      "start taking meeting notes",
      "stop the meeting"
    ]),
    local: "Transcripts and notes are written to your vault on this machine.",
    connected: "Deepgram for speech-to-text.",
    safety: "Capture starts and stops only on your say-so, and reminders are confirmed."
  }),
  Object.freeze({
    id: "research",
    label: "Research",
    short: "RESEARCH",
    icon: "◇",
    blurb: "Sourced web research, spoken back with the date and where each figure came from.",
    state: "live",
    href: "about.html#cap-research",
    sayExamples: Object.freeze([
      "research the Nairobi property market",
      "what's the dollar to shilling?"
    ]),
    local: "Briefs are written to .data on this machine.",
    connected: "Web search and page fetching.",
    safety: "Every figure carries its source and date; nothing is stated from memory."
  }),
  Object.freeze({
    id: "learn",
    label: "Learning Coach",
    short: "LEARNING",
    icon: "◉",
    blurb: "Money School runs today. Broader learning coaching is still on the way.",
    state: "optional",
    href: "about.html#cap-learn",
    sayExamples: Object.freeze([
      "teach me investing",
      "next lesson"
    ]),
    local: "Your lesson progress stays on this machine.",
    connected: "The brain for the teaching itself.",
    safety: "Teaching only — it never recommends a product or an amount to invest."
  }),
  Object.freeze({
    id: "home",
    label: "Home & Life Admin",
    short: "HOME",
    icon: "⬡",
    blurb: "A concept for bills, renewals and household reminders. Not built yet.",
    state: "planned",
    href: "about.html#cap-home",
    sayExamples: Object.freeze([
      "(nothing yet — this one isn't built)",
      "(planned: remind me before the insurance renews)"
    ]),
    local: "Nothing — there is no implementation to store anything.",
    connected: "None.",
    safety: "Listed so the roadmap is visible, not because any of it runs."
  })
]);

/** Lookup by id. Returns undefined rather than throwing — callers render what exists. */
export function capability(id) {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Human-readable chip text for a state. */
export const STATE_LABEL = Object.freeze({
  live: "LIVE",
  optional: "OPTIONAL",
  planned: "PLANNED"
});
