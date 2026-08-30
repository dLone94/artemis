#!/usr/bin/env bash
# Install local speech-to-text for Artemis: whisper.cpp + one GGML model.
#
# Explicit on purpose. Artemis NEVER downloads a speech model during a voice
# session — a missing model surfaces as a setup state, and this script is how
# you resolve it. Everything lands in a predictable Artemis location and the
# download size is printed before anything is fetched.
#
#   npm run setup:stt              # balanced (default, ~148 MB)
#   npm run setup:stt -- fast      # ~75 MB
#   npm run setup:stt -- accurate  # ~488 MB
set -euo pipefail

TIER="${1:-balanced}"
case "$TIER" in
  fast)     MODEL="ggml-tiny.bin";  SIZE="~75 MB" ;;
  balanced) MODEL="ggml-base.bin";  SIZE="~148 MB" ;;
  accurate) MODEL="ggml-small.bin"; SIZE="~488 MB" ;;
  *) echo "unknown tier '$TIER' (use: fast | balanced | accurate)"; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
MODEL_DIR="${ARTEMIS_STT_MODEL_DIR:-${ARTEMIS_DATA_DIR:-$HOME/.artemis}/models/whisper}"
[ -n "${ARTEMIS_STT_MODEL_DIR:-}" ] || [ -n "${ARTEMIS_DATA_DIR:-}" ] || MODEL_DIR="$HOME/.artemis/models/whisper"
MODEL_PATH="$MODEL_DIR/$MODEL"

echo "Artemis · local speech setup"
echo "  tier      $TIER"
echo "  model     $MODEL  ($SIZE)"
echo "  location  $MODEL_PATH"
echo

# ---- 1. the engine -----------------------------------------------------------
# whisper.cpp is MIT-licensed and builds to one self-contained native binary,
# so it can ship inside a commercial Artemis build without a Python runtime.
if command -v whisper-cli >/dev/null 2>&1; then
  echo "✓ whisper-cli already on PATH ($(command -v whisper-cli))"
elif command -v brew >/dev/null 2>&1; then
  echo "→ installing whisper-cpp via Homebrew (Metal-accelerated on Apple Silicon)…"
  brew install whisper-cpp
  echo "✓ whisper-cli installed"
else
  echo "✗ Neither whisper-cli nor Homebrew was found."
  echo "  Install Homebrew (https://brew.sh) then re-run, or build whisper.cpp"
  echo "  yourself and point ARTEMIS_STT_BINARY at the binary."
  exit 1
fi

# ---- 2. the model ------------------------------------------------------------
if [ -f "$MODEL_PATH" ]; then
  echo "✓ model already present ($(du -h "$MODEL_PATH" | cut -f1))"
else
  mkdir -p "$MODEL_DIR"
  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  echo "→ downloading $MODEL ($SIZE) from huggingface.co…"
  # -f fails loudly on a 404 instead of writing an HTML error page as a model
  curl -fL --progress-bar -o "$MODEL_PATH.part" "$URL"
  mv "$MODEL_PATH.part" "$MODEL_PATH"
  echo "✓ model saved ($(du -h "$MODEL_PATH" | cut -f1))"
fi

# ---- 3. prove it actually transcribes ---------------------------------------
echo
echo "→ verifying with a locally generated tone…"
node "$ROOT/scripts/stt-selftest.mjs" "$MODEL_PATH" || {
  echo "✗ the engine did not run — check the messages above"
  exit 1
}

echo
echo "Done. Artemis can now hear you with the network off."
echo "Set the tier any time:  ARTEMIS_STT_TIER=$TIER"
[ "$TIER" = "balanced" ] || echo "Add ARTEMIS_STT_TIER=$TIER to .env to keep this tier."
