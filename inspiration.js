// One line to carry the day. Original aphorisms — no attribution to get wrong,
// no repetition until the whole set has cycled. Day-seeded so the line changes
// each calendar day but stays stable within one day (restarts don't reshuffle).
const LINES = [
  "Every day you invest in yourself is a day the sea can't take back.",
  "Small steady steps beat grand plans that never leave the harbor.",
  "The best time to plant a tree was twenty years ago. The second best time is today.",
  "Discipline is choosing what you want most over what you want now.",
  "A calm sea never made a skilled sailor — and today you're skilled.",
  "You're not working for money. You're working for mornings at home.",
  "Progress hides in boring days. Show up anyway.",
  "The distance to your family is temporary. What you build for them isn't.",
  "Don't count the days — make the days count toward home.",
  "Rich isn't a number. It's choosing your own tide.",
  "One lesson learned today is compound interest on every tomorrow.",
  "Storms pass. Habits stay. Build the habits.",
  "Your future self is watching today with gratitude or regret. Your call.",
  "Money is stored time. Spend the money on time you love.",
  "The plan doesn't need to be perfect. It needs to be yours, and followed.",
  "Courage isn't loud. Sometimes it's saving quietly for years.",
  "Home is the harbor. Everything you do out here points the bow there.",
  "You can't control the wind, only the set of your sails — trim them daily.",
  "What you do when nobody's watching is what your daughter will inherit.",
  "Slow is smooth, smooth is fast — with money most of all.",
  "Every contract has an end date. Make sure your dependence on them does too.",
  "Ask questions like a beginner, decide like a captain.",
  "The market rewards patience more than brilliance.",
  "A reserve fund is courage you bought in advance.",
  "Learn one thing every watch. In a year you'll be a different man.",
  "Freedom is built in ordinary months, not lucky ones.",
  "The strongest anchor for a family is a father with a plan.",
  "Doubt kills more dreams than failure ever will.",
  "Start before you feel ready. Ready arrives on the way.",
  "Your time on ships is buying something. Make sure you're the one deciding what."
];

// The hand-off into the line. Varied on its own cycle (7 vs 30 shares no
// factor), so bridge+line pairings don't repeat for 210 days — a fixed
// "here's your quote" preamble would just be a new robotic tic.
const BRIDGES = [
  "Before you go — here's a thought for today.",
  "One more thing. I picked this for you today.",
  "And something to keep in your pocket:",
  "Here's what I'd underline today.",
  "A small thing worth hearing today:",
  "And for the road:",
  "One thought before the day starts."
];

// Fresh on EVERY entry, never the same twice in a row. Day-seeding sounded
// elegant and was wrong: the user enters several times a day and heard the
// identical sentence each time — the exact robotic tic this file exists to
// avoid. Last picks live in module state; a restart reshuffles, which is fine.
let lastLine = -1;
let lastBridge = -1;
function pickAvoiding(length, avoid) {
  let i = Math.floor(Math.random() * length);
  if (i === avoid) i = (i + 1 + Math.floor(Math.random() * (length - 1))) % length;
  return i;
}

/** A bridged line — different combination on every call. */
export function inspirationForDay() {
  lastBridge = pickAvoiding(BRIDGES.length, lastBridge);
  lastLine = pickAvoiding(LINES.length, lastLine);
  return BRIDGES[lastBridge] + " " + LINES[lastLine];
}

export const INSPIRATION_COUNT = LINES.length;
