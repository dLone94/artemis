// Background-music levels — ONE definition, shared by every page that plays
// the bed (the cockpit's engine and the brain/about continuity module).
//
// The bed exists to be atmosphere, not a duet partner. It used to sit at 0.42,
// which is loud enough that her first syllable had to fight it, so the fix is
// not only "duck harder" — the resting level itself comes down. These are
// ABSOLUTE gains (0..1 on HTMLAudioElement.volume), not fractions of a louder
// number, so reading the constant tells you exactly what you will hear.
//
// Pure and DOM-free so the mapping is unit-testable (test/musicDuck.test.mjs).

/** Resting level: present, but never competing with speech. */
export const BACKGROUND_MUSIC_GAIN = 0.18;

/** While Artemis speaks. Her voice must be unambiguously dominant. */
export const BACKGROUND_MUSIC_DUCK_GAIN = 0.04;

/**
 * While she is ACTIVELY CAPTURING a command — i.e. after the wake word fired,
 * not merely while armed. That distinction is the whole trick: "listening" is
 * the RESTING state whenever the wake word is armed, so ducking on it would
 * pin the bed quiet forever. The capture state is the real, bounded moment
 * that deserves acoustic space.
 */
export const BACKGROUND_MUSIC_LISTEN_GAIN = 0.09;

/** Ramp shapes: duck fast so the first syllable is already clear… */
export const DUCK_ATTACK_MS = 180;
/** …and return slowly so the bed never pumps between sentences. */
export const DUCK_RELEASE_MS = 700;
/** The capture duck is subtler and quicker than the speech duck. */
export const LISTEN_ATTACK_MS = 140;

/**
 * The target gain for a voice state.
 *
 * ONLY "speaking" ducks. "listening" is the RESTING state whenever the wake
 * word is armed — the orb parks there between turns — so ducking it as well
 * would pin the bed at the quiet level permanently and the duck would never be
 * audible as a change. That is a real finding from this codebase, not caution.
 */
export function musicGainFor(state) {
  if (state === "speaking") return BACKGROUND_MUSIC_DUCK_GAIN;
  if (state === "capturing") return BACKGROUND_MUSIC_LISTEN_GAIN;
  return BACKGROUND_MUSIC_GAIN;
}

/** How long the ramp to `state` should take. */
export function musicRampMs(state) {
  if (state === "speaking") return DUCK_ATTACK_MS;
  if (state === "capturing") return LISTEN_ATTACK_MS;
  return DUCK_RELEASE_MS;
}

/** Fade the bed to silence on shutdown — never a hard cut. */
export const SHUTDOWN_FADE_MS = 400;
