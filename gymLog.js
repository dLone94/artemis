// Pure gym-log domain. Persistence and time are supplied by callers.

import { stripSentinels } from "./untrusted.js";

export const STARTER_TEMPLATE = Object.freeze({
  id: "starter-full-body",
  name: "Starter full body",
  exercises: Object.freeze([
    "squat",
    "bench-press",
    "barbell-row",
    "overhead-press",
    "deadlift"
  ].map((slug) => Object.freeze({
    slug,
    targetSets: 3,
    targetReps: 8,
    restSeconds: 90
  })))
});

const EXERCISE_ALIASES = new Map([
  ["bench", ["bench-press", "Bench press"]],
  ["bench press", ["bench-press", "Bench press"]],
  ["flat bench", ["bench-press", "Bench press"]],
  ["squat", ["squat", "Squat"]],
  ["back squat", ["squat", "Squat"]],
  ["row", ["barbell-row", "Barbell row"]],
  ["barbell row", ["barbell-row", "Barbell row"]],
  ["ohp", ["overhead-press", "Overhead press"]],
  ["overhead press", ["overhead-press", "Overhead press"]],
  ["shoulder press", ["overhead-press", "Overhead press"]],
  ["military press", ["overhead-press", "Overhead press"]],
  ["deadlift", ["deadlift", "Deadlift"]],
  ["pull up", ["pull-up", "Pull-up"]],
  ["pull ups", ["pull-up", "Pull-up"]],
  ["pullup", ["pull-up", "Pull-up"]],
  ["pullups", ["pull-up", "Pull-up"]]
]);

function cleanText(value, limit) {
  return [...stripSentinels(typeof value === "string" ? value : "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()]
    .slice(0, limit)
    .join("");
}

function starterTemplate() {
  return {
    id: STARTER_TEMPLATE.id,
    name: STARTER_TEMPLATE.name,
    exercises: STARTER_TEMPLATE.exercises.map((exercise) => ({ ...exercise }))
  };
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isoTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizedStoredSet(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const exercise = canonicalExercise(candidate.exerciseSlug);
  if (
    !exercise ||
    !Number.isSafeInteger(candidate.weightGrams) ||
    candidate.weightGrams < 0 ||
    candidate.unit !== "kg" ||
    !Number.isInteger(candidate.reps) ||
    candidate.reps < 1 ||
    candidate.reps > 50 ||
    !Number.isInteger(candidate.setNumber) ||
    candidate.setNumber < 1 ||
    candidate.setNumber > 20
  ) {
    return null;
  }
  const set = {
    exerciseSlug: exercise.slug,
    exerciseName: exercise.name,
    weightGrams: candidate.weightGrams,
    unit: "kg",
    reps: candidate.reps,
    setNumber: candidate.setNumber
  };
  if (candidate.note !== undefined) {
    const note = cleanText(candidate.note, 120);
    if (note) set.note = note;
  }
  const at = isoTimestamp(candidate.at);
  if (at) set.at = at;
  return set;
}

function normalizedTemplate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const id = cleanText(candidate.id, 80);
  const name = cleanText(candidate.name, 80);
  if (!id || !name || !Array.isArray(candidate.exercises)) return null;
  const exercises = [];
  const seen = new Set();
  for (const storedExercise of candidate.exercises) {
    if (!storedExercise || typeof storedExercise !== "object" || Array.isArray(storedExercise)) {
      continue;
    }
    const exercise = canonicalExercise(storedExercise.slug);
    if (
      !exercise ||
      seen.has(exercise.slug) ||
      !Number.isInteger(storedExercise.targetSets) ||
      storedExercise.targetSets < 1 ||
      storedExercise.targetSets > 20 ||
      !Number.isInteger(storedExercise.targetReps) ||
      storedExercise.targetReps < 1 ||
      storedExercise.targetReps > 50 ||
      !Number.isInteger(storedExercise.restSeconds) ||
      storedExercise.restSeconds < 0 ||
      storedExercise.restSeconds > 600
    ) {
      continue;
    }
    seen.add(exercise.slug);
    exercises.push({
      slug: exercise.slug,
      targetSets: storedExercise.targetSets,
      targetReps: storedExercise.targetReps,
      restSeconds: storedExercise.restSeconds
    });
  }
  return exercises.length ? { id, name, exercises } : null;
}

export function canonicalExercise(text) {
  const heard = cleanText(text, 80)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = EXERCISE_ALIASES.get(heard);
  return match ? { slug: match[0], name: match[1] } : null;
}

const POUNDS_MESSAGE = "pounds are coming — this version logs kilograms";
const WEIGHT_FORMAT_MESSAGE = "Say the kilogram weight with digits, such as 82.5.";

export function parseWeightToGrams(value, unit) {
  const normalizedUnit = cleanText(unit, 16).toLowerCase();
  if (["lb", "lbs", "pound", "pounds"].includes(normalizedUnit)) {
    return { ok: false, message: POUNDS_MESSAGE };
  }
  if (normalizedUnit !== "kg") {
    return { ok: false, message: "Weight must use kilograms." };
  }

  const input = Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string"
      ? cleanText(value, 40).toLowerCase()
      : "";
  const match = input.match(
    /^(0|[1-9]\d*)(?:\.(\d{1,3}))?\s*(?:kg|kgs|kilo|kilos|kilogram|kilograms)?$/
  );
  if (!match) return { ok: false, message: WEIGHT_FORMAT_MESSAGE };

  const wholeGrams = BigInt(match[1]) * 1000n;
  const fractionalGrams = BigInt((match[2] || "").padEnd(3, "0") || "0");
  const grams = wholeGrams + fractionalGrams;
  if (grams > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, message: "That kilogram weight is too large to log safely." };
  }
  return { ok: true, grams: Number(grams) };
}

export function spokenKg(weightGrams) {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) return "unknown kilos";
  const grams = BigInt(weightGrams);
  const whole = grams / 1000n;
  const remainder = grams % 1000n;
  if (remainder === 0n) return `${whole} kilos`;
  const decimals = remainder.toString().padStart(3, "0").replace(/0+$/, "");
  return `${whole}.${decimals} kilos`;
}

export function normalizeGymLog(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return {
      version: 1,
      revision: 0,
      unit: "kg",
      workouts: [],
      templates: [starterTemplate()],
      history: [],
      updatedAt: null
    };
  }
  const workoutsByDate = new Map();
  if (Array.isArray(stored.workouts)) {
    for (const candidate of stored.workouts) {
      if (!candidate || typeof candidate !== "object" || !isDateKey(candidate.date)) continue;
      const workout = workoutsByDate.get(candidate.date) || { date: candidate.date, sets: [] };
      if (Array.isArray(candidate.sets)) {
        for (const storedSet of candidate.sets) {
          const set = normalizedStoredSet(storedSet);
          if (set) workout.sets.push(set);
        }
      }
      const finishedAt = isoTimestamp(candidate.finishedAt);
      if (finishedAt) workout.finishedAt = finishedAt;
      workoutsByDate.set(candidate.date, workout);
    }
  }

  const history = [];
  if (Array.isArray(stored.history)) {
    for (const candidate of stored.history) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const at = isoTimestamp(candidate.at);
      const exercise = canonicalExercise(candidate.exerciseSlug);
      const summary = cleanText(candidate.summary, 500);
      if (candidate.kind === "set") {
        if (!at || !isDateKey(candidate.date) || !exercise || !summary) continue;
        history.push({
          at,
          kind: "set",
          date: candidate.date,
          exerciseSlug: exercise.slug,
          summary
        });
      } else if (candidate.kind === "template") {
        const templateId = cleanText(candidate.templateId, 80);
        if (!at || !templateId || !exercise || !summary) continue;
        history.push({
          at,
          kind: "template",
          templateId,
          exerciseSlug: exercise.slug,
          summary
        });
      }
    }
  }

  const storedTemplates = Array.isArray(stored.templates)
    ? stored.templates.map(normalizedTemplate).filter(Boolean)
    : [];
  const storedStarter = storedTemplates.find((template) => template.id === STARTER_TEMPLATE.id);
  const templates = [storedStarter || starterTemplate()];
  for (const template of storedTemplates) {
    if (template.id !== STARTER_TEMPLATE.id && !templates.some((entry) => entry.id === template.id)) {
      templates.push(template);
    }
  }

  const normalized = {
    version: 1,
    revision: Number.isSafeInteger(stored.revision) && stored.revision >= 0
      ? stored.revision
      : 0,
    unit: "kg",
    workouts: [...workoutsByDate.values()],
    templates,
    history,
    updatedAt: isoTimestamp(stored.updatedAt)
  };
  const session = normalizedSession(stored.session, normalized.templates);
  if (session) normalized.session = session;
  return normalized;
}

// A live workout survives an app restart: the session rides the same stored
// document, and an entry that no longer makes sense (missing template, index
// out of range) is dropped rather than resurrected wrong.
function normalizedSession(candidate, templates) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const templateId = cleanText(candidate.templateId, 80);
  const template = templates.find((entry) => entry.id === templateId);
  const startedAt = isoTimestamp(candidate.startedAt);
  if (!template || !startedAt) return null;
  const exerciseIndex = candidate.exerciseIndex;
  if (
    !Number.isInteger(exerciseIndex) ||
    exerciseIndex < 0 ||
    exerciseIndex > template.exercises.length
  ) {
    return null;
  }
  const session = { templateId, startedAt, exerciseIndex, restUntil: null, extraTargets: {} };
  const restUntil = isoTimestamp(candidate.restUntil);
  if (restUntil) session.restUntil = restUntil;
  if (candidate.extraTargets && typeof candidate.extraTargets === "object" &&
      !Array.isArray(candidate.extraTargets)) {
    for (const [slug, extra] of Object.entries(candidate.extraTargets)) {
      const exercise = canonicalExercise(slug);
      if (exercise && Number.isInteger(extra) && extra >= 1 && extra <= 10) {
        session.extraTargets[exercise.slug] = extra;
      }
    }
  }
  return session;
}

function epochSeconds(iso) {
  const timestamp = isoTimestamp(iso);
  if (!timestamp) return null;
  return Math.floor(Date.parse(timestamp) / 1000);
}

const NO_SESSION_MESSAGE = "no workout running — say start workout";

export function startSession(log, templateId, isoNow) {
  const current = normalizeGymLog(log);
  const at = isoTimestamp(isoNow);
  if (!at) return { ok: false, message: "Starting a workout needs a valid ISO timestamp." };
  if (current.session) {
    return { ok: false, message: "A workout is already running — say finish workout first." };
  }
  const wantedId = cleanText(templateId, 80);
  const template = wantedId
    ? current.templates.find((entry) => entry.id === wantedId)
    : current.templates[0];
  if (!template) {
    return { ok: false, message: `I could not find the template "${wantedId}".` };
  }
  current.session = {
    templateId: template.id,
    startedAt: at,
    exerciseIndex: 0,
    restUntil: null,
    extraTargets: {}
  };
  return current;
}

function sessionTemplate(current) {
  return current.session
    ? current.templates.find((entry) => entry.id === current.session.templateId) || null
    : null;
}

function setsLoggedOn(current, date, slug) {
  const workout = current.workouts.find((entry) => entry.date === date);
  return workout ? workout.sets.filter((set) => set.exerciseSlug === slug).length : 0;
}

function targetWithExtras(session, exercise) {
  return exercise.targetSets + (session.extraTargets[exercise.slug] || 0);
}

export function sessionState(log, now) {
  const current = normalizeGymLog(log);
  const template = sessionTemplate(current);
  const nowSeconds = epochSeconds(now);
  if (!current.session || !template || nowSeconds === null) return null;
  const session = current.session;
  const today = isoTimestamp(now).slice(0, 10);
  const done = session.exerciseIndex >= template.exercises.length;
  const entry = done ? null : template.exercises[session.exerciseIndex];
  const exercise = entry ? canonicalExercise(entry.slug) : null;
  const nextEntry = done ? null : template.exercises[session.exerciseIndex + 1] || null;
  const nextExercise = nextEntry ? canonicalExercise(nextEntry.slug) : null;

  let restRemainingSeconds = null;
  let restUntil = null;
  if (session.restUntil) {
    const restSeconds = epochSeconds(session.restUntil);
    if (restSeconds !== null && restSeconds > nowSeconds) {
      restUntil = session.restUntil;
      restRemainingSeconds = restSeconds - nowSeconds;
    }
  }

  let lastTime = null;
  if (entry) {
    const previous = progress(current, entry.slug).lastSession;
    if (previous && previous.sets.length) {
      lastTime = previous.sets.reduce(
        (top, set) => setIsBetter(set, top) ? set : top,
        null
      );
      lastTime = { weightGrams: lastTime.weightGrams, reps: lastTime.reps };
    }
  }

  const setsLoggedTotal = (current.workouts.find((w) => w.date === today) || { sets: [] })
    .sets.length;
  return {
    templateId: session.templateId,
    startedAt: session.startedAt,
    exerciseIndex: session.exerciseIndex,
    exercise: entry
      ? {
          slug: entry.slug,
          name: exercise.name,
          targetSets: targetWithExtras(session, entry),
          targetReps: entry.targetReps,
          restSeconds: entry.restSeconds
        }
      : null,
    setsLoggedThisExercise: entry ? setsLoggedOn(current, today, entry.slug) : 0,
    setsLoggedTotal,
    restUntil,
    restRemainingSeconds,
    lastTime,
    upNext: nextExercise ? { slug: nextEntry.slug, name: nextExercise.name } : null,
    done
  };
}

export function noteSetLogged(log, exerciseSlug, isoNow) {
  const current = normalizeGymLog(log);
  const template = sessionTemplate(current);
  const at = isoTimestamp(isoNow);
  const exercise = canonicalExercise(exerciseSlug);
  if (!current.session || !template || !at || !exercise) return current;
  const session = current.session;
  if (session.exerciseIndex >= template.exercises.length) return current;
  const entry = template.exercises[session.exerciseIndex];
  if (entry.slug !== exercise.slug) return current; // off-plan set: no session effect

  const nowSeconds = epochSeconds(at);
  session.restUntil = new Date((nowSeconds + entry.restSeconds) * 1000).toISOString();
  const today = at.slice(0, 10);
  if (setsLoggedOn(current, today, entry.slug) >= targetWithExtras(session, entry)) {
    session.exerciseIndex += 1; // extra sets never retreat the index
  }
  return current;
}

export function advanceExercise(log, { skip = false } = {}) {
  const current = normalizeGymLog(log);
  const template = sessionTemplate(current);
  if (!current.session || !template) return { ok: false, message: NO_SESSION_MESSAGE };
  const session = current.session;
  if (session.exerciseIndex >= template.exercises.length) {
    return { ok: false, message: "That was the last exercise — say finish workout." };
  }
  session.exerciseIndex += 1;
  session.restUntil = null;
  void skip; // next and skip share semantics; the word choice is the user's
  return current;
}

export function addExtraSet(log) {
  const current = normalizeGymLog(log);
  const template = sessionTemplate(current);
  if (!current.session || !template) return { ok: false, message: NO_SESSION_MESSAGE };
  const session = current.session;
  if (session.exerciseIndex >= template.exercises.length) {
    return { ok: false, message: "That was the last exercise — say finish workout." };
  }
  const entry = template.exercises[session.exerciseIndex];
  const extra = (session.extraTargets[entry.slug] || 0) + 1;
  if (extra > 10) return { ok: false, message: "That's ten extra sets already — plenty." };
  session.extraTargets[entry.slug] = extra;
  return current;
}

export function finishSession(log, isoNow) {
  const current = normalizeGymLog(log);
  const template = sessionTemplate(current);
  const at = isoTimestamp(isoNow);
  if (!current.session || !template) return { ok: false, message: NO_SESSION_MESSAGE };
  if (!at) return { ok: false, message: "Finishing a workout needs a valid ISO timestamp." };

  const startSeconds = epochSeconds(current.session.startedAt);
  const endSeconds = epochSeconds(at);
  const today = at.slice(0, 10);
  const workout = current.workouts.find((entry) => entry.date === today);
  if (workout) workout.finishedAt = at;
  const sets = workout ? workout.sets.length : 0;
  const exercises = workout
    ? new Set(workout.sets.map((set) => set.exerciseSlug)).size
    : 0;
  const minutes = startSeconds !== null && endSeconds !== null && endSeconds >= startSeconds
    ? Math.floor((endSeconds - startSeconds) / 60)
    : 0;
  delete current.session;
  return { log: current, summary: { exercises, sets, minutes } };
}

/**
 * A whole count from either an integer or the digit string a model emits.
 *
 * log_set publishes reps and set_number as integer-or-string because a provider
 * validates the model's tool call against that schema and kills the turn with a
 * 400 when it disagrees. Nothing downstream should carry that compromise, so
 * both shapes collapse to a number here; anything else is null and the caller
 * speaks a real error. Deliberately strict: no decimals, no signs, no spelled
 * words, so "eight" and "8.5" stay mistakes rather than becoming a logged set.
 */
function wholeCount(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,3}$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function validateSet(params, log, today) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "A set must be one structured entry." };
  }
  const exercise = canonicalExercise(params.exercise);
  if (!exercise) {
    const heard = cleanText(params.exercise, 80) || "nothing";
    return {
      ok: false,
      message: `I heard "${heard}", but I don't recognize that exercise, so nothing was logged.`
    };
  }
  const allowed = new Set([
    "exercise",
    "weight_value",
    "unit",
    "reps",
    "set_number",
    "note",
    "raw_answer"
  ]);
  const extra = Object.keys(params).find((key) => !allowed.has(key));
  if (extra) return { ok: false, message: `Unknown set argument: ${extra}.` };
  if (!isDateKey(today)) return { ok: false, message: "A set needs a real YYYY-MM-DD date." };

  const parsedWeight = parseWeightToGrams(params.weight_value, params.unit);
  if (!parsedWeight.ok) return parsedWeight;
  const reps = wholeCount(params.reps);
  if (reps === null || reps < 1 || reps > 50) {
    return { ok: false, message: "Reps must be a whole number from 1 through 50." };
  }
  if (!cleanText(params.raw_answer, 500)) {
    return { ok: false, message: "Keep the user's original spoken set in raw_answer." };
  }
  if (params.note !== undefined && [...cleanText(params.note, 500)].length > 120) {
    return { ok: false, message: "A set note can be at most 120 characters." };
  }

  const current = normalizeGymLog(log);
  const existing = current.workouts.find((workout) => workout.date === today);
  const matchingSets = existing
    ? existing.sets.filter((set) => set.exerciseSlug === exercise.slug)
    : [];
  const setNumber = params.set_number === undefined
    ? matchingSets.length + 1
    : wholeCount(params.set_number);
  if (setNumber === null || setNumber < 1 || setNumber > 20) {
    return { ok: false, message: "A set number must be a whole number from 1 through 20." };
  }

  const set = {
    exerciseSlug: exercise.slug,
    exerciseName: exercise.name,
    weightGrams: parsedWeight.grams,
    unit: "kg",
    reps,
    setNumber
  };
  const note = cleanText(params.note, 120);
  if (note) set.note = note;
  return {
    ok: true,
    set,
    workout: existing
      ? { date: existing.date, sets: existing.sets.map((entry) => ({ ...entry })) }
      : { date: today, sets: [] }
  };
}

export function applySet(log, validated, isoNow) {
  const current = normalizeGymLog(log);
  const at = isoTimestamp(isoNow);
  if (!at) throw new TypeError("Set changes need a valid ISO timestamp.");
  if (
    !validated ||
    validated.ok !== true ||
    !validated.workout ||
    !isDateKey(validated.workout.date)
  ) {
    throw new TypeError("Only a validated set can be applied.");
  }
  const set = normalizedStoredSet({ ...validated.set, at });
  if (!set) throw new TypeError("Only a validated set can be applied.");
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("The gym-log revision cannot be incremented safely.");
  }

  let workout = current.workouts.find((entry) => entry.date === validated.workout.date);
  if (!workout) {
    workout = { date: validated.workout.date, sets: [] };
    current.workouts.push(workout);
  }
  workout.sets.push(set);
  current.history.push({
    at,
    kind: "set",
    date: workout.date,
    exerciseSlug: set.exerciseSlug,
    summary:
      `Logged ${set.exerciseName}, ${spokenKg(set.weightGrams)}, ` +
      `${set.reps} reps — set ${set.setNumber}.`
  });
  current.revision += 1;
  current.updatedAt = at;
  return current;
}

function setIsBetter(left, right) {
  if (!right) return true;
  return left.weightGrams > right.weightGrams ||
    (left.weightGrams === right.weightGrams && left.reps >= right.reps);
}

export function progress(log, exerciseSlug) {
  const exercise = canonicalExercise(exerciseSlug);
  if (!exercise) return { lastSession: null, pr: null, suggestion: null };
  const current = normalizeGymLog(log);
  const updatedSet = current.updatedAt && [...current.history].reverse().find(
    (event) => event.kind === "set" && event.at === current.updatedAt
  );
  const currentDate = updatedSet
    ? updatedSet.date
    : current.updatedAt && current.updatedAt.slice(0, 10);
  const sessions = current.workouts
    .map((workout) => ({
      date: workout.date,
      sets: workout.sets.filter((set) => set.exerciseSlug === exercise.slug)
    }))
    .filter((workout) => workout.sets.length)
    .sort((left, right) => left.date.localeCompare(right.date));

  const priorSessions = currentDate && isDateKey(currentDate)
    ? sessions.filter((session) => session.date < currentDate)
    : sessions;
  const previous = priorSessions.at(-1) || null;
  const lastSession = previous
    ? {
        date: previous.date,
        sets: previous.sets.map((set) => ({
          weightGrams: set.weightGrams,
          reps: set.reps
        }))
      }
    : null;

  let best = null;
  for (const session of sessions) {
    for (const set of session.sets) {
      if (set.reps < 1) continue;
      if (setIsBetter(set, best)) {
        best = {
          weightGrams: set.weightGrams,
          reps: set.reps,
          date: session.date
        };
      }
    }
  }

  let suggestion = null;
  if (previous) {
    const topSet = previous.sets.reduce(
      (top, set) => setIsBetter(set, top) ? set : top,
      null
    );
    const todayAlreadyHeavier = currentDate && sessions.some(
      (session) => session.date === currentDate &&
        session.sets.some((set) => set.weightGrams > topSet.weightGrams)
    );
    if (topSet.reps < 12 && !todayAlreadyHeavier) {
      suggestion =
        `Last time you did ${topSet.reps} reps at this weight — ` +
        `try ${topSet.reps + 1} if form feels solid.`;
    }
  }

  return { lastSession, pr: best, suggestion };
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function dayNumber(dateKey) {
  if (!isDateKey(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY;
}

export function consistency(log, today, weeks = 4) {
  if (!Number.isSafeInteger(weeks) || weeks < 1) return { workoutsPerWeek: [] };
  const todayNumber = dayNumber(today);
  const workoutsPerWeek = Array.from({ length: weeks }, () => 0);
  if (todayNumber === null) return { workoutsPerWeek };

  for (const workout of normalizeGymLog(log).workouts) {
    const workoutNumber = dayNumber(workout.date);
    if (workoutNumber === null) continue;
    const daysAgo = todayNumber - workoutNumber;
    if (!Number.isInteger(daysAgo) || daysAgo < 0) continue;
    const bucket = Math.floor(daysAgo / 7);
    if (bucket < weeks) workoutsPerWeek[bucket] += 1;
  }
  return { workoutsPerWeek };
}

export function applyTemplateEdit(log, params, isoNow) {
  const current = normalizeGymLog(log);
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "A template edit must be one structured change." };
  }
  const allowed = new Set([
    "template_id",
    "exercise",
    "replacement_exercise",
    "target_sets",
    "target_reps",
    "rest_seconds",
    "raw_answer",
    "expected_revision",
    "revision"
  ]);
  const extra = Object.keys(params).find((key) => !allowed.has(key));
  if (extra) return { ok: false, message: `Unknown template-edit argument: ${extra}.` };
  const expectedRevision = params.expected_revision === undefined
    ? params.revision
    : params.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
    return {
      ok: false,
      message: "The gym log changed before you confirmed, so nothing changed."
    };
  }
  const at = isoTimestamp(isoNow);
  if (!at) return { ok: false, message: "Template edits need a valid ISO timestamp." };
  if (!cleanText(params.raw_answer, 500)) {
    return { ok: false, message: "Keep the user's original template change in raw_answer." };
  }

  const templateId = cleanText(params.template_id, 80) || STARTER_TEMPLATE.id;
  const template = current.templates.find((entry) => entry.id === templateId);
  if (!template) return { ok: false, message: `I could not find the template "${templateId}".` };
  const exercise = canonicalExercise(params.exercise);
  if (!exercise) {
    const heard = cleanText(params.exercise, 80) || "nothing";
    return {
      ok: false,
      message: `I heard "${heard}", but I don't recognize that exercise, so nothing changed.`
    };
  }
  const index = template.exercises.findIndex((entry) => entry.slug === exercise.slug);
  if (index < 0) {
    return { ok: false, message: `${exercise.name} is not in ${template.name}.` };
  }
  const existing = template.exercises[index];
  const replacement = params.replacement_exercise === undefined
    ? exercise
    : canonicalExercise(params.replacement_exercise);
  if (!replacement) {
    const heard = cleanText(params.replacement_exercise, 80) || "nothing";
    return {
      ok: false,
      message: `I heard "${heard}", but I don't recognize that exercise, so nothing changed.`
    };
  }
  if (
    replacement.slug !== existing.slug &&
    template.exercises.some((entry) => entry.slug === replacement.slug)
  ) {
    return { ok: false, message: `${replacement.name} is already in ${template.name}.` };
  }

  const targetSets = params.target_sets === undefined ? existing.targetSets : params.target_sets;
  const targetReps = params.target_reps === undefined ? existing.targetReps : params.target_reps;
  const restSeconds = params.rest_seconds === undefined
    ? existing.restSeconds
    : params.rest_seconds;
  if (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > 20) {
    return { ok: false, message: "Target sets must be a whole number from 1 through 20." };
  }
  if (!Number.isInteger(targetReps) || targetReps < 1 || targetReps > 50) {
    return { ok: false, message: "Target reps must be a whole number from 1 through 50." };
  }
  if (!Number.isInteger(restSeconds) || restSeconds < 0 || restSeconds > 600) {
    return { ok: false, message: "Rest seconds must be a whole number from 0 through 600." };
  }
  if (
    replacement.slug === existing.slug &&
    targetSets === existing.targetSets &&
    targetReps === existing.targetReps &&
    restSeconds === existing.restSeconds
  ) {
    return { ok: false, message: "Those template targets are already stored." };
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, message: "The gym-log revision cannot be incremented safely." };
  }

  template.exercises[index] = {
    slug: replacement.slug,
    targetSets,
    targetReps,
    restSeconds
  };
  const targetSummary =
    `targets from ${existing.targetSets} by ${existing.targetReps} ` +
    `to ${targetSets} by ${targetReps}`;
  current.history.push({
    at,
    kind: "template",
    templateId: template.id,
    exerciseSlug: replacement.slug,
    summary: replacement.slug === existing.slug
      ? `Changed ${template.name} ${exercise.name.toLowerCase()} ${targetSummary}.`
      : `Changed ${template.name} from ${exercise.name} to ${replacement.name}, ${targetSummary}.`
  });
  current.revision += 1;
  current.updatedAt = at;
  return current;
}
