#!/usr/bin/env bash
# Verify that external submodules are checked out and match the pinned SHAs.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SUBMODULES=(external/sam3 external/sapiens2)
GATE_FILES=(pyproject.toml pyproject.toml)

fail=0

if ! git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: $ROOT_DIR is not a Git working tree." >&2
  echo "Submodule state cannot be verified; use a source tree cloned with 'git clone --recursive'." >&2
  exit 1
fi

status="$(git -C "$ROOT_DIR" submodule status)"

for i in "${!SUBMODULES[@]}"; do
  path="${SUBMODULES[$i]}"
  gate="${GATE_FILES[$i]}"

  line="$(printf '%s\n' "$status" | awk -v p="$path" '$2 == p {print; exit}')"
  if [[ -z "$line" ]]; then
    echo "ERROR: $path is not registered as a submodule in .gitmodules" >&2
    fail=1
    continue
  fi

  recorded="${line:1:40}"
  flag="${line:0:1}"

  if [[ ! -f "$ROOT_DIR/$path/$gate" ]]; then
    echo "ERROR: $path is not checked out (missing $path/$gate)" >&2
    echo "       run: git submodule update --init --recursive $path" >&2
    fail=1
    continue
  fi

  actual="$(git -C "$ROOT_DIR/$path" rev-parse HEAD 2>/dev/null || echo '')"
  if [[ "$actual" != "$recorded" ]]; then
    echo "ERROR: $path SHA mismatch" >&2
    echo "       pinned:   $recorded" >&2
    echo "       checkout: ${actual:-<unreadable>}" >&2
    echo "       run: git submodule update --init --recursive $path" >&2
    fail=1
    continue
  fi

  dirty=""
  if [[ "$flag" == "+" ]]; then
    dirty=" (WARNING: recorded gitlink differs from index; commit the submodule pointer)"
  fi
  echo "OK: $path @ $actual$dirty"
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "All submodules match their pinned SHAs."
