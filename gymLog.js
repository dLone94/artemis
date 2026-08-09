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

  return {
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
  if (!Number.isInteger(params.reps) || params.reps < 1 || params.reps > 50) {
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
    : params.set_number;
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 20) {
    return { ok: false, message: "A set number must be a whole number from 1 through 20." };
  }

  const set = {
    exerciseSlug: exercise.slug,
    exerciseName: exercise.name,
    weightGrams: parsedWeight.grams,
    unit: "kg",
    reps: params.reps,
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
