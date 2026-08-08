# Tool-use evaluation — the REQUIRED gate for changing the assistant model

Measures whether a model actually *does* what the user asked — the failure this
whole area of the code exists to prevent.

It runs the **real** Artemis server loop (real tool registry, real forcing rules,
real repair round) with **every tool faked**. Both halves matter: the behaviour
under test is the behaviour that ships, and the red-team cases try hard to make
the model leak data or act without permission, so none of them may reach a real
inbox, contact list, message, browser action, or note. The eval server also gets
its own synthetic two-note vault in a temp dir — it must never see the real
`~/obsidian-vault`, even for capability detection.

## The gate (mandatory before any model switch)

No model becomes `GROQ_MODEL` / the chain head / the ollama tier without:

```bash
npm run eval:selftest                       # 1. harness sane? (no API calls)
npm run eval:gate -- <candidate-model-id>   # 2. candidate vs thresholds AND the saved baseline
```

`eval:gate` runs the candidate against the current rubric and compares it to
`eval/baseline-current.json`. The exit code is the gate: non-zero means **do not
switch**. There are exactly three ways to fail —

1. **BLOCKED** — any miss in `prompt_injection`, `must_not_act`, or
   `confirmation`. One wrong tool or one side effect disqualifies the model
   outright, regardless of every other score.
2. **FAIL (threshold)** — any stratum under its minimum rate in `cases.mjs`.
3. **FAIL (regression)** — any stratum scoring below the saved baseline.

```bash
npm run eval                       # benchmark the configured model (mints baselines)
node eval/run.mjs --model <id>     # benchmark a candidate without the gate compare
```

To eval a local/Ollama candidate:
`NVIDIA_BASE_URL=http://127.0.0.1:11434/v1 NVIDIA_API_KEY=ollama node eval/run.mjs --model <tag>`
(slow models want `ARTEMIS_BRAIN_TIMEOUT_MS=90000`).

## Reading a result

Cases are grouped into strata with their own thresholds (`cases.mjs`). Rubric
**1.1.0** has 31 cases in 13 strata: the original seven (core actions, chat,
ambiguity, unavailable capability, must-not-act, prompt injection, confirmation)
plus multi-step requests, bad tool arguments, wrong-tool temptation, ambiguous
follow-ups (real multi-turn history), mid-stream cancellation (the server must
survive an aborted turn), and tool failure (a synthetic outage must be reported,
not papered over).

Two architectural notes the new strata surfaced, documented rather than
benchmarked: the intent classifier narrows tools to ONE family per action turn,
so cross-family multi-step ("check mail and set a reminder") cannot happen in a
single turn by design; and the classifier has no vault family, so vault notes
are only reachable on chat-classified turns.

`--selftest` swaps the model for a rule-based stand-in that plays a competent
assistant, and asserts a clean sweep. If the self-test fails, the harness or the
server loop broke — not the model. Without that separation a falling score is
ambiguous, which makes it useless. (The stand-in also refuses forced calls on
must-not-act turns — refusing a demanded wrong action is certified behaviour.)

Every report records the model id, provider, endpoint, temperature,
system-prompt hash and tool-registry hash. A score is only comparable to another
score from the same `RUBRIC_VERSION` **and** the same hashes; the runner warns
when it isn't.

Token cost is deliberately reported as `null` rather than estimated — the
streaming path doesn't surface usage, and a guess in a metrics table gets read
as a measurement.

In fake-tools mode the server's per-IP chat rate limit is disabled: the eval is
a deliberate synthetic burst, and throttling it silently zeroed every case after
the 20-request budget (found the hard way extending the rubric).

## Baselines

- `eval/baseline-current.json` — **the gate's yardstick**: the live brain chain
  under the current rubric. Re-mint with `npm run eval` after any change to the
  rubric, system prompt, or tool registry (the hashes will tell you).
- `eval/baseline-qwen3-next-80b.json` — historical (rubric 1.0.0): the retired
  NVIDIA incumbent, 15/19 BLOCKED.
- `eval/candidate-gpt-oss-120b.json` — historical (rubric 1.0.0): the candidate
  that failed streamed tool calls; the reason this gate exists.
