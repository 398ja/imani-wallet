/**
 * @vitest-environment node
 *
 * #591 criterion 7 and contract C1/C5: the fleet build profile of the #589 builder.
 */
import { describe, expect, it } from 'vitest'
import { unzipSync, strToU8, zipSync, strFromU8 } from 'fflate'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { buildSnapshot, finalScan, SnapshotLeakError } from '../../snapshot/build'
import { verifyArchive } from '../../snapshot/verify'
import type { SnapshotSigner } from '../../snapshot/types'
import { baseOptions, CANARY, FRIEND, FRIEND_NPUB, PII, SELF, SELF_NPUB, STALL, STALL_NPUB, TERMINAL, seededSources } from '../../snapshot/__tests__/fixtures'
import { absent, archiveText, forms } from './helpers'

const fleetKey = generateSecretKey()
const FLEET = getPublicKey(fleetKey)
const fleetSigner: SnapshotSigner = { pubkey: FLEET, signEvent: async (t) => finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, fleetKey) }
const ROUND = 'F202611092200'
// The seeded ledger is dated 2025-11-09; a 7-day window must be measured from just after it.
const NOW = 1762786800 * 1000

function fleetOptions(over: Record<string, unknown> = {}) {
  return { ...baseOptions(), ticket: ROUND, signer: fleetSigner, now: NOW, fleet: { round: ROUND, historyDays: 7 }, ...over }
}

describe('criterion 7: the fleet build', () => {
  it('never has memos even with includeMemos true, and says so in the manifest', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources({ memo: 'thanks Ottoline Brackenridge' }), fleetOptions({ includeMemos: true }))
    const { all, files } = archiveText(zip)
    expect(Object.keys(files)).not.toContain('envelope/operator_only/memos.json')
    expect(all).not.toContain('Ottoline')
    expect(manifest.redaction.memos_included).toBe(false)
    const tx = JSON.parse(files['data/transactions.json'])
    for (const r of tx.rows) expect(r.memo_summary).toBeUndefined()
  })

  it('carries reason "fleet" and the round, in the manifest and the signed tags', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources(), fleetOptions())
    expect(manifest.reason).toBe('fleet')
    expect(manifest.round).toBe(ROUND)
    expect(manifest.ticket_id).toBe(ROUND)
    const sig = JSON.parse(archiveText(zip).files['envelope/manifest.sig.json'])
    expect(sig.pubkey).toBe(FLEET)
    expect(manifest.wallet_pubkey).toBe(FLEET)
  })

  it('has empty correlation entries', async () => {
    const { zip } = await buildSnapshot(seededSources(), fleetOptions())
    expect(JSON.parse(archiveText(zip).files['envelope/correlation.json'])).toEqual({ v: 1, entries: {} })
  })

  it('trims history to history_days', async () => {
    const s = seededSources()
    // One row 30 days before "now", one inside the window.
    const now = NOW
    s.transactions.push({ id: 'tx-old', type: 'received', direction: 'in', timestamp: Math.floor(now / 1000) - 30 * 86400, amount: 1, face_unit: 'eur' } as never)
    const { zip, manifest } = await buildSnapshot(s, fleetOptions({ fleet: { round: ROUND, historyDays: 7 } }))
    const rows = JSON.parse(archiveText(zip).files['data/transactions.json']).rows
    expect(rows.length).toBe(3)
    expect(manifest.truncated?.rows_omitted).toBeGreaterThanOrEqual(1)
  })

  it('the wallet pubkey and npub appear nowhere in the archive, in any form', async () => {
    const { zip } = await buildSnapshot(seededSources(), fleetOptions({ includeMemos: true }))
    const hit = absent(archiveText(zip).all, [SELF, SELF_NPUB])
    expect(hit).toBeNull()
    // and the bytes of the zip itself (uncompressed entries could carry it)
    expect(absent(strFromU8(zip, true), [SELF, SELF_NPUB])).toBeNull()
  })

  it('verify accepts a fleet archive and a ticket archive', async () => {
    const f = await buildSnapshot(seededSources(), fleetOptions())
    expect(verifyArchive(f.zip).ok).toBe(true)
    const t = await buildSnapshot(seededSources(), baseOptions())
    expect(verifyArchive(t.zip).ok).toBe(true)
    expect(t.manifest.reason).toBeUndefined()
    expect(t.manifest.round).toBeUndefined()
  })

  it('verify refuses a fleet archive that carries memos or correlation entries', async () => {
    const f = await buildSnapshot(seededSources(), fleetOptions())
    const files = unzipSync(f.zip)
    const resign = async (extra: Record<string, string>) => {
      const all: Record<string, Uint8Array> = { ...files }
      for (const [k, v] of Object.entries(extra)) all[k] = strToU8(v)
      const m = JSON.parse(strFromU8(all['envelope/manifest.json']))
      for (const k of Object.keys(extra)) m.files[k] = bytesToHex(sha256(all[k]))
      const mt = JSON.stringify(m, null, 1)
      all['envelope/manifest.json'] = strToU8(mt)
      const old = JSON.parse(strFromU8(all['envelope/manifest.sig.json']))
      all['envelope/manifest.sig.json'] = strToU8(JSON.stringify(await fleetSigner.signEvent({ kind: old.kind, created_at: old.created_at, tags: old.tags, content: bytesToHex(sha256(strToU8(mt))) })))
      return zipSync(all)
    }
    const memos = await resign({ 'envelope/operator_only/memos.json': '{"v":1,"memos":{}}' })
    expect(verifyArchive(memos)).toEqual({ ok: false, reason: 'fleet_memos' })
    const corr = await resign({ 'envelope/correlation.json': '{"v":1,"entries":{"self":"ab"}}' })
    expect(verifyArchive(corr)).toEqual({ ok: false, reason: 'fleet_correlation' })
  })
})

describe('criterion 7: the #589 privacy tests, against a fleet build', () => {
  it('criterion 1: no canary in any encoding anywhere', async () => {
    const { zip } = await buildSnapshot(seededSources(), fleetOptions({ includeMemos: true }))
    const { all } = archiveText(zip)
    for (const [name, value] of Object.entries(CANARY)) for (const f of forms(value)) expect(all.includes(f), `canary ${name}`).toBe(false)
  })

  it('criterion 21: no real identifier or PII reaches data/', async () => {
    const { zip } = await buildSnapshot(seededSources(), fleetOptions({ includeMemos: true }))
    const { data } = archiveText(zip)
    const forbidden = [SELF, SELF_NPUB, STALL, STALL_NPUB, FRIEND, FRIEND_NPUB, TERMINAL, FLEET, ...Object.values(PII), CANARY.email]
    expect(absent(data, forbidden)).toBeNull()
    expect(data).toMatch(/"self"/)
    expect(data).toMatch(/stall#1/)
  })

  it('criterion 11: no K value anywhere, because there are none, and data/ is still pseudonymised', async () => {
    const opts = fleetOptions()
    const { zip } = await buildSnapshot(seededSources(), opts)
    const { files, all } = archiveText(zip)
    const { correlate } = await import('../../snapshot/ids')
    expect(all).not.toContain(correlate(opts.kCorr, PII.sendId))
    expect(all).not.toContain(correlate(opts.kCorr, SELF))
    expect(files['data/transactions.json']).toMatch(/send#1/)
  })

  it('criterion 22: an identifier injected into data/ aborts a fleet build too', async () => {
    await expect(buildSnapshot(seededSources(), fleetOptions({
      afterData: (files: Record<string, string>) => {
        files['data/errors.json'] = files['data/errors.json'].replace('"rows"', `"x":"${STALL}","rows"`)
      },
    }))).rejects.toBeInstanceOf(SnapshotLeakError)
    expect(() => finalScan({ 'data/x.json': '{"a":"mail me at x@y.example.com"}' }, [])).toThrow(SnapshotLeakError)
  })
})
