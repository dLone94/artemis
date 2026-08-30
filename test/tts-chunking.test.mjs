import test from "node:test";
import assert from "node:assert/strict";
import { takeVoiceboxChunks } from "../public/ttsChunking.js";

test("Voicebox starts with one sentence and coalesces the rest of a reply", () => {
  const first = takeVoiceboxChunks(
    "First sentence. Second sentence. Third sentence.",
    { firstChunkPending: true }
  );
  assert.deepEqual(first.chunks, ["First sentence. "]);
  assert.equal(first.remainder, "Second sentence. Third sentence.");
  assert.equal(first.firstChunkPending, false);

  const duringStream = takeVoiceboxChunks(first.remainder + " Fourth sentence.", {
    firstChunkPending: first.firstChunkPending
  });
  assert.deepEqual(duringStream.chunks, []);

  const final = takeVoiceboxChunks(duringStream.remainder, {
    firstChunkPending: duringStream.firstChunkPending,
    flush: true
  });
  assert.deepEqual(final.chunks, ["Second sentence. Third sentence. Fourth sentence."]);
  assert.equal(final.remainder, "");
});

test("Voicebox bounds long requests without splitting words", () => {
  const text = ("A measured answer with several useful words. ").repeat(30);
  const result = takeVoiceboxChunks(text, {
    firstChunkPending: false,
    maxChunkChars: 240
  });

  assert.ok(result.chunks.length > 0);
  assert.ok(result.chunks.every((chunk) => chunk.length <= 240));
  assert.equal(result.chunks.join("") + result.remainder, text);
  assert.ok(result.chunks.every((chunk) => /\s$/.test(chunk)));
});
