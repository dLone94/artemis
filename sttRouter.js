// THE speech-to-text routing decision — one place, one authority.
//
// Before this existed the only STT path was Deepgram, so "can she hear me?"
// silently meant "is the internet up?". This module answers a different
// question: given the operating mode the user chose, which provider is even
// ALLOWED to see this audio — and it answers it once, for every caller.
//
// Policy (hard, not advisory):
//   local-only / offline  → LOCAL ONLY. The cloud provider is never attempted,
//                           never retried, never fallen back to. A failure is
//                           reported as a failure.
//   hybrid                → cloud preferred when configured and healthy,
//                           LOCAL as the fallback (missing key, network error,
//                           timeout, provider outage).
//
// It is pure: no I/O, no fetch, no spawn. It takes the facts and returns a
// decision, so the contract is unit-testable (test/sttRouter.test.mjs) and no
// `if (offline)` has to be repeated across the voice files.

/** Provider ids. `null` means "nothing may run" and the caller must say so. */
export const STT_LOCAL = "local";
export const STT_CLOUD = "deepgram";

/**
 * @param {object} facts
 * @param {boolean} facts.offline        the one authoritative mode flag (networkPolicy.isOffline)
 * @param {boolean} facts.cloudConfigured a cloud key exists
 * @param {boolean} facts.localReady      the local engine + model are installed
 * @param {boolean} [facts.cloudHealthy]  false after a recent cloud failure
 * @returns {{provider: string|null, fallback: string|null, reason: string, cloudForbidden: boolean}}
 */
export function chooseSttProvider(facts = {}) {
  const offline = !!facts.offline;
  const cloudConfigured = !!facts.cloudConfigured;
  const localReady = !!facts.localReady;
  const cloudHealthy = facts.cloudHealthy !== false;

  if (offline) {
    // The user asked for local-only. Cloud is not a fallback here — it is
    // forbidden, and saying so plainly is better than a silent downgrade.
    return localReady
      ? { provider: STT_LOCAL, fallback: null, reason: "local-only mode", cloudForbidden: true }
      : {
          provider: null,
          fallback: null,
          reason: "local-only mode, but the local speech model isn't installed",
          cloudForbidden: true
        };
  }

  if (cloudConfigured && cloudHealthy) {
    return {
      provider: STT_CLOUD,
      fallback: localReady ? STT_LOCAL : null,
      reason: localReady ? "hybrid: cloud first, local standby" : "hybrid: cloud only (no local model)",
      cloudForbidden: false
    };
  }

  if (localReady) {
    return {
      provider: STT_LOCAL,
      fallback: null,
      reason: cloudConfigured ? "cloud unhealthy — using local" : "no cloud key — using local",
      cloudForbidden: false
    };
  }

  return {
    provider: null,
    fallback: null,
    reason: cloudConfigured ? "cloud unavailable and no local model" : "no speech provider configured",
    cloudForbidden: false
  };
}

/** One honest sentence for the user when nothing can transcribe. */
export function sttUnavailableMessage(decision) {
  if (!decision || decision.provider) return "";
  return decision.cloudForbidden
    ? "I can't transcribe offline yet — the local speech model isn't installed. Run the local speech setup, or turn local-only mode off."
    : "I don't have a working speech provider right now. Add a Deepgram key, or install the local speech model.";
}

/** The line for a local transcription that ran but produced nothing usable. */
export function localFailureMessage(offline) {
  return offline
    ? "I couldn't transcribe that locally. Try again."
    : "I couldn't transcribe that. Try again.";
}

/**
 * Cloud failure handling in HYBRID only. Returns the next provider to try, or
 * null. In local-only this must never be reached — the cloud was not called.
 */
export function afterCloudFailure(decision) {
  if (!decision || decision.cloudForbidden) return null;
  return decision.fallback || null;
}
