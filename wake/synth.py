"""Generate the training corpus for a custom wake word, on this machine only.

Positives are the wake phrase spoken by many synthetic speakers. Negatives are
the part people skip and then wonder why the thing fires at the television: the
NEAR MISSES. A model trained on "hey artemis" vs. random speech learns to fire on
anything with the right rhythm — "hey, are you there", "art class", "hey Jarvis".
Those phrases are generated here deliberately, by the same voices, so the model
has to learn the actual word rather than the shape of it.

Speaker diversity comes from piper's multi-speaker voices (vctk, libritts_r,
l2arctic and friends carry hundreds of distinct speakers between them). Whole
voices are reserved for validation by the caller, so the held-out split is by
SPEAKER, not by clip — otherwise the score just measures memorisation.

Nothing leaves the machine: piper runs locally, the voices are cached locally,
and no recording of the user is involved.
"""
import argparse
import json
import os
import random
import wave
from pathlib import Path

# espeak-ng data: the arm64 macOS piper wheel hardcodes its CI build path, so it
# has to be pointed at a real installation before piper is imported.
os.environ.setdefault("ESPEAK_DATA_PATH", "/opt/homebrew/share")

TRAIN_VOICES = [
    ("en_US-libritts_r-medium", 40),   # (voice, how many speaker ids to sample)
    ("en_US-l2arctic-medium", 20),     # accented English — the usual failure mode
    ("en_GB-vctk-medium", 40),
    ("en_US-arctic-medium", 12),
    ("en_US-amy-medium", 1),
    ("en_US-ryan-medium", 1),
    ("en_GB-alan-medium", 1),
    ("en_US-hfc_female-medium", 1),
]
# held out entirely: different voices AND different accents from training
HELDOUT_VOICES = [
    ("en_US-lessac-medium", 1),
    ("en_GB-jenny_dioco-medium", 1),
    ("en_US-kristin-medium", 1),
    ("en_GB-northern_english_male-medium", 1),
]

POSITIVE_TEMPLATES = [
    "Hey Artemis", "Hey Artemis.", "Hey, Artemis", "hey artemis",
    "Hey Artemis!", "Hey Artemis?", "Hey Artemis, ", " Hey Artemis",
]

# The near-miss set. Each of these shares onset, rhythm or phonemes with the
# wake phrase and must NOT fire.
NEAR_MISSES = [
    "Hey Jarvis", "Hey Alexis", "Hey Artie", "Hey Autumn", "Hey Marcus",
    "Hey artist", "The artist", "Artemis", "Artemis was a goddess",
    "Hey are you there", "Hey are we", "Hey art", "Art class",
    "Hey Charmaine", "Hey Anna", "Hey Amazon", "Hey Alfred", "Hey Anthony",
    "Hey there", "Hey you", "Hey, um", "Okay Artemis is a moon of Jupiter",
    "Say Artemis", "They are this", "Hey artemis's", "Hey art mister",
    "Hey Sam", "Hey Google", "Hey Siri", "A tennis", "Are the mist",
    "Hey, it's me", "Hey what's the time", "Hey can you hear me",
]


def synth(voice_dir, voice, text, out_path, speaker_id=None, length_scale=1.0, noise_scale=0.667):
    from piper import PiperVoice, SynthesisConfig
    key = (voice_dir, voice)
    if key not in _voices:
        _voices[key] = PiperVoice.load(str(Path(voice_dir) / f"{voice}.onnx"),
                                       config_path=str(Path(voice_dir) / f"{voice}.onnx.json"))
    v = _voices[key]
    cfg = SynthesisConfig(speaker_id=speaker_id, length_scale=length_scale, noise_scale=noise_scale)
    with wave.open(str(out_path), "wb") as w:
        v.synthesize_wav(text, w, syn_config=cfg)


_voices = {}


def n_speakers(voice_dir, voice):
    cfg = json.loads((Path(voice_dir) / f"{voice}.onnx.json").read_text())
    return max(1, int(cfg.get("num_speakers", 1)))


def download(voice_dir, voices):
    from piper.download_voices import download_voice
    Path(voice_dir).mkdir(parents=True, exist_ok=True)
    for v, _ in voices:
        if not (Path(voice_dir) / f"{v}.onnx").exists():
            print(f"  downloading {v}")
            download_voice(v, Path(voice_dir))


def generate(out_dir, voice_dir, voices, phrases, label, rng, per_speaker=1):
    out = Path(out_dir) / label
    out.mkdir(parents=True, exist_ok=True)
    made = 0
    for voice, want_speakers in voices:
        total = n_speakers(voice_dir, voice)
        ids = rng.sample(range(total), min(want_speakers, total)) if total > 1 else [None]
        for sid in ids:
            for _ in range(per_speaker):
                text = rng.choice(phrases)
                # prosody jitter: pace and expressiveness vary hugely between
                # real speakers and this is free variation
                ls = rng.uniform(0.82, 1.25)
                ns = rng.uniform(0.5, 0.85)
                name = f"{voice}__s{sid}__{made:05d}.wav"
                try:
                    synth(voice_dir, voice, text, out / name, sid, ls, ns)
                    made += 1
                except Exception as e:      # one bad speaker id shouldn't kill the run
                    print(f"    ! {voice} sid={sid}: {e}")
    print(f"  {label}: {made} clips")
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice-dir", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--pos-per-speaker", type=int, default=2)
    ap.add_argument("--neg-per-speaker", type=int, default=3)
    ap.add_argument("--speaker-scale", type=float, default=1.0,
                    help="multiply how many speakers are sampled from each multi-speaker voice")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    global TRAIN_VOICES
    if args.speaker_scale != 1.0:
        TRAIN_VOICES = [(v, max(1, int(n * args.speaker_scale))) for v, n in TRAIN_VOICES]

    print("voices…")
    download(args.voice_dir, TRAIN_VOICES + HELDOUT_VOICES)

    print("train split…")
    generate(args.out + "/train", args.voice_dir, TRAIN_VOICES, POSITIVE_TEMPLATES, "positive", rng, args.pos_per_speaker)
    generate(args.out + "/train", args.voice_dir, TRAIN_VOICES, NEAR_MISSES, "nearmiss", rng, args.neg_per_speaker)

    print("held-out split (unseen speakers)…")
    generate(args.out + "/heldout", args.voice_dir, HELDOUT_VOICES, POSITIVE_TEMPLATES, "positive", rng, 12)
    generate(args.out + "/heldout", args.voice_dir, HELDOUT_VOICES, NEAR_MISSES, "nearmiss", rng, 12)


if __name__ == "__main__":
    main()
