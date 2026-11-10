/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

import { CODE_ALPHABET, codeRef, normaliseSnapshotCode, snapshotCheckSymbol, displaySnapshotCode } from '../code'

function validCode(data: string): string {
  return data + snapshotCheckSymbol(data)
}

const SHA_OF_ZEROS = 'f120bb5698d520c5691b6d603a00bfd662d13bf177a04571f9d10c0745dfa2a5'

describe('snapshot code: local check (criterion 17, first half)', () => {
  it('accepts a valid code in any typed form', () => {
    const canon = validCode('7KQ4M2XD')
    const shown = displaySnapshotCode(canon)
    expect(shown).toMatch(/^SNAP-[0-9A-Z]{3}-[0-9A-Z]{3}-[0-9A-Z]{3}$/)
    for (const typed of [shown, shown.toLowerCase(), shown.replace(/-/g, ' '), canon, 'snap ' + canon.toLowerCase()]) {
      expect(normaliseSnapshotCode(typed)).toEqual({ ok: true, canonical: canon })
    }
  })

  it('maps look-alikes O to 0 and I/L to 1', () => {
    const canon = validCode('10K4M2XD')
    expect(normaliseSnapshotCode(canon.replace('1', 'I').replace('0', 'O'))).toEqual({ ok: true, canonical: canon })
  })

  it('every single-symbol substitution of a valid code fails the check', () => {
    const canon = validCode('7KQ4M2XD')
    for (let i = 0; i < canon.length; i++) {
      for (const c of CODE_ALPHABET) {
        if (c === canon[i]) continue
        const typo = canon.slice(0, i) + c + canon.slice(i + 1)
        expect(normaliseSnapshotCode(typo).ok, typo).toBe(false)
      }
    }
  })

  it('rejects wrong length and U', () => {
    expect(normaliseSnapshotCode('SNAP-7KQ-4M2')).toEqual({ ok: false, problem: 'shape' })
    expect(normaliseSnapshotCode('SNAP-UKQ-4M2-XD0').ok).toBe(false)
  })

  it('a mistyped code makes no network request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { validateSnapshotCode } = await import('../service')
    const canon = validCode('7KQ4M2XD')
    const typo = canon.slice(0, 8) + (canon[8] === '0' ? '1' : '0')
    await expect(validateSnapshotCode(typo)).rejects.toMatchObject({ kind: 'mistyped' })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('code_ref is sha256 hex of the canonical form', () => {
    // sha256("000000000"), computed independently with `printf 000000000 | sha256sum`.
    expect(codeRef('000000000')).toBe(SHA_OF_ZEROS)
    expect(codeRef(validCode('7KQ4M2XD'))).toMatch(/^[0-9a-f]{64}$/)
    expect(codeRef(validCode('7KQ4M2XD'))).not.toBe(codeRef(validCode('7KQ4M2XE')))
  })
})
