#!/usr/bin/env python3
"""Check for unjustified type casts in TypeScript files.

Reads file content from stdin, prints violations (one per line) as:
  line_number: description

A type cast is 'as Type', 'as {', or 'as import(...)' that is NOT:
- Inside a string literal (detected by counting unescaped double-quotes)
- On a comment line (// or * or /*)
- Accompanied by a // JUSTIFIED: comment on the same or preceding line
"""

import sys
import re

lines = sys.stdin.read().split('\n')
prev_line = ''
violations = []

for i, line in enumerate(lines):
    # Check for @ts-ignore or @ts-expect-error
    if '@ts-ignore' in line or '@ts-expect-error' in line:
        if 'JUSTIFIED' not in line and 'JUSTIFIED' not in prev_line:
            violations.append(f'{i+1}: @ts-ignore/@ts-expect-error without // JUSTIFIED:')

    # Skip comment lines
    stripped = line.lstrip()
    if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
        prev_line = line
        continue

    # Check for type casts: 'as' followed by a capital letter, {, or import
    # But ONLY when 'as' is NOT inside a string literal
    for match in re.finditer(r'\bas\s+[A-Z{]|as\s+import\(', line):
        pos = match.start()
        # Count unescaped double-quotes before this position
        # If odd, we're inside a string literal — skip
        before = line[:pos]
        # Remove escaped quotes
        clean = before.replace('\\"', '')
        quote_count = clean.count('"')
        if quote_count % 2 == 1:
            continue  # Inside a string literal — not a type cast

        # Also skip if the entire line is a string array entry
        if re.match(r'^\s*"', line) and line.rstrip().endswith('",'):
            continue

        if 'JUSTIFIED' not in line and 'JUSTIFIED' not in prev_line:
            violations.append(f'{i+1}: type cast (as ...) without // JUSTIFIED:')
            break  # One violation per line is enough

    prev_line = line

for v in violations:
    print(v)
