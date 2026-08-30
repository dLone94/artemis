// Adaptive speech front end: hear the USER better, not the room louder.
//
// The two measured defects this replaces:
//
//   1. VAD had an ABSOLUTE floor — `max(noiseFloor * 3.5, 0.010)`. A whisper,
//      or normal speech from ~2 m, lands around RMS 0.003–0.008, i.e. BELOW
//      that floor. In a quiet room the speech was well above the noise and
//      still ignored, because the constant outranked the environment. Quiet
//      speech could not be detected at all, at any distance.
//   2. Nothing normalised level before whisper.cpp, so a faint utterance was
//      handed to the recogniser as a faint utterance.
//
// Everything here is pure and frame-at-a-time: no DOM, no audio API, no
// allocation per frame beyond the caller's own buffer. That keeps it cheap
// enough to run continuously while wake is armed, and unit-testable without a
// microphone (test/audioFrontEnd.test.mjs).
//
// PRIVACY: this is arithmetic on samples that never leave the process. No
// audio is retained, logged, or sent anywhere — in any mode.

/** Capture profiles. Same pipeline, different operating points. */
export const PROFILES = Object.freeze({
  NORMAL: {
    name: "NORMAL",
    // speech must exceed the floor by this ratio to count
    speechRatio: 3.5,
    // an absolute floor exists ONLY as a denoising safety net; it is far below
    // the old 0.010 so a genuine whisper in a quiet room still qualifies
    minSpeech: 0.0020,
    maxGain: 4,
    targetRms: 0.06,
    silenceMs: 550,
    preRollMs: 1200,
    wakeBias: 0            // added to the profile's wake threshold
  },
  FAR_FIELD: {
    name: "FAR_FIELD",
    speechRatio: 2.6,      // distant speech sits closer to the noise
    minSpeech: 0.0015,
    maxGain: 10,           // more headroom, still bounded
    targetRms: 0.08,
    silenceMs: 750,        // reflections smear the tail; don't cut it early
    preRollMs: 1500,
    wakeBias: -0.04        // slightly more sensitive, never wide open
  },
  WHISPER: {
    name: "WHISPER",
    speechRatio: 2.2,      // whispers are quiet but usually CLOSE and clean
    minSpeech: 0.0010,
    maxGain: 14,
    targetRms: 0.07,
    silenceMs: 900,        // unvoiced speech has long quiet stretches inside it
    preRollMs: 1600,
    wakeBias: -0.06
  }
});

export const DEFAULT_PROFILE = "NORMAL";

/** RMS of a frame. */
export function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}

/** Peak magnitude — the clipping guard reads this, not the average. */
export function peak(frame) {
  let p = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] < 0 ? -frame[i] : frame[i];
    if (v > p) p = v;
  }
  return p;
}

/**
 * Noise-floor estimator.
 *
 * Asymmetric on purpose: it drops toward a quieter room quickly, and rises
 * only slowly. A door slam or a cough is loud and brief — letting that move
 * the floor upward at speed would raise the speech threshold and deafen
 * Artemis for the next few seconds, which is precisely the failure we are
 * fixing. Speech itself is excluded from the estimate by the `speechLikely`
 * gate the caller passes in.
 */
export function createNoiseFloor({ initial = 0.004, floor = 0.0004, ceiling = 0.15 } = {}) {
  let value = initial;
  return {
    get value() { return value; },
    /** @param {number} frameRms @param {boolean} speechLikely */
    update(frameRms, speechLikely) {
      if (speechLikely) return value;            // never learn the room from speech
      // Down fast (0.30), up slow (0.02). The upward input is ALSO clamped to
      // 2x the current floor: without that, one 0.5-RMS door slam dragged the
      // estimate up 6x in a single frame, which raises the speech threshold
      // and deafens Artemis for seconds — the exact failure being fixed.
      const rising = frameRms >= value;
      const observed = rising ? Math.min(frameRms, value * 2) : frameRms;
      const alpha = rising ? 0.02 : 0.30;
      value = value * (1 - alpha) + observed * alpha;
      value = Math.min(ceiling, Math.max(floor, value));
      return value;
    },
    reset(v = initial) { value = v; }
  };
}

/** Rough SNR in dB from a speech level and the current floor. */
export function snrDb(speechRms, noiseRms) {
  const n = Math.max(1e-6, noiseRms);
  const s = Math.max(1e-6, speechRms);
  return 20 * Math.log10(s / n);
}

/**
 * Adaptive gain.
 *
 * Level-targeting rather than "turn it up": it aims the SPEECH level at the
 * profile's target, is bounded by maxGain, backs off hard the moment peaks
 * approach full scale, and moves with attack/release smoothing so the bed of
 * room noise between words does not pump. Gain is only ever raised while
 * speech is present — amplifying silence just amplifies the room.
 */
export function createAdaptiveGain(profile = PROFILES.NORMAL) {
  let gain = 1;
  let p = profile;
  return {
    get gain() { return gain; },
    setProfile(next) { p = next || p; },
    reset() { gain = 1; },
    /**
     * @param {number} speechRms level of the current frame
     * @param {number} framePeak peak of the current frame (post-gain safety)
     * @param {boolean} speechLikely only chase the target during speech
     */
    update(speechRms, framePeak, speechLikely) {
      const wanted = speechLikely && speechRms > 1e-5
        ? Math.min(p.maxGain, p.targetRms / speechRms)
        : gain;                                    // hold during silence
      // Clipping guard: if applying the current gain would push peaks past
      // ~0.95 full scale, pull back immediately. Distortion costs far more
      // recognition accuracy than a few dB of level ever buys.
      const safeCeiling = framePeak > 1e-6 ? 0.95 / framePeak : p.maxGain;
      const target = Math.max(1, Math.min(wanted, safeCeiling, p.maxGain));
      // fast down (protect against clipping), slow up (no pumping)
      const alpha = target < gain ? 0.5 : 0.08;
      gain = gain * (1 - alpha) + target * alpha;
      gain = Math.max(1, Math.min(p.maxGain, gain));
      return gain;
    }
  };
}

/** Apply gain in place with a soft ceiling; returns the peak after gain. */
export function applyGain(frame, gain) {
  let p = 0;
  for (let i = 0; i < frame.length; i += 1) {
    let v = frame[i] * gain;
    if (v > 0.98) v = 0.98;
    else if (v < -0.98) v = -0.98;
    frame[i] = v;
    const a = v < 0 ? -v : v;
    if (a > p) p = a;
  }
  return p;
}

/**
 * One-pole DC/rumble high-pass (~80 Hz at 16 kHz).
 *
 * Deliberately gentle. Whisper.cpp does best on natural audio; the only thing
 * removed here is the sub-speech rumble (desk thumps, fan, handling noise)
 * that inflates RMS and therefore corrupts both the noise floor and the VAD.
 */
export function createHighPass(cutoffHz = 80, sampleRate = 16000) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = rc / (rc + dt);
  let prevIn = 0;
  let prevOut = 0;
  return {
    process(frame) {
      for (let i = 0; i < frame.length; i += 1) {
        const x = frame[i];
        const y = a * (prevOut + x - prevIn);
        prevIn = x;
        prevOut = y;
        frame[i] = y;
      }
      return frame;
    },
    reset() { prevIn = 0; prevOut = 0; }
  };
}

/**
 * The front end. One instance per capture pipeline.
 *
 * Call `process(frame)` per audio frame; it returns the analysis the wake
 * detector and the endpointer both need, having already high-passed and
 * (optionally) gained the frame IN PLACE.
 */
export function createAudioFrontEnd(opts = {}) {
  const sampleRate = opts.sampleRate || 16000;
  let profileName = opts.profile || DEFAULT_PROFILE;
  let profile = PROFILES[profileName] || PROFILES.NORMAL;
  let override = null;                       // manual profile pin, or null for AUTO

  const noise = createNoiseFloor({ initial: opts.initialNoiseFloor });
  const agc = createAdaptiveGain(profile);
  const hp = createHighPass(80, sampleRate);
  const applyGainToAudio = opts.applyGain !== false;

  // AUTO selection state. Hysteresis is a frame COUNT, not a timer, so the
  // behaviour is deterministic in tests and independent of wall-clock jitter.
  let candidate = profileName;
  let candidateFrames = 0;
  // Two agreeing utterances before the mode changes. Measured: classifying
  // per FRAME could not work — early in an utterance the floor is still
  // settling and the verdict oscillates. Per utterance it is stable, and two
  // in a row means one unusual sentence never moves the mode.
  const utteranceHysteresis = opts.switchAfterUtterances || 2;
  let speechFrames = 0;
  let lastSpeechRms = 0;

  function classify(speechRms, floor) {
    const snr = snrDb(speechRms, floor);
    // Distant speech: weak AND close to the noise — the room is the problem.
    if (speechRms < 0.030 && snr < 16) return "FAR_FIELD";
    // Whisper: weak but CLEAN — quiet voice near a quiet mic.
    if (speechRms < 0.030) return "WHISPER";
    return "NORMAL";
  }

  return {
    get profile() { return profile; },
    get profileName() { return profile.name; },
    get overridden() { return override !== null; },
    get noiseFloor() { return noise.value; },
    get gain() { return agc.gain; },

    /** Pin a profile ("NORMAL"|"FAR_FIELD"|"WHISPER"), or null to resume AUTO. */
    setOverride(name) {
      if (name === null || name === undefined) {
        override = null;
        return { profile: profile.name, auto: true };
      }
      const next = PROFILES[String(name).toUpperCase()];
      if (!next) return { profile: profile.name, auto: override === null, error: "unknown-profile" };
      override = next.name;
      profile = next;
      agc.setProfile(profile);
      return { profile: profile.name, auto: false };
    },

    /**
     * @param {Float32Array} frame modified in place (high-pass, then gain)
     * @returns {{rms, peak, noiseFloor, snrDb, speech, gain, profile, clipping}}
     */
    process(frame) {
      hp.process(frame);
      const raw = rms(frame);
      const rawPeak = peak(frame);

      // Speech decision is RELATIVE to the room. The absolute term is only a
      // denoising safety net, and it is far below the old 0.010 constant that
      // made quiet speech undetectable in principle.
      const threshold = Math.max(noise.value * profile.speechRatio, profile.minSpeech);
      const speech = raw > threshold;

      noise.update(raw, speech);
      if (speech) { speechFrames += 1; lastSpeechRms = raw; }

      const gain = agc.update(raw, rawPeak, speech);
      const outPeak = applyGainToAudio && gain > 1.0001 ? applyGain(frame, gain) : rawPeak;

      // NOTE: profile selection deliberately does NOT happen here. Measured:
      // during the first frames of an utterance the noise floor is still
      // settling, so the SNR estimate swings and the classifier alternates
      // between FAR_FIELD and WHISPER, resetting its own hysteresis and never
      // committing. Classification happens once per utterance instead — see
      // observeUtterance() — which is stable and cannot flap mid-sentence.

      return {
        rms: raw,
        peak: outPeak,
        noiseFloor: noise.value,
        snrDb: snrDb(Math.max(raw, lastSpeechRms), noise.value),
        speech,
        gain,
        profile: profile.name,
        clipping: outPeak >= 0.979
      };
    },

    /**
     * Classify the environment from a COMPLETED utterance and pick the profile
     * for the NEXT one. Stable by construction: one decision per utterance,
     * made when the noise floor has settled, and it still needs `switchAfter`
     * consecutive agreeing utterances before it commits — so one odd sentence
     * cannot move Artemis into a different listening mode.
     *
     * @param {{rms:number, noiseFloor?:number}} utterance
     */
    observeUtterance(utterance = {}) {
      if (override !== null) return profile.name;      // a manual pin wins
      const level = Number(utterance.rms) || lastSpeechRms;
      if (!level) return profile.name;
      const floor = Number(utterance.noiseFloor) || noise.value;
      const want = classify(level, floor);
      if (want === candidate) candidateFrames += 1;
      else { candidate = want; candidateFrames = 1; }
      if (candidateFrames >= utteranceHysteresis && want !== profile.name) {
        profile = PROFILES[want];
        agc.setProfile(profile);
        candidateFrames = 0;
      }
      return profile.name;
    },

    /** Metadata only — never audio. Safe to log, rate-limited by the caller. */
    diagnostics() {
      return {
        profile: profile.name,
        auto: override === null,
        noiseFloor: Number(noise.value.toFixed(5)),
        gain: Number(agc.gain.toFixed(2)),
        speechFrames,
        snrDb: Number(snrDb(lastSpeechRms, noise.value).toFixed(1))
      };
    },

    reset() {
      noise.reset();
      agc.reset();
      hp.reset();
      speechFrames = 0;
      candidateFrames = 0;
      lastSpeechRms = 0;
    }
  };
}
