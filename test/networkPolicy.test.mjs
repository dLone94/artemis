// Offline / local-only mode is enforced at the routing level, not by a prompt.

import assert from "node:assert/strict";
import {
  isOffline, setOffline, networkAllowed, brainAllowed, allowedBrains,
  isLocalEndpoint, offlineRefusal, assertNetwork, OfflineError, offlineState
} from "../networkPolicy.js";

// default off
assert.equal(isOffline(), false);
assert.equal(networkAllowed("search"), true);

const CLOUD = { name: "groq:llama-3.3-70b", base: "https://api.groq.com/openai/v1" };
const LOCAL = { name: "ollama:qwen3.5:4b", base: "http://127.0.0.1:11434/v1" };
const chain = [CLOUD, LOCAL];

// online: everything allowed
assert.deepEqual(allowedBrains(chain), chain);
assert.equal(brainAllowed(CLOUD), true);

// enter local-only mode
setOffline(true);
assert.equal(isOffline(), true);
assert.equal(offlineState().offline, true);

// cloud is blocked, local is allowed
assert.equal(networkAllowed("search"), false, "cloud search blocked offline");
assert.equal(networkAllowed("fetch"), false);
assert.equal(networkAllowed("gmail"), false);
assert.equal(networkAllowed("terminal"), true, "local terminal always allowed");
assert.equal(networkAllowed("perception"), true, "local perception always allowed");
assert.equal(networkAllowed("ocr"), true, "local OCR always allowed");
assert.equal(networkAllowed("local_tts"), true);

// brain chain narrows to local
assert.equal(brainAllowed(CLOUD), false, "cloud brain blocked offline");
assert.equal(brainAllowed(LOCAL), true, "local brain allowed offline");
assert.deepEqual(allowedBrains(chain), [LOCAL]);

// endpoint classification
assert.equal(isLocalEndpoint("http://127.0.0.1:11434/v1"), true);
assert.equal(isLocalEndpoint("http://localhost:8080"), true);
assert.equal(isLocalEndpoint("https://api.groq.com/v1"), false);
assert.equal(isLocalEndpoint("http://0.0.0.0:11434/v1"), false,
  "0.0.0.0 is a bind-all address, not a loopback brain");

// refusal copy + assert
assert.match(offlineRefusal("search"), /Local-only mode is enabled/);
assert.throws(() => assertNetwork("gmail"), OfflineError);
assert.doesNotThrow(() => assertNetwork("terminal"));

// back online
setOffline(false);
assert.equal(networkAllowed("search"), true);
assert.deepEqual(allowedBrains(chain), chain);

console.log("✓ networkPolicy: offline blocks cloud, allows local, enforced not prompted");
