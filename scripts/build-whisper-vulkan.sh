#!/usr/bin/env bash
# Build a GPU-accelerated (Vulkan) whisper.cpp runtime for cue and install it to
# ~/.config/cue/whisper-runtime-gpu. cue auto-detects and prefers it (see
# src/whisper-runtime.js). Vulkan works on NVIDIA, AMD and Intel GPUs alike and
# needs no CUDA toolkit — just the Vulkan headers + glslc.
#
#   Arch:   sudo pacman -S --needed vulkan-headers shaderc cmake
#   Debian: sudo apt install libvulkan-dev glslc cmake
set -euo pipefail
TAG="${WHISPER_TAG:-v1.9.1}"   # matches the version cue bundles
DEST="${CUE_GPU_RUNTIME_DIR:-$HOME/.config/cue/whisper-runtime-gpu}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> fetching whisper.cpp $TAG"
git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggerganov/whisper.cpp "$WORK/whisper.cpp"
cd "$WORK/whisper.cpp"

echo "==> configuring (Vulkan)"
cmake -B build -DGGML_VULKAN=ON -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON >/dev/null
echo "==> building (this takes a few minutes)"
cmake --build build --config Release --target whisper-server -j"$(nproc)" >/dev/null

echo "==> installing to $DEST"
mkdir -p "$DEST"
cp build/bin/whisper-server "$DEST/"
# every shared lib the binary needs, in one flat dir (cue sets LD_LIBRARY_PATH to it)
find build -name 'libwhisper*.so*' -o -name 'libggml*.so*' | xargs -I{} cp -P {} "$DEST/"
printf '{\n  "name": "whisper.cpp",\n  "version": "%s",\n  "target": "linux-x64",\n  "backend": "vulkan"\n}\n' "${TAG#v}" > "$DEST/runtime.json"
chmod +x "$DEST/whisper-server"
echo "==> done. Restart cue; Settings -> Audio will show 'vulkan' as the runtime backend."
