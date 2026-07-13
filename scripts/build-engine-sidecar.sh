#!/usr/bin/env bash
# Build an unpacked standalone engine. PyInstaller's onedir form starts materially faster
# than its self-extracting onefile form and removes the packaged app's Python/uv dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/desktop/src-tauri/binaries"
WORK="${TMPDIR:-/tmp}/macfleet-pyinstaller"

rm -rf "$OUT/macfleet-engine" "$WORK"
mkdir -p "$OUT" "$WORK"

uv run --extra dev --frozen pyinstaller \
  --noconfirm \
  --clean \
  --onedir \
  --optimize 1 \
  --exclude-module pygments \
  --exclude-module rich \
  --exclude-module setuptools \
  --exclude-module typer \
  --exclude-module wheel \
  --name macfleet-engine \
  --paths "$ROOT" \
  --distpath "$OUT" \
  --workpath "$WORK/build" \
  --specpath "$WORK" \
  "$ROOT/macfleet/sidecar.py"

"$OUT/macfleet-engine/macfleet-engine" --help >/dev/null
