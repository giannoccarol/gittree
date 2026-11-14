#!/usr/bin/env bash
# Render the application icon from build/icon.svg into icon.png (1024 px, used by the app,
# the README and electron-builder) and every hicolor size in build/icons/ for Linux packages.
# Each size is rendered from the vector source, so small icons stay sharp.
# Requires rsvg-convert (librsvg).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=build/icon.svg
for size in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "build/icons/${size}x${size}.png"
done
cp build/icons/1024x1024.png icon.png
cp icon.png build/icon.png
echo "Rendered icon.png and build/icons/*.png from $SRC"
