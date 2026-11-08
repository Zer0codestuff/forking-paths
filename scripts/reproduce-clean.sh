#!/usr/bin/env bash
# Reproduce an exported bundle with only the Python engine copied into an empty directory.
# Requires python3 with NumPy and SciPy. Usage: scripts/reproduce-clean.sh <bundle.json>
set -euo pipefail
bundle="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$root/engine/fpengine" "$work/fpengine"
cp "$bundle" "$work/bundle.json"
cd "$work"
echo "clean directory contains: $(ls)"
python3 -m fpengine reproduce bundle.json
