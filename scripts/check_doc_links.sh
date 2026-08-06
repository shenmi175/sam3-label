#!/usr/bin/env bash
# Verify that relative links in docs/wiki/*.md and the root README resolve to
# existing files. External URLs and anchor-only links are skipped.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

files=("$ROOT_DIR/README.md")
if [[ -d "$ROOT_DIR/docs/wiki" ]]; then
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$ROOT_DIR/docs/wiki" -maxdepth 1 -name '*.md' -print0 | sort -z)
fi

fail=0
for md in "${files[@]}"; do
  [[ -f "$md" ]] || continue
  dir="$(dirname "$md")"
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    case "$target" in
      http://*|https://*|mailto:*|\#*) continue ;;
    esac
    path="${target%%#*}"
    [[ -n "$path" ]] || continue
    if [[ ! -e "$dir/$path" ]]; then
      echo "dead link in ${md#$ROOT_DIR/}: $target"
      fail=1
    fi
  done < <(grep -oE '\]\([^)]+\)' "$md" | sed -E 's/^\]\(//; s/\)$//')
done

if [[ "$fail" -ne 0 ]]; then
  echo "Documentation link check failed."
  exit 1
fi
echo "Documentation links OK."
