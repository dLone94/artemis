// Local, on-device wake word via Picovoice Porcupine (vendored, offline).
// Porcupine does ONE thing well — reliably spot the word "Artemis" — running
// entirely in the browser (WASM), including on iPhone Safari where the built-in
// speech recognizer doesn't exist. It does NOT transcribe; on detection it just
// calls onDetect(), and main.js hands off to the existing mic→STT→reply pipeline
// to capture the actual command.
//
// Requires (server /api/status → porcupine): a client-side access key and a
// custom "artemis.ppn" keyword file dropped in public/porcupine/. If either is
// missing, this stays inert and main.js falls back to the browser recognizer.

let worker = null;
let running = false;
let loading = null; // dedupe concurrent starts

async function load(cfg, onDetect) {
  // lazy-import the vendored SDK (~4MB) only when actually starting the wake word
  const [{ PorcupineWorker }, { WebVoiceProcessor }] = await Promise.all([
    import("./porcupine/porcupine.js"),
    import("./porcupine/wvp.js"),
  ]);
  worker = await PorcupineWorker.create(
    cfg.key,
    { publicPath: "/porcupine/artemis.ppn", label: "Artemis" },
    (detection) => { if (detection && running) onDetect(); },
    { publicPath: "/porcupine/porcupine_params.pv" }
  );
  await WebVoiceProcessor.subscribe(worker);
  return WebVoiceProcessor;
}

let WVP = null;

export async function startPorcupine(cfg, onDetect) {
  if (running) return true;
  if (loading) return loading;
  loading = (async () => {
    try {
      WVP = await load(cfg, onDetect);
      running = true;
      return true;
    } catch (e) {
      console.warn("Porcupine wake failed to start — falling back:", e && e.message);
      await cleanup();
      running = false;
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function cleanup() {
  try { if (WVP && worker) await WVP.unsubscribe(worker); } catch (e) {}
  try { worker && worker.release && worker.release(); } catch (e) {}
  try { worker && worker.terminate && worker.terminate(); } catch (e) {}
  worker = null; WVP = null;
}

export async function stopPorcupine() {
  running = false;
  await cleanup();
}

// The mic can only feed one consumer cleanly — pause Porcupine's processor while
// we record the command, then resume it. Keeps the wake engine from re-firing on
// the command itself and avoids mic contention with the recorder.
export async function pausePorcupine() {
  try { if (WVP && worker && running) await WVP.unsubscribe(worker); } catch (e) {}
}
export async function resumePorcupine() {
  try { if (WVP && worker && running) await WVP.subscribe(worker); } catch (e) {}
}

export function porcupineRunning() { return running; }
