#!/usr/bin/env bash
# Pre-commit hook: block commits with type casts (as, @ts-ignore, @ts-expect-error)
# that don't have a // JUSTIFIED: comment on the same or preceding line.
#
# Install: cp scripts/check-type-casts.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or add to existing pre-commit: source scripts/check-type-casts.sh
#
# Exit codes:
#   0 — commit allowed
#   1 — commit blocked (unjustified type cast found)

set -euo pipefail

echo "▶ pre-commit: checking for unjustified type casts..."

# Get staged .ts/.tsx files
staged_files=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)

if [ -z "$staged_files" ]; then
  echo "  no .ts/.tsx files staged, skipping"
  exit 0
fi

errors=0

for file in $staged_files; do
  # Skip files that don't exist (deleted)
  [ ! -f "$file" ] && continue

  # Get the staged version of the file
  content=$(git show ":$file" 2>/dev/null || true)
  [ -z "$content" ] && continue

  # Check each line for type casts
  line_num=0
  prev_line=""
  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Check for @ts-ignore or @ts-expect-error
    if echo "$line" | grep -qE '@ts-ignore|@ts-expect-error'; then
      if ! echo "$line" | grep -q 'JUSTIFIED' && ! echo "$prev_line" | grep -q 'JUSTIFIED'; then
        echo "  ✗ $file:$line_num — @ts-ignore/@ts-expect-error without // JUSTIFIED:"
        errors=$((errors + 1))
      fi
    fi

    # Check for `as` type casts (as SomeType, as { ... }, as import(...))
    # Exclude: the word "as" in strings/comments, "as const", "as const" is fine
    if echo "$line" | grep -qE '\bas\s+[A-Z{]'; then
      # Skip if it's in a comment line
      if ! echo "$line" | grep -qE '^\s*//|^\s*\*|^\s*/\*'; then
        if ! echo "$line" | grep -q 'JUSTIFIED' && ! echo "$prev_line" | grep -q 'JUSTIFIED'; then
          echo "  ✗ $file:$line_num — type cast 'as ...' without // JUSTIFIED:"
          errors=$((errors + 1))
        fi
      fi
    fi

    prev_line="$line"
  done <<< "$content"
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
