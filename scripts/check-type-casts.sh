#!/usr/bin/env bash
# Pre-commit hook: block commits with type casts (as, @ts-ignore, @ts-expect-error)
# that don't have a // JUSTIFIED: comment on the same or preceding line.
#
# Uses Python (scripts/check-type-casts-py.py) for accurate string-literal
# detection — avoids false positives on English text like "as Unicode" or
# "as ANSI" inside string literals.
#
# Install: cp scripts/check-type-casts.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or add to existing pre-commit: source scripts/check-type-casts.sh
#
# Exit codes:
#   0 — commit allowed
#   1 — commit blocked (unjustified type cast found)

set -euo pipefail

echo "▶ pre-commit: checking for unjustified type casts..."

# Get staged .ts/.tsx files (including tests)
staged_files=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)

if [ -z "$staged_files" ]; then
  echo "  no .ts/.tsx files staged, skipping"
  exit 0
fi

errors=0
script_dir="$(cd "$(dirname "$0")" && pwd)"
py_checker="$script_dir/check-type-casts-py.py"

for file in $staged_files; do
  # Skip files that don't exist (deleted)
  [ ! -f "$file" ] && continue

  # Get the staged version of the file
  content=$(git show ":$file" 2>/dev/null || true)
  [ -z "$content" ] && continue

  # Run Python checker on the staged content
  violations=$(echo "$content" | python3 "$py_checker" 2>/dev/null || true)

  if [ -n "$violations" ]; then
    while IFS= read -r vline; do
      [ -z "$vline" ] && continue
      echo "  ✗ $file:$vline"
      errors=$((errors + 1))
    done <<< "$violations"
  fi
done

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "✗ pre-commit: $errors unjustified type cast(s) found."
  echo "  Every type cast must have a // JUSTIFIED: comment on the same"
  echo "  or preceding line explaining why the types are wrong."
  echo ""
  echo "  To fix: read node_modules/bun-types/bun.d.ts and redesign the"
  echo "  code to work within the actual type system."
  echo ""
  echo "  To bypass (emergency only): git commit --no-verify"
  exit 1
fi

echo "✓ pre-commit: no unjustified type casts found"
exit 0
