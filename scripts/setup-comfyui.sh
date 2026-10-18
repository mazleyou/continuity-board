#!/usr/bin/env bash
# Installs a pinned local ComfyUI and downloads the FLUX.2 [klein] 4B models used by Continuity Board.
#
#   COMFY_DIR     ComfyUI install location   (default: ~/ComfyUI-Installs/ComfyUI)
#   MODELS_DIR    model root                 (default: $COMFY_DIR/models)
#   COMFY_REF     ComfyUI commit to pin      (default: the version Continuity Board was verified with, ComfyUI 0.39.0)
#   WITH_BASE=1   also download FLUX.2 [klein] 4B Base (CB_PRESET=base, for quality comparison)
#   WITH_GGUF=1   also install ComfyUI-GGUF and Q8_0 GGUF weights (CB_PRESET=gguf, for low-memory machines)
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI-Installs/ComfyUI}"
MODELS_DIR="${MODELS_DIR:-$COMFY_DIR/models}"
COMFY_REF="${COMFY_REF:-e8665ca8e4089ab917567cdb491308e1397663d4}"
export PATH="$HOME/.local/bin:$PATH"

if git --version >/dev/null 2>&1; then
  [ -d "$COMFY_DIR/.git" ] || git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
  git -C "$COMFY_DIR" fetch --tags --quiet
  git -C "$COMFY_DIR" checkout --quiet "$COMFY_REF"
  git -C "$COMFY_DIR" rev-parse HEAD > "$COMFY_DIR/.continuity-board-ref"
elif [ "$(cat "$COMFY_DIR/.continuity-board-ref" 2>/dev/null)" != "$COMFY_REF" ]; then
  # No working git (e.g. macOS without Command Line Tools): fetch the pinned commit as a tarball.
  mkdir -p "$COMFY_DIR"
  curl -L --fail "https://codeload.github.com/comfyanonymous/ComfyUI/tar.gz/$COMFY_REF" | tar -xz --strip-components 1 -C "$COMFY_DIR"
  echo "$COMFY_REF" > "$COMFY_DIR/.continuity-board-ref"
fi

cd "$COMFY_DIR"
[ -d .venv ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

download() { # url dest
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -s "$dest" ]; then echo "exists: $dest"; return; fi
  curl -L --fail --retry 5 -C - -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

# Apple Silicon (MPS) cannot run fp8 weights, so Macs get the bf16 release of the same Apache-2.0 model.
if [ "$(uname -s)" = "Darwin" ]; then
  download "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/flux-2-klein-4b.safetensors" \
    "$MODELS_DIR/diffusion_models/flux-2-klein-4b.safetensors"
else
  download "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors" \
    "$MODELS_DIR/diffusion_models/flux-2-klein-4b-fp8.safetensors"
fi
download "https://huggingface.co/Comfy-Org/flux2-klein-4B/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" \
  "$MODELS_DIR/text_encoders/qwen_3_4b.safetensors"
download "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors" \
  "$MODELS_DIR/vae/flux2-vae.safetensors"

if [ "${WITH_BASE:-0}" = "1" ]; then
  download "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B/resolve/main/flux-2-klein-base-4b.safetensors" \
    "$MODELS_DIR/diffusion_models/flux-2-klein-base-4b.safetensors"
fi

if [ "${WITH_GGUF:-0}" = "1" ]; then
  GGUF_REF="${GGUF_REF:-6ea2651e7df66d7585f6ffee804b20e92fb38b8a}"
  if [ ! -f "$COMFY_DIR/custom_nodes/ComfyUI-GGUF/nodes.py" ]; then
    mkdir -p "$COMFY_DIR/custom_nodes/ComfyUI-GGUF"
    curl -L --fail "https://codeload.github.com/city96/ComfyUI-GGUF/tar.gz/$GGUF_REF" | tar -xz --strip-components 1 -C "$COMFY_DIR/custom_nodes/ComfyUI-GGUF"
  fi
  uv pip install --python .venv/bin/python -r "$COMFY_DIR/custom_nodes/ComfyUI-GGUF/requirements.txt"
  download "https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf" \
    "$MODELS_DIR/diffusion_models/flux-2-klein-4b-Q8_0.gguf"
  download "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q8_0.gguf" \
    "$MODELS_DIR/text_encoders/Qwen3-4B-Q8_0.gguf"
fi

if [ "$MODELS_DIR" != "$COMFY_DIR/models" ]; then
  cat > "$COMFY_DIR/extra_model_paths.yaml" <<EOF
continuity_board:
  base_path: $MODELS_DIR
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
EOF
fi

echo "ComfyUI ready at $COMFY_DIR (ref $(cat "$COMFY_DIR/.continuity-board-ref"))"
echo "Start it with: $COMFY_DIR/.venv/bin/python $COMFY_DIR/main.py --listen 127.0.0.1 --port 8188 --disable-smart-memory   (drop the flag on machines with >32GB memory)"
