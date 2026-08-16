# Bun.markdown.react() React 18/19 Deep Audit Report

**Reference ID:** `REF-REACT-18`

**Bun version:** 1.3.14

**Test file:** `tests/react-version-deep.test.ts`

**Date:** 2026-08-15

## Executive Summary

| Metric | Value |
|--------|-------|
| Tests in audit file | 216 |
| Failures | 0 |
| `expect()` calls | 508 |
| Repo total tests | 2228 |
| Typecheck | clean |

This deep audit verifies `Bun.markdown.react()` output across React 18 and React 19 symbol formats. All 211 tests pass.

## What was tested

| Category | Tests | Key areas |
|----------|-------|-----------|
| REF-REACT-18 reference | 4 | React 18.3.1 pinned, symbol comparison |
| `reactVersion` threshold | 14 | `< 19` → `react.element`, `>= 19` → `transitional.element` |
| Non-number `reactVersion` | 5 | string, null, undefined, negative, zero fallback |
| Nested element consistency | 3 | All elements share root `$$typeof` |
| Element structure identity | 4 | Deep compare excluding `$$typeof` |
| Fragment type | 1 | Both use `Symbol(react.fragment)` |
| `structuredClone` (Bug 14) | 2 | Fails on both versions due to uncloneable Symbols |
| JSON stringify | 2 | Different output, roundtrip loses Symbols |
| Element properties | 9 | 5 keys, `key`/`ref` null, no `_owner`/`_store`, not frozen |
| Symbol registration | 3 | `Symbol.for()` / `Symbol.keyFor()` verified |
| Custom components | 22 | Bun does not call fn, uses as `type`, all 24 tags customizable |
| `React.isValidElement` | 3 | React 19 rejects `react.element` |
| `renderToString` | 4 | Works with default, fails with `reactVersion: 18` |
| Performance | 1 | Within 20% of each other |
| Element types & props | 22 | h1-h6, p, strong, em, code, a, img, ul, ol, li, blockquote, pre, hr, table |
| Input types | 5 | null/number/object throw; Uint8Array/ArrayBuffer work |
| Malformed markdown | 5 | 7#→p, bad table→p, unclosed code→pre, empty, 100k chars |
| Unicode / special content | 3 | CJK, emoji, mixed `\r\n` |
| GFM extensions | 3 | Strikethrough→del, autolinks, footnote→a |
| Key field | 9 | All elements get `key: null` |
| ref field | 3 | All elements get `ref: null` |
| Text nodes | 5 | Plain strings, whitespace, code newlines |
| Hard line breaks | 5 | `br` element for hard breaks only |
| Link / image edge cases | 5 | Auto-link, empty text, reference links, nested formatting |
| Custom component props | 13 | href, src, alt, title, checked, language, id, extensible props object |
| Parser options | 14 | strikethrough, tables, tasklists, autolinks, wikiLinks, noIndentedCodeBlocks, noHtmlBlocks, headings |
| SSR `renderToString` | 22 | All element types render correctly with React 19 |
| Tags, lists, and meta | 16 | `start`, `checked`, `align`, `href`, `src`, `title`, `id`, `language` |
| tagFilter deep dive | 5 | `<script>`, `<style>`, `<iframe>` not escaped in v1.3.14 |
| React 18 vs 19 cross-check | 10 | Structure identical across 10 features, only `$$typeof` differs |

## Critical findings

### 1. React 19 cannot render React 18 elements

- `React.isValidElement()` (19.2.8) returns `false` for `Symbol(react.element)`
- `renderToString()` throws `Objects are not valid as a React child` with `reactVersion: 18`
- **Implication:** Only use `reactVersion: 18` if you are actually running React 18.x

### 2. Custom component behavior

- `Bun.markdown.react()` does **not** call component functions
- The function is stored as the element's `type` field
- React calls the component during rendering
- Custom component elements get the same `$$typeof` as the root tree (no mixing)
- Props object is extensible, not frozen
- `children` is always an array, even for a single child

### 3. SSR escapes raw HTML blocks

Raw HTML blocks (e.g. `<div class="foo">text</div>`) are wrapped in a custom `<html>` element and the raw string is escaped by `renderToString`. They are not rendered as actual DOM.

### 4. `tagFilter: true` does not filter

The `tagFilter` parser option does not escape or disallow `<script>`, `<style>`, `<iframe>`, or `<div>` content in Bun 1.3.14. The dangerous tags remain as raw strings inside custom `<html>` elements. This is a documented gap.

### 5. Parser options that do not change output

| Option | Expected | Actual |
|--------|----------|--------|
| `underline: true` | `__text__` → `<u>` | Still `<strong>` |
| `latexMath: true` | `$x^2$` → math | Still plain text |
| `hardSoftBreaks: true` | Soft breaks → `<br>` | No change |
| `tagFilter: true` | Disallowed tags escaped | No change |

## React 18 vs 19: the only difference

For every feature tested, the **only** structural difference is the `$$typeof` symbol:

- React 19 default: `Symbol(react.transitional.element)`
- React 18 (`reactVersion: 18`): `Symbol(react.element)`

Type names, props, children, keys, refs, and order are identical. Normalized JSON of the full tree matches byte-for-byte.

## Conclusion

`Bun.markdown.react()` is consistent between React 18 and React 19 output. The audit provides a reliable baseline under `REF-REACT-18`. The main caveats are:

1. Do not mix `reactVersion: 18` output with React 19 rendering
2. `tagFilter` is not currently effective
3. Some parser options (`underline`, `latexMath`, `hardSoftBreaks`) have no observable effect

## References

- Test source: `tests/react-version-deep.test.ts`
- Bug/docs: `docs/render-diagrams.ts`
- Bug 14: `structuredClone` of React elements throws
