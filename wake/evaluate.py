"""The release gate: event-level false accepts per hour, and recall at that rate.

Window-level accuracy is the number that makes a wake word look good and then
fires at the television. What a user experiences is EVENTS: the browser scores
every ~240 ms and, once it fires, ignores the next 2 s (wakeLocal.js COOLDOWN_MS).
A model can be 99.9% accurate per window and still trigger many times an hour,
because there are ~15,000 windows in an hour.

So this scores continuous audio the way the browser does — same cadence, same
cooldown — over held-out speech nobody trained on, and reports:

  * false accepts per hour, with a one-sided 95% Poisson upper bound (observing
    zero events in five hours does NOT mean the rate is zero, and the gate
    should be set against the bound, not the point estimate)
  * recall at that operating point, measured on unseen speakers spliced into
    real background speech rather than sitting in clean silence

Sweeping the threshold gives the ROC the deployed THRESHOLD is chosen from.
"""
import argparse
import json
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort
from scipy.stats import chi2

import owwfeat as F

CADENCE_EMB = 3        # wakeLocal.js runs inference every ~3 frames (~240 ms)
COOLDOWN_S = 2.0       # wakeLocal.js COOLDOWN_MS


def load_head(path):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    name = s.get_inputs()[0].name
    return lambda feats: s.run(None, {name: feats[None].astype(np.float32)})[0].reshape(-1)[0]


def score_stream(score_fn, audio):
    """Every (time, score) the browser would have computed for this audio."""
    return [(t, float(score_fn(f))) for f, t in F.stream_windows(audio, CADENCE_EMB)]


def events(scored, threshold):
    """Collapse scores into user-visible triggers, honouring the cooldown."""
    out, last = [], -1e9
    for t, s in scored:
        if s >= threshold and t - last >= COOLDOWN_S:
            out.append(t)
            last = t
    return out


def poisson_upper(k, hours, conf=0.95):
    """One-sided upper bound on a rate from k events in `hours` hours."""
    if hours <= 0:
        return float("inf")
    return chi2.ppf(conf, 2 * (k + 1)) / 2.0 / hours


def read_any(p):
    import soundfile as sf
    a, sr = sf.read(str(p), dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != F.SAMPLE_RATE:
        idx = np.arange(0, len(a), sr / F.SAMPLE_RATE)
        a = np.interp(idx, np.arange(len(a)), a).astype(np.float32)
    return a.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--positives", required=True, help="held-out positive clips (unseen speakers)")
    ap.add_argument("--negatives", required=True, help="directory of held-out continuous speech")
    ap.add_argument("--hours", type=float, default=2.0)
    ap.add_argument("--report", default="wake-eval.json")
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    score = load_head(args.model)

    # ---- negatives: continuous speech, scored at the deployed cadence -------
    files = sorted(Path(args.negatives).rglob("*.flac")) or sorted(Path(args.negatives).rglob("*.wav"))
    rng.shuffle(files)
    neg_scores, seconds = [], 0.0
    for p in files:
        a = read_any(p)
        if len(a) < F.WINDOW_SAMPLES:
            continue
        neg_scores.append(score_stream(score, a))
        seconds += len(a) / F.SAMPLE_RATE
        if seconds >= args.hours * 3600:
            break
    hours = seconds / 3600.0
    print(f"negatives: {hours:.2f} h of unseen speech, {sum(len(s) for s in neg_scores)} scored windows")

    # A gate you cannot pass is not a gate. With k=0 events the tightest bound
    # this much audio can produce is chi2(0.95,2)/2/hours — on ~1 h that is
    # 2.77/h, so a PERFECT model would still "fail" a 1/h gate. Say so loudly
    # rather than reporting a failure the data could never have avoided.
    if not neg_scores:
        raise SystemExit(f"no usable audio in {args.negatives} — note that find/rglob does not "
                         f"follow symlinks; point --negatives at a real directory")
    floor = poisson_upper(0, hours)
    if floor > 1.0:
        print(f"  ⚠️  {hours:.2f} h is too little audio to certify 1.0/h: even zero false "
              f"accepts would only bound the rate at {floor:.2f}/h.")
        print(f"      Need at least {chi2.ppf(0.95, 2) / 2.0:.2f} h for a clean run to pass.")

    # ---- positives: unseen speakers, spliced into real background ----------
    neg_bed = [read_any(p) for p in files[-40:]]
    pos_files = sorted(Path(args.positives).glob("*.wav"))
    pos_trials = []
    for p in pos_files:
        clip = F.load_wav_16k(p)
        bed = neg_bed[rng.randrange(len(neg_bed))]
        # 3 s of real speech, the wake word, then 3 s more — a realistic arrival
        lead = bed[:F.SAMPLE_RATE * 3] * 0.25
        tail = bed[F.SAMPLE_RATE * 3:F.SAMPLE_RATE * 6] * 0.25
        if len(lead) < F.SAMPLE_RATE * 3 or len(tail) < F.SAMPLE_RATE * 3:
            continue
        audio = np.concatenate([lead, clip, tail]).astype(np.float32)
        onset = len(lead) / F.SAMPLE_RATE
        offset = (len(lead) + len(clip)) / F.SAMPLE_RATE
        pos_trials.append((score_stream(score, audio), onset, offset))
    print(f"positives: {len(pos_trials)} trials from unseen speakers")

    # ---- sweep -------------------------------------------------------------
    rows = []
    for th in [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]:
        fa = sum(len(events(s, th)) for s in neg_scores)
        hit = 0
        for scored, onset, offset in pos_trials:
            # a trigger counts if it lands while the phrase is in the window
            if any(onset <= t <= offset + 2.0 for t in events(scored, th)):
                hit += 1
        recall = hit / max(1, len(pos_trials))
        rows.append({
            "threshold": th,
            "recall": round(recall, 4),
            "falseAccepts": fa,
            "faPerHour": round(fa / hours, 3) if hours else None,
            "faPerHourUpper95": round(poisson_upper(fa, hours), 3)
        })

    print(f"\n  {'thresh':>7} {'recall':>7} {'FA':>5} {'FA/h':>7} {'FA/h ub95':>10}")
    for r in rows:
        print(f"  {r['threshold']:>7.2f} {r['recall']:>7.3f} {r['falseAccepts']:>5} "
              f"{r['faPerHour']:>7.2f} {r['faPerHourUpper95']:>10.2f}")

    # Operating point: the predeclared gate is the highest recall whose 95%
    # UPPER BOUND on false accepts stays under one per hour. Choosing against
    # the bound rather than the point estimate is what stops a lucky short run
    # from shipping a model that fires all evening.
    ok = [r for r in rows if r["faPerHourUpper95"] <= 1.0]
    best = max(ok, key=lambda r: r["recall"]) if ok else None
    report = {
        "model": args.model,
        "negativeHours": round(hours, 3),
        "tightestPossibleUpper95": round(floor, 3),
        "underpowered": bool(floor > 1.0),
        "positiveTrials": len(pos_trials),
        "cadenceMs": 240, "cooldownS": COOLDOWN_S,
        "gate": {"maxFaPerHourUpper95": 1.0, "minRecall": 0.85},
        "sweep": rows,
        "operatingPoint": best,
        "verdict": "PASS" if best and best["recall"] >= 0.85 else "FAIL"
    }
    Path(args.report).write_text(json.dumps(report, indent=2))
    print(f"\n  gate: FA/h upper-95 <= 1.0 and recall >= 0.85")
    if best:
        print(f"  best qualifying threshold {best['threshold']} -> recall {best['recall']}, "
              f"FA/h {best['faPerHour']} (ub95 {best['faPerHourUpper95']})")
    else:
        print("  no threshold meets the false-accept bound")
    print(f"  {report['verdict']}  ->  {args.report}")


if __name__ == "__main__":
    main()
