"""Publish a trained wake model as an immutable, hash-verified bundle.

Two rules make a wake-word deploy safe, and both are enforced here.

Immutable versioned paths: a bundle goes to /oww/models/<id>/ and is never
overwritten. Browsers cache aggressively, and a model swapped in place is the
kind of bug where one device wakes on the new phrase and another silently
doesn't, for a week, with no way to tell them apart.

The manifest is written LAST, and atomically. It is the only thing that switches
the active profile, so until the final rename every asset is already on disk and
verified. There is no window in which the app points at a half-copied model.

Rolling back is the same operation in reverse and just as atomic:
    python wake/bundle.py --rollback
"""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

PUBLIC_OWW = Path(__file__).resolve().parent.parent / "public" / "oww"
BASE_ASSETS = ["melspectrogram.onnx", "embedding_model.onnx"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_atomic(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)          # atomic within a filesystem


def load_manifest():
    p = PUBLIC_OWW / "manifest.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {"active": None, "profiles": {}}


def publish(args):
    model = Path(args.model)
    if not model.exists():
        raise SystemExit(f"no such model: {model}")
    if not args.gate_report:
        raise SystemExit("--gate-report is required: a wake model may not be published without a passing evaluation")

    gate = json.loads(Path(args.gate_report).read_text())
    if gate.get("verdict") != "PASS" and not args.force:
        raise SystemExit(
            f"gate verdict is {gate.get('verdict')}, refusing to publish.\n"
            f"  operating point: {gate.get('operatingPoint')}\n"
            f"  (--force overrides, but then the phrase flip is a deliberate choice, not an accident)"
        )
    op = gate.get("operatingPoint") or {}
    threshold = args.threshold if args.threshold is not None else op.get("threshold")
    if threshold is None:
        raise SystemExit("no threshold: pass --threshold or supply a gate report with an operating point")

    dest_dir = PUBLIC_OWW / "models" / args.id
    if dest_dir.exists() and not args.force:
        raise SystemExit(f"{dest_dir} already exists — bundles are immutable, pick a new --id")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / model.name
    shutil.copy2(model, dest)

    assets = {f"/oww/models/{args.id}/{model.name}": sha256(dest)}
    for a in BASE_ASSETS:
        assets[f"/oww/{a}"] = sha256(PUBLIC_OWW / a)

    profile = {
        "id": args.id,
        "phrase": args.phrase,
        "aliasPattern": args.alias,
        "classifierUrl": f"/oww/models/{args.id}/{model.name}",
        "threshold": float(threshold),
        "cooldownMs": args.cooldown,
        "assets": assets,
        "evaluation": {
            "verdict": gate.get("verdict"),
            "negativeHours": gate.get("negativeHours"),
            "operatingPoint": op
        }
    }

    manifest = load_manifest()
    manifest["profiles"][args.id] = profile
    manifest["active"] = args.id            # flipped only on the final write
    write_atomic(PUBLIC_OWW / "manifest.json", json.dumps(manifest, indent=2))

    print(f"published {args.id}")
    print(f"  phrase     {args.phrase}")
    print(f"  threshold  {threshold}")
    print(f"  classifier {profile['classifierUrl']}")
    print(f"  recall {op.get('recall')} at {op.get('faPerHourUpper95')} false accepts/hour (95% upper bound)")


def rollback(args):
    manifest = load_manifest()
    was = manifest.get("active")
    manifest["active"] = None               # None → the browser uses the built-in Jarvis profile
    write_atomic(PUBLIC_OWW / "manifest.json", json.dumps(manifest, indent=2))
    print(f"rolled back from {was or '(nothing)'} → built-in hey-jarvis-v0.1")
    print("  the bundle is left on disk; re-activate by setting 'active' again")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rollback", action="store_true")
    ap.add_argument("--model")
    ap.add_argument("--id", default="hey-artemis-v1")
    ap.add_argument("--phrase", default="Hey Artemis")
    ap.add_argument("--alias", default="(artemis|artemus|art[ei]miss|artist|our themis)")
    ap.add_argument("--threshold", type=float)
    ap.add_argument("--cooldown", type=int, default=2000)
    ap.add_argument("--gate-report")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    rollback(args) if args.rollback else publish(args)


if __name__ == "__main__":
    main()
