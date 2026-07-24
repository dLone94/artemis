"""openWakeWord feature extraction — a line-for-line mirror of public/wakeLocal.js.

The browser is the deployment target, so this file's only job is to produce
exactly the tensors the browser produces. Every constant here is copied from
wakeLocal.js and any drift is a silent accuracy bug: a model trained on
differently-scaled features will look excellent offline and fail on a phone.

Pipeline: 16 kHz audio -> melspectrogram.onnx -> /10 + 2 -> 76-frame windows at
step 8 -> embedding_model.onnx -> 96-d vectors -> 16 of them -> [1, 16, 96].
"""
import os
from pathlib import Path
import numpy as np
import onnxruntime as ort

# The shipped front-end models. Overridable so a training run can live in a
# scratch directory without silently picking up a different copy — using
# different feature models than the browser is an invisible accuracy bug.
OWW_DIR = Path(os.environ.get("ARTEMIS_OWW_DIR",
                              Path(__file__).resolve().parent.parent / "public" / "oww"))

SAMPLE_RATE = 16000
WINDOW_SAMPLES = 32000   # BUF in wakeLocal.js — 2 s
N_MELS = 32
EMB_WINDOW = 76          # mel frames per embedding
EMB_STEP = 8             # mel frames between embeddings
N_EMB = 16               # embeddings the classifier consumes
MEL_FRAMES_NEEDED = 196  # wakeLocal.js requires this much context

_sessions = {}


def _session(name):
    if name not in _sessions:
        opt = ort.SessionOptions()
        opt.intra_op_num_threads = 1
        _sessions[name] = ort.InferenceSession(str(OWW_DIR / name), sess_options=opt,
                                               providers=["CPUExecutionProvider"])
    return _sessions[name]


def mel_of(audio: np.ndarray) -> np.ndarray:
    """16 kHz mono float32 -> [frames, 32], normalised the way the browser does."""
    s = _session("melspectrogram.onnx")
    audio = np.asarray(audio, dtype=np.float32).reshape(1, -1)
    out = s.run(None, {s.get_inputs()[0].name: audio})[0]
    mel = out.reshape(-1, N_MELS)
    return mel / 10.0 + 2.0          # wakeLocal.js:89


def embeddings_of(mel: np.ndarray, batch: int = 64) -> np.ndarray:
    """[frames, 32] -> [T, 96], one embedding per EMB_STEP mel frames.

    Computed once per file and then sliced, rather than re-running the model per
    detection window — the windows overlap by 15/16, so recomputing would be a
    16x waste on long negative audio.
    """
    s = _session("embedding_model.onnx")
    name = s.get_inputs()[0].name
    starts = list(range(0, mel.shape[0] - EMB_WINDOW + 1, EMB_STEP))
    if not starts:
        return np.zeros((0, 96), dtype=np.float32)
    out = np.empty((len(starts), 96), dtype=np.float32)
    for i in range(0, len(starts), batch):
        chunk = starts[i:i + batch]
        stack = np.stack([mel[t:t + EMB_WINDOW] for t in chunk])[..., None].astype(np.float32)
        res = s.run(None, {name: stack})[0]
        out[i:i + len(chunk)] = res.reshape(len(chunk), 96)
    return out


def features_2s(audio: np.ndarray) -> np.ndarray:
    """One 2 s clip -> [16, 96], taking the most recent context like the browser."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.shape[0] < WINDOW_SAMPLES:
        audio = np.pad(audio, (WINDOW_SAMPLES - audio.shape[0], 0))
    audio = audio[-WINDOW_SAMPLES:]
    mel = mel_of(audio)
    if mel.shape[0] < MEL_FRAMES_NEEDED:
        raise ValueError(f"only {mel.shape[0]} mel frames, need {MEL_FRAMES_NEEDED}")
    base = mel.shape[0] - MEL_FRAMES_NEEDED          # wakeLocal.js:91
    s = _session("embedding_model.onnx")
    # the browser runs these 16 one at a time; batching is numerically identical
    # and the only reason building a dataset finishes this side of an afternoon
    stack = np.stack([mel[base + e * EMB_STEP:base + e * EMB_STEP + EMB_WINDOW]
                      for e in range(N_EMB)])[..., None].astype(np.float32)
    out = s.run(None, {s.get_inputs()[0].name: stack})[0]
    return out.reshape(N_EMB, 96).astype(np.float32)


def stream_windows(audio: np.ndarray, hop_embeddings: int = 3):
    """Long audio -> (features[16,96], time_seconds) at the browser's cadence.

    hop_embeddings=3 is ~240 ms, matching "run inference every ~3 frames" in
    wakeLocal.js. Scoring negatives at the real cadence is what makes a false-
    accept rate a per-hour number rather than a per-arbitrary-window number.
    """
    mel = mel_of(audio)
    emb = embeddings_of(mel)
    if emb.shape[0] < N_EMB:
        return
    for i in range(0, emb.shape[0] - N_EMB + 1, hop_embeddings):
        # each embedding advances EMB_STEP mel frames; mel frames are 10 ms
        t = ((i + N_EMB) * EMB_STEP + EMB_WINDOW) * 0.01
        yield emb[i:i + N_EMB].astype(np.float32), t


def load_wav_16k(path) -> np.ndarray:
    """Read a wav and return 16 kHz mono float32, resampling if needed."""
    import wave
    import audioop
    with wave.open(str(path), "rb") as w:
        n, ch, width, rate = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if ch > 1:
        raw = audioop.tomono(raw, width, 0.5, 0.5)
    if rate != SAMPLE_RATE:
        raw, _ = audioop.ratecv(raw, width, 1, rate, SAMPLE_RATE, None)
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[width]
    a = np.frombuffer(raw, dtype=dtype).astype(np.float32)
    return a / float(np.iinfo(dtype).max)
