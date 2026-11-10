/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate'
import { base64 } from '@scure/base'
import { bech32 } from '@scure/base'
import { nip19, verifyEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { buildSnapshot, SnapshotLeakError, finalScan, MAX_SNAPSHOT_BYTES } from '../build'
import { decryptSnapshot, encryptSnapshot } from '../crypto'
import { verifyArchive } from '../verify'
import {
  baseOptions, CANARY, FRIEND, FRIEND_NPUB, PII, SELF, SELF_NPUB, STALL, STALL_NPUB, TERMINAL,
  seededSources,
} from './fixtures'

const enc = new TextEncoder()

/** Every encoding a secret could hide in: verbatim, lowercase, hex of its bytes, base64, base64url. */
function forms(value: string): string[] {
  const bytes = enc.encode(value)
  const out = [value, value.toLowerCase(), bytesToHex(bytes), base64.encode(bytes), base64.encode(bytes).replace(/=+$/, '')]
  if (/^[0-9a-f]{64}$/.test(value)) {
    out.push(nip19.npubEncode(value), nip19.noteEncode(value))
  }
  if (value.startsWith('npub1') || value.startsWith('nsec1')) {
    const words = bech32.decode(value as `${string}1${string}`, 1000).words
    out.push(bytesToHex(bech32.fromWords(words)))
  }
  return out.filter((f) => f.length >= 8)
}

function archiveText(zip: Uint8Array): { all: string; data: string; files: Record<string, string> } {
  const files = Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]))
  const all = Object.values(files).join('\n')
  const data = Object.entries(files).filter(([k]) => k.startsWith('data/')).map(([, v]) => v).join('\n')
  return { all, data, files }
}

describe('criterion 1: no secret survives', () => {
  it('none of the canary values, in any encoding, appears anywhere in the archive', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const { all } = archiveText(zip)
    for (const [name, value] of Object.entries(CANARY)) {
      for (const f of forms(value)) {
        expect(all.includes(f), `canary ${name} leaked as ${f.slice(0, 24)}`).toBe(false)
      }
    }
  })

  it('the archive also never carries the raw proof secret or C', async () => {
    const sources = seededSources()
    sources.vouchers[0] = { ...sources.vouchers[0], proofs: [{ secret: CANARY.proofSecret, C: CANARY.proofC, amount: 4 }] } as never
    const { zip } = await buildSnapshot(sources, baseOptions())
    const { all } = archiveText(zip)
    expect(all).not.toContain('canaryproofnonce0001')
    expect(all).not.toContain(CANARY.proofC)
  })
})

describe('criterion 21: AI-safe data layer', () => {
  it('no real identifier or PII reaches data/, each becomes a pseudonym or placeholder', async () => {
    const { zip } = await buildSnapshot(seededSources(), { ...baseOptions(), includeMemos: true })
    const { data, files } = archiveText(zip)
    const forbidden = [SELF, SELF_NPUB, STALL, STALL_NPUB, FRIEND, FRIEND_NPUB, TERMINAL, ...Object.values(PII), CANARY.email]
    for (const v of forbidden) {
      for (const f of forms(v)) expect(data.includes(f), `leaked ${v.slice(0, 20)} as ${f.slice(0, 20)}`).toBe(false)
    }
    expect(data).toMatch(/"self"/)
    expect(data).toMatch(/stall#1/)
    expect(data).toMatch(/send#1/)
    expect(data).toMatch(/terminal#1/)
    // Memo opted in: it is present, scrubbed to placeholders.
    const tx = JSON.parse(files['data/transactions.json'])
    const memo: string = tx.rows.find((r: { send?: string }) => r.send)?.memo
    expect(memo).toContain('<email>')
    expect(memo).toContain('<card>')
    expect(memo).toContain('<address>')
  })

  it('coarsens the fingerprint: user agent family, language only, rounded storage', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const env = JSON.parse(archiveText(zip).files['data/environment.json'])
    expect(env.browser).toBe('Chrome 131 / Android')
    expect(env.language).toBe('nl')
    expect(env.storage_usage_mb).toBe(12)
    expect(JSON.stringify(env)).not.toContain('Pixel')
  })
})

describe('criterion 11: public ids and K values', () => {
  it('no K value appears in data/, and support finds a known send_id via k_corr and the map', async () => {
    const opts = baseOptions()
    const { zip } = await buildSnapshot(seededSources(), opts)
    const { files, data } = archiveText(zip)
    const corr = JSON.parse(files['envelope/correlation.json']).entries as Record<string, string>
    for (const k of Object.values(corr)) expect(data).not.toContain(k)
    const { correlate } = await import('../ids')
    const k = correlate(opts.kCorr, PII.sendId)
    const pseudonym = Object.entries(corr).find(([, v]) => v === k)?.[0]
    expect(pseudonym).toMatch(/^send#\d+$/)
    // Without k_corr, a different key does not find it.
    expect(Object.values(corr)).not.toContain(correlate(new Uint8Array(32).fill(1), PII.sendId))
  })
})

describe('criteria 2 and 3: inventory', () => {
  it('unknown keys are reported by name and size only', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources(), baseOptions())
    const unknown = manifest.redaction.unknown_keys
    expect(unknown).toContainEqual({ key: 'some-third-party-key', bytes: expect.any(Number) })
    // The key NAME carries the pubkey suffix; the inventory reduces it to the prefix.
    expect(unknown.map((u) => u.key)).toContain('imani-wallet:brand-new-feature:<pubkey>')
    expect(archiveText(zip).all).not.toContain('opaque value')
  })
})

describe('criterion 4: signature and tamper', () => {
  it('manifest hashes match, the signature verifies, any tampered byte fails', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources(), baseOptions())
    const files = unzipSync(zip)
    for (const [path, h] of Object.entries(manifest.files)) {
      expect(bytesToHex(sha256(files[path]))).toBe(h)
    }
    const sig = JSON.parse(strFromU8(files['envelope/manifest.sig.json']))
    expect(verifyEvent(sig)).toBe(true)
    expect(sig.pubkey).toBe(SELF)
    expect(sig.content).toBe(bytesToHex(sha256(files['envelope/manifest.json'])))
    expect(verifyArchive(zip).ok).toBe(true)

    for (const path of Object.keys(files)) {
      const copy = { ...files }
      const b = new Uint8Array(copy[path])
      b[Math.floor(b.length / 2)] ^= 1
      copy[path] = b
      expect(verifyArchive(zipSync(copy)).ok, `tamper ${path}`).toBe(false)
    }
  })

  it('a signature by another key fails', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const files = unzipSync(zip)
    const sig = JSON.parse(strFromU8(files['envelope/manifest.sig.json']))
    sig.pubkey = STALL
    files['envelope/manifest.sig.json'] = strToU8(JSON.stringify(sig))
    expect(verifyArchive(zipSync(files)).ok).toBe(false)
  })
})

describe('criterion 5: AES-256-GCM', () => {
  it('round-trips, and the ciphertext contains no plaintext', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const sealed = await encryptSnapshot(zip)
    expect(sealed.key.length).toBe(32)
    expect(sealed.iv.length).toBe(12)
    expect(sealed.sha256).toBe(bytesToHex(sha256(sealed.ciphertext)))
    expect(strFromU8(sealed.ciphertext, true)).not.toContain('envelope/')
    expect(await decryptSnapshot(sealed.ciphertext, sealed.key, sealed.iv)).toEqual(zip)
    const bad = new Uint8Array(sealed.ciphertext)
    bad[0] ^= 1
    await expect(decryptSnapshot(bad, sealed.key, sealed.iv)).rejects.toThrow()
  })
})

describe('criterion 10: determinism', () => {
  it('same data, same key and salt, same time: identical data/ and manifest file hashes', async () => {
    const a = await buildSnapshot(seededSources(), baseOptions())
    const b = await buildSnapshot(seededSources(), baseOptions())
    const fa = archiveText(a.zip).files
    const fb = archiveText(b.zip).files
    for (const k of Object.keys(fa).filter((x) => x.startsWith('data/'))) expect(fa[k]).toBe(fb[k])
    expect(a.manifest.files).toEqual(b.manifest.files)
  })
})

describe('criterion 12: Stall vs Customer', () => {
  it('a Stall snapshot has Takings and Terminals, a Customer one has neither', async () => {
    const stall = archiveText((await buildSnapshot(seededSources({ stall: true }), baseOptions())).zip)
    const cust = archiveText((await buildSnapshot(seededSources({ stall: false }), baseOptions())).zip)
    const sd = JSON.parse(stall.files['data/derived.json'])
    const cd = JSON.parse(cust.files['data/derived.json'])
    expect(sd.stall.terminals.length).toBe(1)
    expect(sd.stall.takings).toBeDefined()
    expect(cd.stall).toBeUndefined()
    expect(cust.data).not.toContain('terminal#')
  })
})

describe('criterion 15: size budget', () => {
  it('a Stall whose snapshot would exceed the cap is trimmed by whole days of ledger only', async () => {
    const sources = seededSources()
    const day = 86400
    const base = 1762700000
    sources.transactions = Array.from({ length: 6000 }, (_, i) => ({
      id: 'bulk-' + i, type: 'payment', direction: 'in', timestamp: base - Math.floor(i / 200) * day, amount: i, face_unit: 'eur',
      counterparty: FRIEND,
    })) as never
    const cap = 120_000
    const { zip, manifest } = await buildSnapshot(sources, { ...baseOptions(), maxBytes: cap })
    expect(zip.length).toBeLessThanOrEqual(cap)
    expect(manifest.truncated).not.toBeNull()
    expect(manifest.truncated!.rows_omitted).toBeGreaterThan(0)
    expect(manifest.truncated!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const files = archiveText(zip).files
    const v = JSON.parse(files['data/vouchers.json'])
    expect(v.rows.length).toBe(2)
    const d = JSON.parse(files['data/derived.json'])
    expect(d.money_in_flight.pending_sends.count).toBe(1)
    // Kept rows are all on or after the since day, whole days.
    const tx = JSON.parse(files['data/transactions.json'])
    const since = Date.parse(manifest.truncated!.since + 'T00:00:00Z') / 1000
    expect(tx.rows.every((r: { timestamp: number }) => r.timestamp >= since)).toBe(true)
  })

  it('the default cap is 20 MB', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe('criterion 22: fail closed', () => {
  it('a real identifier injected into data/ after build aborts with a reportable error', async () => {
    const sources = seededSources()
    let thrown: unknown
    try {
      await buildSnapshot(sources, {
        ...baseOptions(),
        afterData: (files) => {
          files['data/errors.json'] = files['data/errors.json'].replace('"rows"', `"x":"${STALL}","rows"`)
        },
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SnapshotLeakError)
    const err = thrown as SnapshotLeakError
    expect(err.file).toBe('data/errors.json')
    expect(err.kind).toBe('identifier')
    // The reportable error itself does not repeat the value it found.
    expect(err.message).not.toContain(STALL)
  })

  it('a PII pattern injected also aborts', () => {
    expect(() => finalScan({ 'data/x.json': '{"a":"mail me at x@y.example.com"}' }, [])).toThrow(SnapshotLeakError)
    expect(() => finalScan({ 'data/x.json': '{"a":"nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"}' }, [])).toThrow(SnapshotLeakError)
    expect(() => finalScan({ 'data/x.json': '{"a":"send#1"}' }, [])).not.toThrow()
  })
})
