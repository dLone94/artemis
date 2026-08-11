// Gym-log domain contract. Pure module tests use literal fixtures and never
// touch the user's persisted data.
// Run: node --test test/gym.test.mjs
import assert from "node:assert";
import test from "node:test";

const {
  STARTER_TEMPLATE,
  applySet,
  applyTemplateEdit,
  canonicalExercise,
  consistency,
  normalizeGymLog,
  parseWeightToGrams,
  progress,
  spokenKg,
  validateSet
} = await import("../gymLog.js");
const {
  confirmPromptFor,
  getSkill,
  precheckSkill
} = await import("../skills.js");
const {
  classifyIntent,
  needsConfirmation,
  toolByName,
  toolDefsForFamily,
  validateToolCall
} = await import("../toolRegistry.js");

function gymFixture(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    unit: "kg",
    workouts: [],
    templates: [structuredClone(STARTER_TEMPLATE)],
    history: [],
    updatedAt: null,
    ...overrides
  };
}

function storedSet(exerciseSlug, weightGrams, reps, setNumber = 1) {
  return { exerciseSlug, weightGrams, unit: "kg", reps, setNumber };
}

function clone(value) {
  return structuredClone(value);
}

function memoryCtx(initial = {}, now = "2026-08-09T08:00:00.000Z") {
  const files = new Map(
    Object.entries(initial).map(([name, value]) => [name, clone(value)])
  );
  let writes = 0;
  return {
    files,
    now: () => new Date(now),
    readJson: async (name, fallback) =>
      files.has(name) ? clone(files.get(name)) : clone(fallback),
    writeJson: async (name, value) => {
      writes += 1;
      files.set(name, clone(value));
    },
    get writeCount() {
      return writes;
    }
  };
}

test("exercise aliases stay canonical and an empty store gets the starter template", () => {
  assert.deepEqual(canonicalExercise("bench"), {
    slug: "bench-press",
    name: "Bench press"
  });
  assert.deepEqual(canonicalExercise("flat bench"), {
    slug: "bench-press",
    name: "Bench press"
  });
  assert.deepEqual(canonicalExercise("back squat"), {
    slug: "squat",
    name: "Squat"
  });
  assert.deepEqual(canonicalExercise("barbell row"), {
    slug: "barbell-row",
    name: "Barbell row"
  });
  assert.deepEqual(canonicalExercise("military press"), {
    slug: "overhead-press",
    name: "Overhead press"
  });
  assert.deepEqual(canonicalExercise("deadlift"), {
    slug: "deadlift",
    name: "Deadlift"
  });
  assert.deepEqual(canonicalExercise("pull-ups"), {
    slug: "pull-up",
    name: "Pull-up"
  });
  assert.equal(canonicalExercise("cable fly"), null);

  const empty = normalizeGymLog(null);
  assert.deepEqual(empty, {
    version: 1,
    revision: 0,
    unit: "kg",
    workouts: [],
    templates: [STARTER_TEMPLATE],
    history: [],
    updatedAt: null
  });
  assert.deepEqual(
    STARTER_TEMPLATE.exercises.map(({ slug, targetSets, targetReps, restSeconds }) => ({
      slug,
      targetSets,
      targetReps,
      restSeconds
    })),
    ["squat", "bench-press", "barbell-row", "overhead-press", "deadlift"].map(
      (slug) => ({ slug, targetSets: 3, targetReps: 8, restSeconds: 90 })
    )
  );
});

test("kilogram strings become exact integer grams and pounds are refused", () => {
  assert.deepEqual(parseWeightToGrams("82.5", "kg"), { ok: true, grams: 82500 });
  assert.deepEqual(parseWeightToGrams("0.5", "kg"), { ok: true, grams: 500 });
  assert.deepEqual(parseWeightToGrams("82.005 kilos", "kg"), {
    ok: true,
    grams: 82005
  });
  assert.deepEqual(parseWeightToGrams(80, "kg"), { ok: true, grams: 80000 });
  assert.deepEqual(parseWeightToGrams("180", "lb"), {
    ok: false,
    message: "pounds are coming — this version logs kilograms"
  });
  assert.equal(spokenKg(80000), "80 kilos");
  assert.equal(spokenKg(82500), "82.5 kilos");
  assert.equal(spokenKg(5), "0.005 kilos");
});

test("validated sets auto-number per exercise and apply as one immutable audited write", () => {
  const heardUnknown = validateSet({
    exercise: "cable fly",
    weight_value: "20",
    unit: "kg",
    reps: 10,
    raw_answer: "cable fly twenty kilos ten reps"
  }, gymFixture(), "2026-08-09");
  assert.equal(heardUnknown.ok, false);
  assert.match(heardUnknown.message, /I heard "cable fly"/);

  const before = gymFixture({ revision: 3 });
  const first = validateSet({
    exercise: "flat bench",
    weight_value: "82.5",
    unit: "kg",
    reps: 8,
    raw_answer: "flat bench eighty-two and a half kilos eight reps"
  }, before, "2026-08-09");
  assert.deepEqual(first, {
    ok: true,
    set: {
      exerciseSlug: "bench-press",
      exerciseName: "Bench press",
      weightGrams: 82500,
      unit: "kg",
      reps: 8,
      setNumber: 1
    },
    workout: { date: "2026-08-09", sets: [] }
  });

  const after = applySet(before, first, "2026-08-09T10:15:00.000Z");
  assert.deepEqual(before, gymFixture({ revision: 3 }), "apply is non-mutating");
  assert.equal(after.revision, 4);
  assert.equal(after.updatedAt, "2026-08-09T10:15:00.000Z");
  assert.deepEqual(after.workouts, [{
    date: "2026-08-09",
    sets: [{
      exerciseSlug: "bench-press",
      exerciseName: "Bench press",
      weightGrams: 82500,
      unit: "kg",
      reps: 8,
      setNumber: 1,
      at: "2026-08-09T10:15:00.000Z"
    }]
  }]);
  assert.deepEqual(after.history, [{
    at: "2026-08-09T10:15:00.000Z",
    kind: "set",
    date: "2026-08-09",
    exerciseSlug: "bench-press",
    summary: "Logged Bench press, 82.5 kilos, 8 reps — set 1."
  }]);

  const second = validateSet({
    exercise: "bench press",
    weight_value: "82.5",
    unit: "kg",
    reps: 8,
    raw_answer: "bench press eighty-two and a half kilos eight reps"
  }, after, "2026-08-09");
  assert.equal(second.ok, true);
  assert.equal(second.set.setNumber, 2);

  const explicit = validateSet({
    exercise: "bench",
    weight_value: "80",
    unit: "kg",
    reps: 10,
    set_number: 7,
    raw_answer: "bench eighty kilos ten reps set seven"
  }, after, "2026-08-09");
  assert.equal(explicit.ok, true);
  assert.equal(explicit.set.setNumber, 7, "an explicit set number wins");
});

// llama-3.3-70b, told to write the weight as a digit string, wrote the reps as
// one too. An integer-only schema made the provider reject the whole call with
// HTTP 400 before any of this ran, and the user heard "I couldn't do that."
test("a set logs whether the model quotes its numbers or not", () => {
  const quoted = validateSet({
    exercise: "bench press",
    weight_value: "80",
    unit: "kg",
    reps: "8",
    set_number: "3",
    raw_answer: "bench press eighty kilos eight reps"
  }, gymFixture(), "2026-08-09");
  assert.equal(quoted.ok, true, quoted.message);
  assert.equal(quoted.set.reps, 8, "quoted reps are stored as a number");
  assert.equal(quoted.set.setNumber, 3, "a quoted set number is stored as a number");

  const plain = validateSet({
    exercise: "bench press",
    weight_value: "80",
    unit: "kg",
    reps: 8,
    set_number: 3,
    raw_answer: "bench press eighty kilos eight reps"
  }, gymFixture(), "2026-08-09");
  assert.deepEqual(quoted.set, plain.set, "both shapes produce the identical set");

  // Tolerating quotes must not tolerate nonsense: these stay spoken errors.
  for (const reps of ["eight", "8.5", "-8", "", " ", "0", "51", true, null]) {
    const bad = validateSet({
      exercise: "bench press",
      weight_value: "80",
      unit: "kg",
      reps,
      raw_answer: "bench press eighty kilos eight reps"
    }, gymFixture(), "2026-08-09");
    assert.equal(bad.ok, false, `reps ${JSON.stringify(reps)} must not log`);
    assert.match(bad.message, /whole number from 1 through 50/);
  }
});

test("progress reports the prior session, exact PR, and at most one bounded suggestion", () => {
  const log = gymFixture({
    workouts: [
      { date: "2026-07-20", sets: [storedSet("bench-press", 80000, 10)] },
      {
        date: "2026-08-05",
        sets: [
          storedSet("bench-press", 82500, 8, 1),
          storedSet("bench-press", 82500, 9, 2),
          storedSet("squat", 100000, 5, 1)
        ]
      },
      { date: "2026-08-09", sets: [storedSet("bench-press", 80000, 10)] }
    ],
    updatedAt: "2026-08-09T10:15:00.000Z"
  });
  assert.deepEqual(progress(log, "bench-press"), {
    lastSession: {
      date: "2026-08-05",
      sets: [
        { weightGrams: 82500, reps: 8 },
        { weightGrams: 82500, reps: 9 }
      ]
    },
    pr: { weightGrams: 82500, reps: 9, date: "2026-08-05" },
    suggestion: "Last time you did 9 reps at this weight — try 10 if form feels solid."
  });

  const atTwelve = gymFixture({
    workouts: [
      { date: "2026-08-05", sets: [storedSet("bench-press", 80000, 12)] }
    ],
    updatedAt: "2026-08-09T10:15:00.000Z"
  });
  assert.equal(progress(atTwelve, "bench-press").suggestion, null);

  const alreadyHeavierToday = gymFixture({
    workouts: [
      { date: "2026-08-05", sets: [storedSet("bench-press", 80000, 8)] },
      { date: "2026-08-09", sets: [storedSet("bench-press", 80500, 6)] }
    ],
    updatedAt: "2026-08-09T10:15:00.000Z"
  });
  assert.equal(progress(alreadyHeavierToday, "bench-press").suggestion, null);
});

test("consistency counts workouts in rolling seven-day buckets, newest first", () => {
  const workouts = ["2026-08-09", "2026-08-03", "2026-08-02", "2026-07-26", "2026-07-19", "2026-07-12"]
    .map((date) => ({ date, sets: [storedSet("squat", 60000, 8)] }));
  assert.deepEqual(consistency(gymFixture({ workouts }), "2026-08-09"), {
    workoutsPerWeek: [2, 1, 1, 1]
  });
});

test("template edits replace one entry, bump once, and refuse stale revisions", () => {
  const before = gymFixture({ revision: 2 });
  const after = applyTemplateEdit(before, {
    template_id: "starter-full-body",
    exercise: "squat",
    target_sets: 3,
    target_reps: 5,
    rest_seconds: 90,
    expected_revision: 2,
    raw_answer: "change squat from three by eight to three by five"
  }, "2026-08-09T11:00:00.000Z");

  assert.notEqual(after.ok, false);
  assert.deepEqual(before, gymFixture({ revision: 2 }), "template apply is non-mutating");
  assert.equal(after.revision, 3);
  assert.equal(after.updatedAt, "2026-08-09T11:00:00.000Z");
  assert.deepEqual(after.templates[0].exercises[0], {
    slug: "squat",
    targetSets: 3,
    targetReps: 5,
    restSeconds: 90
  });
  assert.deepEqual(after.history, [{
    at: "2026-08-09T11:00:00.000Z",
    kind: "template",
    templateId: "starter-full-body",
    exerciseSlug: "squat",
    summary: "Changed Starter full body squat targets from 3 by 8 to 3 by 5."
  }]);

  const replaced = applyTemplateEdit(before, {
    template_id: "starter-full-body",
    exercise: "barbell row",
    replacement_exercise: "pull-ups",
    expected_revision: 2,
    raw_answer: "replace barbell row with pull-ups"
  }, "2026-08-09T11:00:00.000Z");
  assert.notEqual(replaced.ok, false);
  assert.deepEqual(replaced.templates[0].exercises[2], {
    slug: "pull-up",
    targetSets: 3,
    targetReps: 8,
    restSeconds: 90
  });
  assert.equal(
    replaced.history[0].summary,
    "Changed Starter full body from Barbell row to Pull-up, targets from 3 by 8 to 3 by 8."
  );

  assert.deepEqual(applyTemplateEdit(after, {
    template_id: "starter-full-body",
    exercise: "squat",
    target_sets: 4,
    expected_revision: 2,
    raw_answer: "make squat four sets"
  }, "2026-08-09T11:01:00.000Z"), {
    ok: false,
    message: "The gym log changed before you confirmed, so nothing changed."
  });
});

test("log_set is repeat-back gated, one-shot, and bound to the prechecked revision", async () => {
  const skill = getSkill("log_set");
  assert.ok(skill, "log_set is registered");
  assert.equal(skill.requiresConfirmation, true);
  const ctx = memoryCtx();

  const unknown = await precheckSkill("log_set", {
    exercise: "cable fly",
    weight_value: "20",
    unit: "kg",
    reps: 10,
    raw_answer: "cable fly twenty kilos ten reps"
  }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /I heard "cable fly"/);
  assert.equal(ctx.writeCount, 0);

  const pounds = await precheckSkill("log_set", {
    exercise: "bench press",
    weight_value: "180",
    unit: "lb",
    reps: 8,
    raw_answer: "bench press one hundred eighty pounds eight reps"
  }, ctx);
  assert.deepEqual(pounds, {
    ok: false,
    summary: "pounds are coming — this version logs kilograms",
    content: "pounds are coming — this version logs kilograms"
  });

  const params = {
    exercise: "bench press",
    weight_value: "82.5",
    unit: "kg",
    reps: 8,
    raw_answer: "bench press eighty-two and a half kilos eight reps"
  };
  assert.equal((await precheckSkill("log_set", params, ctx)).ok, true);
  assert.equal(ctx.writeCount, 0, "precheck never writes");
  assert.equal(
    confirmPromptFor("log_set", params),
    "Bench press, 82.5 kilos, 8 reps — set 1 today. Save it?"
  );

  const recorded = await skill.execute(params, ctx);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.summary, "Recorded Bench press, 82.5 kilos, 8 reps — set 1.");
  assert.equal(recorded.gymLog.revision, 1);
  assert.equal(ctx.writeCount, 1);

  const replay = await skill.execute(params, ctx);
  assert.equal(replay.ok, false, "one confirmation cannot be replayed");
  assert.equal(ctx.writeCount, 1);

  const unconfirmed = await skill.execute({ ...params }, ctx);
  assert.equal(unconfirmed.ok, false, "execution without a live precheck snapshot is refused");
  assert.equal(ctx.writeCount, 1);

  const staleParams = { ...params, reps: 9, raw_answer: "bench press eighty-two point five for nine" };
  assert.equal((await precheckSkill("log_set", staleParams, ctx)).ok, true);
  const changed = clone(ctx.files.get("gym-log.json"));
  changed.revision += 1;
  ctx.files.set("gym-log.json", changed);
  const stale = await skill.execute(staleParams, ctx);
  assert.equal(stale.ok, false);
  assert.equal(stale.summary, "The gym log changed before you confirmed, so nothing changed.");
  assert.equal(ctx.writeCount, 1);

});

test("gym_status is a read-only code template with one suggestion at most", async () => {
  const skill = getSkill("gym_status");
  assert.ok(skill, "gym_status is registered");
  assert.equal(skill.requiresConfirmation, false);

  const emptyCtx = memoryCtx();
  const empty = await skill.execute({}, emptyCtx);
  assert.equal(
    empty.summary,
    "No sets are logged today. This week: 0 workouts. No PRs are logged yet."
  );
  assert.equal(emptyCtx.writeCount, 0);

  const log = gymFixture({
    revision: 3,
    workouts: [
      {
        date: "2026-08-05",
        sets: [
          storedSet("bench-press", 82500, 8, 1),
          storedSet("bench-press", 82500, 9, 2)
        ]
      },
      { date: "2026-08-09", sets: [storedSet("bench-press", 80000, 10)] }
    ],
    updatedAt: "2026-08-09T07:45:00.000Z"
  });
  const ctx = memoryCtx({ "gym-log.json": log });
  const exercise = await skill.execute({ exercise: "bench" }, ctx);
  assert.equal(
    exercise.summary,
    "Last Bench press session on 2026-08-05: 82.5 kilos for 8 reps; " +
      "82.5 kilos for 9 reps. Bench press PR: 82.5 kilos for 9 reps on 2026-08-05. " +
      "Last time you did 9 reps at this weight — try 10 if form feels solid."
  );
  assert.equal(
    (exercise.summary.match(/try /g) || []).length,
    1,
    "status has no more than one suggestion"
  );
  assert.match(exercise.content, /Read this code-built gym status exactly/);

  const overall = await skill.execute({}, ctx);
  assert.equal(
    overall.summary,
    "Today: Bench press, 80 kilos for 10 reps — set 1. This week: 2 workouts. " +
      "Most recent PR: Bench press, 82.5 kilos for 9 reps on 2026-08-05."
  );
  assert.equal(ctx.writeCount, 0);
});

test("update_template repeats old to new and refuses a stale confirmed snapshot", async () => {
  const skill = getSkill("update_template");
  assert.ok(skill, "update_template is registered");
  assert.equal(skill.requiresConfirmation, true);
  const ctx = memoryCtx();
  const params = {
    template_id: "starter-full-body",
    exercise: "squat",
    target_sets: 3,
    target_reps: 5,
    raw_answer: "change squat targets from three by eight to three by five"
  };

  assert.equal((await precheckSkill("update_template", params, ctx)).ok, true);
  assert.equal(ctx.writeCount, 0);
  assert.equal(
    confirmPromptFor("update_template", params),
    "Change squat targets from three by eight to three by five?"
  );
  const changed = await skill.execute(params, ctx);
  assert.equal(changed.ok, true);
  assert.equal(changed.summary, "Changed squat targets from 3 by 8 to 3 by 5.");
  assert.equal(changed.gymLog.revision, 1);
  assert.equal(ctx.writeCount, 1);

  assert.equal((await skill.execute(params, ctx)).ok, false, "confirmation is one-shot");
  const staleParams = {
    ...params,
    target_reps: 6,
    raw_answer: "make the squat target three by six"
  };
  assert.equal((await precheckSkill("update_template", staleParams, ctx)).ok, true);
  const stored = clone(ctx.files.get("gym-log.json"));
  stored.revision += 1;
  ctx.files.set("gym-log.json", stored);
  const stale = await skill.execute(staleParams, ctx);
  assert.equal(stale.ok, false);
  assert.equal(stale.summary, "The gym log changed before you confirmed, so nothing changed.");
  assert.equal(ctx.writeCount, 1);

  const replacementCtx = memoryCtx();
  const replacementParams = {
    template_id: "starter-full-body",
    exercise: "barbell row",
    replacement_exercise: "pull-ups",
    raw_answer: "replace barbell row with pull-ups"
  };
  assert.equal(
    (await precheckSkill("update_template", replacementParams, replacementCtx)).ok,
    true
  );
  assert.equal(
    confirmPromptFor("update_template", replacementParams),
    "Change barbell row to pull-up, with targets from three by eight to three by eight?"
  );
  const replacement = await skill.execute(replacementParams, replacementCtx);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.gymLog.templates[0].exercises[2].slug, "pull-up");
  assert.equal(replacementCtx.writeCount, 1);
});

test("gym phrases route to one exact tool without catching safety conversations", () => {
  const expected = [
    ["bench press eighty kilos eight reps", "log_set"],
    ["log a set", "log_set"],
    ["log bench press eighty kilos eight reps", "log_set"],
    ["how much did I bench", "gym_status"],
    ["what did I bench", "gym_status"],
    ["gym status", "gym_status"],
    ["am I getting stronger", "gym_status"],
    ["Change squat targets from three by eight to three by five?", "update_template"],
    ["replace barbell row with pull-ups in my workout template", "update_template"]
  ];
  for (const [phrase, tool] of expected) {
    const intent = classifyIntent(phrase, {});
    assert.equal(intent.intent, "executable_action", phrase);
    assert.equal(intent.family, "gym", phrase);
    assert.deepEqual(intent.expected, [tool], phrase);
  }

  for (const phrase of [
    "my chest hurts when I bench, what should I lift instead?",
    "I skipped the gym all week, I'm so lazy and pathetic",
    "what supplement should I take to fix my shoulder pain?"
  ]) {
    assert.equal(classifyIntent(phrase, {}).intent, "chat", phrase);
  }

  // gym_session is direct-dispatch-only and must stay OUT of provider defs;
  // finish_workout is a normal confirm-gated tool and must appear.
  assert.deepEqual(
    toolDefsForFamily({}, "gym").map((definition) => definition.function.name),
    ["log_set", "gym_status", "update_template", "finish_workout"]
  );
  assert.deepEqual(
    {
      family: toolByName("log_set", {}).family,
      effect: toolByName("log_set", {}).effect,
      confirm: toolByName("log_set", {}).confirm
    },
    { family: "gym", effect: "mutation", confirm: "always" }
  );
  assert.equal(needsConfirmation("log_set", {}, {}), true);
  assert.equal(needsConfirmation("update_template", {}, {}), true);
  assert.equal(needsConfirmation("gym_status", {}, {}), false);
  assert.equal(validateToolCall("log_set", {
    exercise: "bench press",
    weight_value: "180",
    unit: "lb",
    reps: 8,
    raw_answer: "bench press one hundred eighty pounds eight reps"
  }, {}).ok, true, "semantic precheck owns the exact pound refusal");
});

// ---- Stage 2: live session model -------------------------------------------

const {
  addExtraSet,
  advanceExercise,
  finishSession,
  noteSetLogged,
  sessionState,
  startSession
} = await import("../gymLog.js");

const T0 = "2026-08-10T17:00:00.000Z";
const at = (minutes, seconds = 0) =>
  new Date(Date.parse(T0) + (minutes * 60 + seconds) * 1000).toISOString();

function loggedSet(slug, setNumber, iso) {
  return {
    exerciseSlug: slug, weightGrams: 80000, unit: "kg",
    reps: 8, setNumber, at: iso
  };
}

test("a session starts once, survives normalize, and refuses a double start", () => {
  const started = startSession(gymFixture(), undefined, T0);
  assert.equal(started.ok, undefined, "start returns the log, not a failure");
  assert.equal(started.session.templateId, STARTER_TEMPLATE.id);
  const roundTrip = normalizeGymLog(JSON.parse(JSON.stringify(started)));
  assert.equal(roundTrip.session.exerciseIndex, 0, "session survives storage round-trip");
  const again = startSession(roundTrip, undefined, at(1));
  assert.equal(again.ok, false);
  assert.match(again.message, /already running/);
  const unknown = startSession(gymFixture(), "no-such-template", T0);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /could not find/);
});

test("sessionState reports exercise, targets, rest, and done honestly", () => {
  let log = startSession(gymFixture(), undefined, T0);
  const fresh = sessionState(log, at(0, 30));
  assert.equal(fresh.exercise.slug, "squat");
  assert.equal(fresh.exercise.targetSets, 3);
  assert.equal(fresh.restRemainingSeconds, null, "no rest before any set");
  assert.equal(fresh.upNext.slug, "bench-press");
  assert.equal(fresh.done, false);
  assert.equal(sessionState(gymFixture(), T0), null, "no session, no state");
});

test("logging sets starts rest windows and auto-advances after targets, never after extras", () => {
  let log = startSession(gymFixture(), undefined, T0);
  const today = T0.slice(0, 10);
  for (let n = 1; n <= 2; n++) {
    log.workouts = [{ date: today, sets: [...(log.workouts[0]?.sets || []), loggedSet("squat", n, at(n))] }];
    log = noteSetLogged(log, "squat", at(n));
    assert.equal(log.session.exerciseIndex, 0, `still on squat after set ${n}`);
  }
  const midRest = sessionState(log, at(2, 30));
  assert.equal(midRest.restRemainingSeconds, 60, "90s rest window, 30s elapsed");

  log = addExtraSet(log);
  assert.equal(log.session.extraTargets["squat"], 1);
  log.workouts[0].sets.push(loggedSet("squat", 3, at(3)));
  log = noteSetLogged(log, "squat", at(3));
  assert.equal(log.session.exerciseIndex, 0, "extra set keeps squat open at 3/4");
  log.workouts[0].sets.push(loggedSet("squat", 4, at(4)));
  log = noteSetLogged(log, "squat", at(4));
  assert.equal(log.session.exerciseIndex, 1, "advances after target+extra reached");

  const offPlan = noteSetLogged(log, "deadlift", at(5));
  assert.equal(offPlan.session.exerciseIndex, 1, "off-plan sets never move the session");
});

test("skip, last-exercise refusal, and the confirmed finish summary are exact", () => {
  let log = startSession(gymFixture(), undefined, T0);
  for (let i = 0; i < STARTER_TEMPLATE.exercises.length - 1; i++) {
    log = advanceExercise(log, { skip: true });
  }
  assert.equal(sessionState(log, at(1)).exercise.slug, "deadlift");
  log = advanceExercise(log, {});
  assert.equal(sessionState(log, at(1)).done, true);
  const tooFar = advanceExercise(log, {});
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.message, /finish workout/);

  const today = T0.slice(0, 10);
  log.workouts = [{
    date: today,
    sets: [loggedSet("squat", 1, at(1)), loggedSet("squat", 2, at(2)), loggedSet("bench-press", 1, at(3))]
  }];
  const finished = finishSession(log, at(41, 30));
  assert.deepEqual(finished.summary, { exercises: 2, sets: 3, minutes: 41 });
  assert.equal(finished.log.session, undefined, "session cleared");
  assert.equal(finished.log.workouts[0].finishedAt, at(41, 30));
  const roundTrip = normalizeGymLog(JSON.parse(JSON.stringify(finished.log)));
  assert.equal(roundTrip.workouts[0].finishedAt, at(41, 30), "finishedAt survives storage");
  const noSession = finishSession(gymFixture(), T0);
  assert.equal(noSession.ok, false);
  assert.match(noSession.message, /no workout running/);
});

const { gymSessionActionForText } = await import("../toolRegistry.js");

test("session verbs derive code-owned actions and route as direct-dispatch gym_session", () => {
  for (const [phrase, action] of [
    ["start my workout", "start"],
    ["let's train", "start"],
    ["next exercise", "next"],
    ["skip this one", "skip"],
    ["add another set", "add_set"],
    ["how long left", "status"],
    ["where are we", "status"]
  ]) {
    assert.equal(gymSessionActionForText(phrase), action, phrase);
    const intent = classifyIntent(phrase, {});
    assert.deepEqual(intent.expected, ["gym_session"], phrase);
    assert.equal(intent.gymSessionAction, action, phrase);
  }
  assert.equal(gymSessionActionForText("skip it"), null, "bare 'skip it' stays conversational");
  assert.deepEqual(classifyIntent("finish the workout", {}).expected, ["finish_workout"]);
  assert.equal(classifyIntent("I skipped dessert", {}).intent, "chat");
});

test("gym_session speaks positions, refuses without a session, and finish confirms with counts", async () => {
  const files = new Map();
  const clock = { value: Date.parse("2026-08-10T17:00:00.000Z") };
  const ctx = {
    readJson: async (name, fallback) => files.has(name) ? structuredClone(files.get(name)) : fallback,
    writeJson: async (name, value) => { files.set(name, structuredClone(value)); },
    appendAction: async () => {},
    now: () => new Date(clock.value)
  };
  const session = getSkill("gym_session");

  const noSession = await session.execute({ action: "status" }, ctx);
  assert.equal(noSession.ok, false);
  assert.match(noSession.summary, /no workout running — say start workout/);

  const started = await session.execute({ action: "start" }, ctx);
  assert.equal(started.ok, true);
  assert.match(started.summary, /Workout started — Squat, set 1 of 3, 8 reps/);

  // A confirmed log_set drives the session: rest window + counts move.
  const logSet = getSkill("log_set");
  const params = {
    exercise: "squat", weight_value: "80", unit: "kg", reps: 8,
    raw_answer: "squat eighty kilos eight reps"
  };
  await precheckSkill("log_set", params, ctx);
  const saved = await logSet.execute(params, ctx);
  assert.equal(saved.ok, true);
  clock.value += 30 * 1000;
  const resting = await session.execute({ action: "status" }, ctx);
  assert.match(resting.summary, /60 seconds of rest left, then squat set 2\./);

  const extra = await session.execute({ action: "add_set" }, ctx);
  assert.match(extra.summary, /One more squat set — 4 total now\./);

  const skipped = await session.execute({ action: "skip" }, ctx);
  assert.match(skipped.summary, /Next: Bench press, set 1 of 3/);

  const finish = getSkill("finish_workout");
  const finishParams = { raw_answer: "finish workout" };
  clock.value += 40 * 60 * 1000;
  const pre = await precheckSkill("finish_workout", finishParams, ctx);
  assert.equal(pre.ok, true);
  assert.match(
    confirmPromptFor("finish_workout", finishParams),
    /Finish workout — 1 exercise, 1 set, 40 minutes\?/
  );
  const done = await finish.execute(finishParams, ctx);
  assert.equal(done.ok, true);
  assert.match(done.summary, /Workout finished — 1 exercise, 1 set in 40 minutes/);
  assert.equal(files.get("gym-log.json").session, undefined, "session cleared after finish");

  const statusAfter = await session.execute({ action: "status" }, ctx);
  assert.equal(statusAfter.ok, false, "no session after finishing");
});
