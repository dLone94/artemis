const DEFAULT_VOICEBOX_URL = "http://127.0.0.1:17493";

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_VOICEBOX_URL));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Voicebox URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchWithin(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Voicebox request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  const upstream = init && init.signal;
  const signal = upstream ? AbortSignal.any([controller.signal, upstream]) : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readWithin(response, method, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      response[method](),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { response.body?.cancel(); } catch (error) {}
          reject(new Error(`Voicebox response body timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function latestStatus(payload) {
  let latest = null;
  for (const line of String(payload || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { latest = JSON.parse(line.slice(5).trim()); } catch (error) {}
  }
  return latest;
}

async function terminalStatusWithin(response, timeoutMs) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return latestStatus(await readWithin(response, "text", timeoutMs));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest = null;
  const consume = async () => {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        try { latest = JSON.parse(line.slice(5).trim()); } catch (error) { continue; }
        if (["completed", "failed", "cancelled", "canceled"].includes(latest?.status)) {
          try { await reader.cancel(); } catch (error) {}
          return latest;
        }
      }
      if (done) return latest;
    }
  };
  let timer;
  try {
    return await Promise.race([
      consume(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { void reader.cancel().catch(() => {}); } catch (error) {}
          reject(new Error(`Voicebox response body timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function usableClone(profile) {
  return Boolean(
    profile &&
    profile.voice_type === "cloned" &&
    Number(profile.sample_count || 0) > 0
  );
}

export function chooseVoiceboxProfile(profiles, requested = "") {
  const clones = Array.isArray(profiles) ? profiles.filter(usableClone) : [];
  const wanted = String(requested || "").trim().toLowerCase();
  if (wanted) {
    return clones.find((profile) =>
      String(profile.id || "").toLowerCase() === wanted ||
      String(profile.name || "").toLowerCase() === wanted
    ) || null;
  }
  const preferred = clones.find((profile) =>
    /^(artemis|jarvis)$/i.test(String(profile.name || "").trim())
  );
  if (preferred) return preferred;
  return clones.length === 1 ? clones[0] : null;
}

export function createVoiceboxTtsProvider(options = {}) {
  const enabled = options.enabled !== false;
  let baseUrl = String(options.baseUrl || DEFAULT_VOICEBOX_URL);
  let configurationError = "";
  try {
    baseUrl = normalizeBaseUrl(baseUrl);
  } catch (cause) {
    configurationError = `Invalid Voicebox URL: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const configuredProfile = String(options.profile || "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestTimeoutMs = Number(options.requestTimeoutMs) || 5_000;
  const generationTimeoutMs = Number(options.generationTimeoutMs) || 120_000;
  const preloadTimeoutMs = Number(options.preloadTimeoutMs) || 120_000;
  const retryDelayMs = Number(options.retryDelayMs) || 15_000;
  let profile = null;
  let available = false;
  let modelLoaded = false;
  let modelDownloaded = false;
  let modelSize = "";
  let preloadPromise = null;
  let error = configurationError || (enabled ? "Not checked yet" : "Disabled");
  let retryAt = 0;

  function info() {
    return {
      enabled,
      available,
      baseUrl,
      profile: profile ? { id: profile.id, name: profile.name } : null,
      modelLoaded,
      modelDownloaded,
      modelSize: modelSize || null,
      warming: Boolean(preloadPromise),
      error: error || null
    };
  }

  async function refresh({ force = false, requestedProfile = configuredProfile, signal } = {}) {
    if (!enabled || configurationError) return info();
    if (!force && available && profile) return info();
    if (!force && Date.now() < retryAt) return info();
    try {
      const healthResponse = await fetchWithin(fetchImpl, `${baseUrl}/health`, { signal }, requestTimeoutMs);
      if (!healthResponse.ok) throw new Error(`health returned HTTP ${healthResponse.status}`);
      const health = await healthResponse.json();
      modelLoaded = health.model_loaded === true;
      modelDownloaded = modelLoaded || health.model_downloaded === true;
      modelSize = String(health.model_size || modelSize || "1.7B");
      if (health.status !== "healthy") throw new Error("Voicebox is not healthy");
      if (!modelDownloaded) throw new Error("Voicebox model is not downloaded");
      const profilesResponse = await fetchWithin(fetchImpl, `${baseUrl}/profiles`, { signal }, requestTimeoutMs);
      if (!profilesResponse.ok) throw new Error(`profiles returned HTTP ${profilesResponse.status}`);
      profile = chooseVoiceboxProfile(await profilesResponse.json(), requestedProfile);
      if (!profile) {
        throw new Error(requestedProfile
          ? `Cloned Voicebox profile not found: ${requestedProfile}`
          : "No unambiguous cloned Voicebox profile with a sample was found");
      }
      available = true;
      error = "";
      retryAt = 0;
    } catch (cause) {
      available = false;
      profile = null;
      error = cause instanceof Error ? cause.message : String(cause);
      retryAt = Date.now() + retryDelayMs;
    }
    return info();
  }

  async function preload(preloadOptions = {}) {
    if (!enabled || configurationError) return info();
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      const requestedProfile = String(preloadOptions.profile || configuredProfile).trim();
      const status = await refresh({
        force: true,
        requestedProfile,
        signal: preloadOptions.signal
      });
      if (!status.available || modelLoaded) return status;
      try {
        const loadUrl = `${baseUrl}/models/load?${new URLSearchParams({ model_size: modelSize || "1.7B" })}`;
        const loadResponse = await fetchWithin(fetchImpl, loadUrl, {
          method: "POST",
          headers: { Accept: "application/json" },
          signal: preloadOptions.signal
        }, preloadTimeoutMs);
        if (!loadResponse.ok) throw new Error(`model load returned HTTP ${loadResponse.status}`);
        await readWithin(loadResponse, "text", preloadTimeoutMs);
        return await refresh({ force: true, requestedProfile, signal: preloadOptions.signal });
      } catch (cause) {
        // Preloading is an optimization, not an availability contract. Older
        // Voicebox builds can still lazy-load successfully on /speak.
        available = Boolean(profile && modelDownloaded);
        error = `Voicebox preload failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        return info();
      }
    })();
    try {
      return await preloadPromise;
    } finally {
      preloadPromise = null;
    }
  }

  async function synthesize(text, synthOptions = {}) {
    const spoken = String(text || "").trim();
    if (!enabled || !spoken) return null;
    const requestedProfile = String(synthOptions.profile || configuredProfile).trim();
    const needsRefresh = requestedProfile && profile &&
      requestedProfile.toLowerCase() !== String(profile.id).toLowerCase() &&
      requestedProfile.toLowerCase() !== String(profile.name).toLowerCase();
    let status = await refresh({ force: needsRefresh, requestedProfile, signal: synthOptions.signal });
    if (status.available && !modelLoaded) {
      // Startup owns the potentially long model load. A request arriving while
      // it warms should use Artemis's fallback instead of paying the cold start.
      void preload({ profile: requestedProfile });
      error = "Voicebox model is warming up";
      return null;
    }
    if (!status.available || !profile) return null;
    let generationId = "";
    try {
      const speakResponse = await fetchWithin(fetchImpl, `${baseUrl}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          text: spoken,
          profile: profile.id,
          language: synthOptions.language || profile.language || "en"
        }),
        signal: synthOptions.signal
      }, requestTimeoutMs);
      if (!speakResponse.ok) throw new Error(`speak returned HTTP ${speakResponse.status}`);
      const generation = await speakResponse.json();
      generationId = String(generation.id || "").trim();
      if (!generationId) throw new Error("speak returned no generation id");

      let generationStatus = generation;
      if (generation.status !== "completed") {
        const statusResponse = await fetchWithin(
          fetchImpl,
          `${baseUrl}/generate/${encodeURIComponent(generationId)}/status`,
          { headers: { Accept: "text/event-stream" }, signal: synthOptions.signal },
          generationTimeoutMs
        );
        if (!statusResponse.ok) throw new Error(`generation status returned HTTP ${statusResponse.status}`);
        generationStatus = await terminalStatusWithin(statusResponse, generationTimeoutMs);
      }
      if (!generationStatus || generationStatus.status !== "completed") {
        throw new Error(generationStatus?.error || `generation ended in ${generationStatus?.status || "an unknown state"}`);
      }

      const audioResponse = await fetchWithin(
        fetchImpl,
        `${baseUrl}/audio/${encodeURIComponent(generationId)}`,
        { headers: { Accept: "audio/wav,audio/*" }, signal: synthOptions.signal },
        requestTimeoutMs
      );
      if (!audioResponse.ok) throw new Error(`audio returned HTTP ${audioResponse.status}`);
      const audio = Buffer.from(await readWithin(audioResponse, "arrayBuffer", requestTimeoutMs));
      if (!audio.length) throw new Error("audio response was empty");
      available = true;
      modelLoaded = true;
      error = "";
      return {
        audio,
        contentType: audioResponse.headers.get("content-type") || "audio/wav",
        profile: { id: profile.id, name: profile.name },
        generationId
      };
    } catch (cause) {
      if (generationId) {
        try {
          await fetchWithin(fetchImpl, `${baseUrl}/generate/${encodeURIComponent(generationId)}/cancel`, {
            method: "POST",
            headers: { Accept: "application/json" }
          }, requestTimeoutMs);
        } catch (cancelError) {}
      }
      available = false;
      error = cause instanceof Error ? cause.message : String(cause);
      retryAt = Date.now() + retryDelayMs;
      return null;
    }
  }

  return { info, refresh, preload, synthesize };
}

export { DEFAULT_VOICEBOX_URL };
