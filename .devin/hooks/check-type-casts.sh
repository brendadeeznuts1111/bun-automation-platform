#!/usr/bin/env bash
# PreToolUse hook: block edits/writes that contain type casts without justification.
#
# Reads the hook event JSON from stdin, extracts the new content, and checks
# for `as` type casts, @ts-ignore, or @ts-expect-error without a // JUSTIFIED:
# comment on the same or preceding line.
#
# Exit codes:
#   0 — allow the edit
#   2 — block the edit (type cast without justification)

set -euo pipefail

# Read the hook event from stdin and process with python3 for reliable JSON
# parsing and multi-line content handling.
python3 -c "
import sys, json, re

try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)  # Can't parse JSON — allow the edit

tool_input = data.get('tool_input', {})
content = tool_input.get('new_string') or tool_input.get('content') or ''
if not content:
    sys.exit(0)

lines = content.split('\n')
violations = []
prev_line = ''

for i, line in enumerate(lines):
    # Check for @ts-ignore or @ts-expect-error
    if '@ts-ignore' in line or '@ts-expect-error' in line:
        if 'JUSTIFIED' not in line and 'JUSTIFIED' not in prev_line:
            violations.append(f'  - Line {i+1}: @ts-ignore/@ts-expect-error without // JUSTIFIED:')

    # Check for type casts: 'as' followed by a capital letter, {, or import
    stripped = line.lstrip()
    if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
        prev_line = line
        continue

    if re.search(r'\bas\s+[A-Z{]', line) or 'as import(' in line:
        if 'JUSTIFIED' not in line and 'JUSTIFIED' not in prev_line:
            violations.append(f'  - Line {i+1}: type cast (as ...) without // JUSTIFIED:')

    prev_line = line

if violations:
    reason = 'Type cast detected without // JUSTIFIED: comment. Read node_modules/bun-types/bun.d.ts and docs (node_modules/bun-types/docs/) before using type casts. Every type cast must have a // JUSTIFIED: comment. Violations:\\n' + '\\n'.join(violations)
    print(json.dumps({'decision': 'block', 'reason': reason}))
    sys.exit(2)

sys.exit(0)
"
