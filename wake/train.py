"""Train the "Hey Artemis" classifier head and export it in the browser's format.

Only the small head is trained. The mel front-end and the 96-d embedding model
are openWakeWord's, shipped as-is in public/oww/ and used by the browser at
runtime — so training on their output is training on exactly the features the
phone will see. The head is what the browser loads in place of
hey_jarvis_v0.1.onnx, with the same [1,16,96] -> [1,1] contract.

Two things here matter more than the architecture:

1. Position jitter. A wake word arrives anywhere inside the rolling 2 s window.
   Training every positive centred teaches the model to expect it centred, and
   it then misses in the field. Each positive is placed at a random offset.

2. Negatives from real continuous speech, not just near-miss phrases. The false
   accepts that ruin a wake word come from an hour of someone talking, so the
   training negatives are drawn by sliding over LibriSpeech at the same cadence
   the browser uses.
"""
import argparse
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import owwfeat as F


# ---- audio helpers ---------------------------------------------------------
def place_in_window(clip, rng, total=F.WINDOW_SAMPLES):
    """Drop a short clip at a random position inside a 2 s window of silence."""
    clip = clip[:total]
    out = np.zeros(total, dtype=np.float32)
    # keep the phrase fully inside the window; the tail matters most because the
    # browser scores the most recent 2 s
    latest = total - len(clip)
    start = rng.randint(int(latest * 0.25), latest) if latest > 0 else 0
    out[start:start + len(clip)] = clip
    return out


def augment(win, rng, noise_pool):
    """Gain, speed, background speech and a cheap room tail."""
    x = win.copy()
    if rng.random() < 0.8:                                   # speed / pitch-ish
        rate = rng.uniform(0.9, 1.12)
        idx = np.arange(0, len(x), rate)
        x = np.interp(idx, np.arange(len(x)), x).astype(np.float32)
        x = np.pad(x, (0, max(0, len(win) - len(x))))[:len(win)]
    if rng.random() < 0.7 and len(noise_pool):               # background talk
        n = noise_pool[rng.randrange(len(noise_pool))]
        if len(n) >= len(x):
            off = rng.randrange(len(n) - len(x) + 1)
            snr = rng.uniform(5, 25)
            noise = n[off:off + len(x)]
            p_s, p_n = np.mean(x ** 2) + 1e-9, np.mean(noise ** 2) + 1e-9
            x = x + noise * np.sqrt(p_s / (p_n * 10 ** (snr / 10)))
    if rng.random() < 0.35:                                  # small room tail
        ir = np.zeros(int(0.05 * F.SAMPLE_RATE), dtype=np.float32)
        ir[0] = 1.0
        for _ in range(rng.randint(2, 6)):
            ir[rng.randrange(1, len(ir))] += rng.uniform(0.05, 0.3)
        x = np.convolve(x, ir)[:len(win)].astype(np.float32)
    x = x * rng.uniform(0.35, 1.5)                           # gain
    return np.clip(x, -1.0, 1.0).astype(np.float32)


def load_clips(d):
    return [F.load_wav_16k(p) for p in sorted(Path(d).glob("*.wav"))]


# ---- dataset ---------------------------------------------------------------
def build(args):
    rng = random.Random(args.seed)
    data = Path(args.data)

    print("reading long-form negative speech…")
    import soundfile as sf
    flacs = sorted(Path(args.librispeech).rglob("*.flac"))
    rng.shuffle(flacs)
    hold_n = max(1, len(flacs) // 5)
    neg_eval_files, neg_train_files = flacs[:hold_n], flacs[hold_n:hold_n + args.neg_files]

    def read(p):
        a, sr = sf.read(p, dtype="float32")
        if sr != F.SAMPLE_RATE:
            idx = np.arange(0, len(a), sr / F.SAMPLE_RATE)
            a = np.interp(idx, np.arange(len(a)), a).astype(np.float32)
        return a

    noise_pool = [read(p) for p in neg_train_files[:80]]
    print(f"  {len(neg_train_files)} training files, {len(neg_eval_files)} held out for FAR")

    X, y, groups = [], [], []

    def add(feat, label, group):
        X.append(feat); y.append(label); groups.append(group)

    print("positives…")
    for split, reps in (("train", args.aug), ("heldout", 4)):
        for p in sorted((data / split / "positive").glob("*.wav")):
            clip = F.load_wav_16k(p)
            for _ in range(reps):
                w = augment(place_in_window(clip, rng), rng, noise_pool)
                add(F.features_2s(w), 1, split)
    print(f"  {sum(1 for v in y if v == 1)} positive windows")

    print("near-miss negatives…")
    for split in ("train", "heldout"):
        for p in sorted((data / split / "nearmiss").glob("*.wav")):
            clip = F.load_wav_16k(p)
            for _ in range(2):
                w = augment(place_in_window(clip, rng), rng, noise_pool)
                add(F.features_2s(w), 0, split)
    print(f"  {sum(1 for v in y if v == 0)} near-miss windows")

    # Continuous speech negatives, optionally MINED.
    #
    # Recall was already 1.00 at every threshold — the model has plenty of
    # positive signal and simply isn't discriminative on negatives. So the
    # useful thing is not more wake-word samples, it's more of the negatives
    # this model gets WRONG. With --mine, every candidate window is scored by an
    # existing model and the ones it already rejects confidently are mostly
    # discarded; what survives is the hard tail that actually moves the false
    # accept rate.
    #
    # Scored during extraction rather than afterwards so memory stays bounded:
    # the full candidate pool would be gigabytes.
    miner = None
    if args.mine:
        import onnxruntime as ort
        s = ort.InferenceSession(args.mine, providers=["CPUExecutionProvider"])
        name = s.get_inputs()[0].name
        miner = lambda f: float(s.run(None, {name: f[None].astype(np.float32)})[0].reshape(-1)[0])
        print(f"mining hard negatives with {args.mine} (keep >= {args.mine_threshold}, "
              f"else 1-in-{args.mine_easy_ratio})…")
    else:
        print("continuous-speech negatives…")

    got, seen, hard = 0, 0, 0
    for p in neg_train_files:
        a = read(p)
        for feat, _t in F.stream_windows(a, hop_embeddings=args.neg_hop):
            seen += 1
            if miner is not None:
                score = miner(feat)
                if score >= args.mine_threshold:
                    hard += 1
                elif rng.randrange(args.mine_easy_ratio) != 0:
                    continue          # an easy negative the model already nails
            add(feat, 0, "train")
            got += 1
        if got >= args.neg_windows:
            break
    if miner is not None:
        print(f"  {got} kept from {seen} scanned ({hard} hard, {got - hard} sampled easy)")
    else:
        print(f"  {got} continuous windows from {seen} scanned")

    X = np.stack(X).astype(np.float32)
    y = np.array(y, dtype=np.float32)
    groups = np.array(groups)
    # uncompressed: this array runs to hundreds of MB and compressing it costs
    # more wall-clock than re-deriving it would save
    np.savez(args.cache, X=X, y=y, groups=groups,
             eval_files=np.array([str(p) for p in neg_eval_files]))
    print(f"saved {X.shape} -> {args.cache}")
    return X, y, groups


# ---- model -----------------------------------------------------------------
class Head(nn.Module):
    """Deliberately small: it runs every ~240 ms on a phone, in WASM, on battery."""
    def __init__(self, hidden=96):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(16 * 96, hidden), nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden, hidden // 2), nn.ReLU(),
            nn.Linear(hidden // 2, 1), nn.Sigmoid()
        )

    def forward(self, x):
        return self.net(x)


def train(args, X, y, groups):
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"training on {dev}")
    tr, ho = groups == "train", groups == "heldout"
    Xtr, ytr = torch.tensor(X[tr]), torch.tensor(y[tr])[:, None]
    Xho, yho = torch.tensor(X[ho]).to(dev), torch.tensor(y[ho])[:, None].to(dev)

    # Hold back some training negatives to choose the checkpoint on. Selecting by
    # accuracy is what produced a model that answered "yes" to everything: there
    # are ~15,000 scoring windows in an hour of listening, so the only metric
    # that means anything is how often it fires on speech that isn't the wake
    # word. The final gate still uses genuinely unseen FILES (evaluate.py).
    neg_idx = np.where(y[tr] == 0)[0]
    rng = np.random.default_rng(args.seed)
    val_neg = set(rng.choice(neg_idx, size=max(1, len(neg_idx) // 6), replace=False).tolist())
    keep = np.array([i not in val_neg for i in range(len(Xtr))])
    Xval_neg = Xtr[~keep].to(dev)
    Xtr, ytr = Xtr[keep], ytr[keep]

    model = Head().to(dev)
    # NOT balanced on purpose. The deployed prior is overwhelmingly negative, and
    # up-weighting positives to parity optimises a world that doesn't exist —
    # it buys recall nobody needed and pays for it in false accepts all evening.
    pos_w = args.pos_weight
    print(f"  {int((ytr==1).sum())} pos / {int((ytr==0).sum())} neg "
          f"(pos weight {pos_w}, {len(Xval_neg)} negatives held back for selection)")
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    lossf = nn.BCELoss(reduction="none")

    n = len(Xtr)
    best = (-1.0, None)   # (score, state_dict)
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, args.batch):
            idx = perm[i:i + args.batch]
            xb, yb = Xtr[idx].to(dev), ytr[idx].to(dev)
            w = torch.where(yb > 0.5, pos_w, 1.0)
            opt.zero_grad()
            loss = (lossf(model(xb), yb) * w).mean()
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        model.eval()
        with torch.no_grad():
            p = model(Xho)
            recall = float(((p > 0.5).float()[yho > 0.5]).mean()) if (yho > 0.5).any() else 0.0
            nearfp = float(((p > 0.5).float()[yho < 0.5]).mean()) if (yho < 0.5).any() else 0.0
            # windows-per-hour ≈ 3600 / 0.24
            fa_rate = float((model(Xval_neg) > 0.5).float().mean())
            fa_hour = fa_rate * 15000
        # keep the checkpoint with the best recall among those that are quiet
        # enough to be usable; quietness dominates
        usable = fa_hour <= args.max_fa_hour
        sel = (recall if usable else recall - 10.0) - fa_hour / 1e4
        if sel > best[0]:
            best = (sel, {k: v.detach().clone() for k, v in model.state_dict().items()})
        print(f"  epoch {epoch+1:2d}  loss {total/n:.4f}  recall {recall:.3f}  "
              f"near-miss fp {nearfp:.3f}  est FA/h {fa_hour:7.1f}{'  *' if sel == best[0] else ''}")
    if best[1] is not None:
        model.load_state_dict(best[1])
        print("  restored best checkpoint")
    return model


def export(model, path):
    model = model.to("cpu").eval()
    dummy = torch.zeros(1, 16, 96)
    # The stock hey_jarvis model calls its tensors "x.1" and "53"; torch refuses
    # a purely numeric name, and it doesn't matter — wakeLocal.js reads
    # inputNames[0]/outputNames[0] off the session rather than hardcoding them.
    torch.onnx.export(model, dummy, path, input_names=["input"], output_names=["score"],
                      opset_version=13, dynamo=False)
    # prove the exported file honours the contract the browser depends on
    import onnxruntime as ort
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    i, o = s.get_inputs()[0], s.get_outputs()[0]
    assert list(i.shape) == [1, 16, 96], f"input {i.shape} != [1,16,96]"
    assert list(o.shape) == [1, 1], f"output {o.shape} != [1,1]"
    ref = model(dummy).detach().numpy()
    got = s.run(None, {i.name: dummy.numpy()})[0]
    assert np.allclose(ref, got, atol=1e-5), "onnx output differs from torch"
    print(f"exported {path}  in={i.shape} out={o.shape}  (torch/onnx agree)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--librispeech", required=True)
    ap.add_argument("--cache", default="dataset.npz")
    ap.add_argument("--out", default="hey_artemis.onnx")
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--aug", type=int, default=8, help="augmented copies per positive")
    ap.add_argument("--neg-files", type=int, default=400)
    ap.add_argument("--neg-windows", type=int, default=60000)
    ap.add_argument("--neg-hop", type=int, default=4)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--pos-weight", type=float, default=1.0,
                    help="deliberately 1.0 — see the note in train()")
    ap.add_argument("--max-fa-hour", type=float, default=2.0,
                    help="checkpoint selection: estimated false accepts/hour a model may have")
    ap.add_argument("--mine", help="existing model whose mistakes become the new negatives")
    ap.add_argument("--mine-threshold", type=float, default=0.05,
                    help="a candidate scoring at or above this is kept as a hard negative")
    ap.add_argument("--mine-easy-ratio", type=int, default=25,
                    help="keep 1 in N of the negatives the model already rejects")
    ap.add_argument("--reuse", action="store_true")
    args = ap.parse_args()

    if args.reuse and Path(args.cache).exists():
        d = np.load(args.cache, allow_pickle=True)
        X, y, groups = d["X"], d["y"], d["groups"]
        print(f"reusing {args.cache} {X.shape}")
    else:
        X, y, groups = build(args)
    model = train(args, X, y, groups)
    export(model, args.out)


if __name__ == "__main__":
    main()
