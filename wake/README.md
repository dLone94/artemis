# Training a custom wake word

Everything here runs **on this machine**. No audio, no generated speech and no
recording of you is uploaded anywhere, and no remote GPU is involved. That is a
constraint of the design, not a coincidence — the wake engine is the one part of
Artemis that listens continuously, and it stays local.

The pieces:

| file | what it does |
|---|---|
| `owwfeat.py` | feature extraction — a line-for-line mirror of `public/wakeLocal.js` |
| `synth.py` | generates positives and near-miss negatives with piper TTS |
| `train.py` | builds the dataset, trains the classifier head, exports ONNX |
| `evaluate.py` | the release gate: event-level false accepts per hour |
| `bundle.py` | publishes a verified bundle and flips the active profile |

## Why only the head is trained

openWakeWord is three models: a mel front-end, a 96-dimensional embedding model,
and a small classifier on top. The first two are general-purpose and already
shipped in `public/oww/` — the browser loads them at runtime. So training means
training the head on their output, which is exactly the input the phone will
produce. `owwfeat.py` exists to guarantee that: same 32 mel bins, same `/10 + 2`
scaling, same 76-frame windows at step 8, same 16 embeddings, same `[1,16,96]`.
Drift there is invisible — the model scores beautifully offline and fails in the
browser.

## Setup

Needs Python 3.11 and `espeak-ng` (`brew install espeak-ng`).

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python torch torchaudio onnx onnxruntime numpy scipy soundfile piper-tts
```

Two arm64-macOS notes, both discovered the hard way:

- **`piper-phonemize` has no arm64 macOS wheel.** Don't try; `piper-tts` 1.6+
  bundles its own espeak bridge and doesn't need it.
- **The `piper-tts` wheel hardcodes its CI build path for espeak data.** Set
  `ESPEAK_DATA_PATH=/opt/homebrew/share` or every synthesis call fails with a
  missing `phontab`.

## Run

```bash
python wake/synth.py --out data --voice-dir voices --speaker-scale 2.2 --pos-per-speaker 8
python wake/train.py --data data --librispeech LibriSpeech --neg-files 600 --neg-windows 90000
python wake/evaluate.py --model hey_artemis.onnx --positives data/heldout/positive \
                       --negatives heldout_neg --hours 2
python wake/bundle.py --model hey_artemis.onnx --gate-report wake-eval.json \
                      --id hey-artemis-v1 --phrase "Hey Artemis"
```

Negatives are LibriSpeech `dev-clean` (CC BY 4.0). Held-out splits are by
**speaker and by file** — whole piper voices are reserved for validation and the
negative files used for the gate are disjoint from the ones used for training.
Splitting by clip would just measure memorisation.

## The gate

`evaluate.py` is the only thing that decides whether a model may ship, and it
does not report accuracy. Accuracy is what makes a wake word look good and then
fire at the television: the browser scores a window every ~240 ms, so there are
about 15,000 chances per hour to be wrong, and 99.9% per-window accuracy is 15
false wakes an hour.

So it scores continuous unseen speech the way the browser does — same cadence,
same 2 s cooldown — and reports **false accepts per hour with a one-sided 95%
Poisson upper bound**, plus recall at that operating point measured on unseen
speakers spliced into real background speech. The gate is stated up front:

> recall ≥ 0.85 at a false-accept rate whose **95% upper bound** is ≤ 1/hour

Choosing against the bound rather than the point estimate is deliberate. Zero
false accepts in one hour does not mean the rate is zero, and a short lucky run
should not be able to ship a model that fires all evening.

`bundle.py` refuses to publish a model whose gate report isn't `PASS`.

## Current status: NOT SHIPPED

The pipeline works end to end and the model exports with the exact browser
contract. It does **not** pass the gate, so `manifest.json` is absent and the
shipped **“Hey Jarvis”** profile is still what runs.

Measured on 1.08 h of unseen LibriSpeech with 222 synthetic training speakers and
1,776 positive utterances:

| threshold | recall | false accepts/hour (95% ub) |
|---|---|---|
| 0.50 | 1.00 | 89.3 |
| 0.90 | 1.00 | 44.1 |
| 0.99 | 1.00 | 13.4 |

Two things were learned, and both are in the code now:

1. **Don't class-balance a wake word.** The first run up-weighted positives to
   parity with negatives, which optimises a world that doesn't exist. It bought
   recall nobody needed and paid for it in false accepts. `--pos-weight` now
   defaults to 1.0, and checkpoints are selected on estimated false accepts per
   hour rather than accuracy.
2. **The corpus is still roughly two orders of magnitude too small.**
   openWakeWord's own models train on tens of thousands of synthetic positives
   and millions of negative windows; this used 1,776 and 90,000. Recall pinned at
   1.00 across every threshold is the signature of a decision boundary that hasn't
   been pushed anywhere near where it needs to be.

The honest next step is scale, not architecture: generate ~30k positives across
every available speaker, add a much larger and more varied negative pool (MUSAN
plus more LibriSpeech, with music and noise, not just clean read speech), and
mine hard negatives from the first model's own false accepts. That's hours of
generation and tens of GB — worth doing deliberately, not squeezed in.

Until then the flip stays where it belongs: unmade.
