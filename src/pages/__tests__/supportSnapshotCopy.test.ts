import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Found in the local e2e (#589): JSX text does not interpret escapes, so "Uploading\u2026" rendered
// with a literal backslash-u. Escapes are fine inside JS strings, never in JSX text between tags.
describe('SupportSnapshotPage copy', () => {
  it('has no unicode escape sequence in JSX text', () => {
    const src = readFileSync('src/pages/SupportSnapshotPage.tsx', 'utf8')
    const jsxText = [...src.matchAll(/>([^<>{}]*)</g)].map((m) => m[1]).filter((t) => t.trim())
    expect(jsxText.filter((t) => /\\u[0-9a-fA-F]{4}/.test(t))).toEqual([])
  })
})
