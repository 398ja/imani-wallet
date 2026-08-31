// Run the real reader over the real staging attestation stream.
//
// The unit tests build their own events, so they prove the reader's LOGIC and
// nothing about the data actually being published. This is the other half: it
// fetches what the wallets have really written and reports what an auditor would
// see. A reader that passes its tests and rejects every live event is the exact
// failure this catches.
//
// Usage: node scripts/audit-probe.mjs [ledgerPubkeyHex]
//   RELAY_URL=wss://relay.staging.398ja.xyz (default)
import WebSocket from 'ws'

const url = process.env.RELAY_URL ?? 'wss://relay.staging.398ja.xyz'
const only = process.argv[2]

const { readAttestations, findDuplicates, summarise } = await import('../src/lib/audit.ts')

const ws = new WebSocket(url)
const events = []

ws.on('open', () => {
  const filter = { kinds: [7377], limit: 500 }
  if (only) filter.authors = [only]
  ws.send(JSON.stringify(['REQ', 'audit', filter]))
})

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg[0] === 'EVENT') events.push(msg[2])
  if (msg[0] !== 'EOSE') return

  const { accepted, rejected } = readAttestations(events)
  console.log(`relay: ${url}`)
  console.log(`fetched ${events.length}, audited ${accepted.length}, refused ${rejected.length}`)

  for (const r of rejected) console.log(`  REFUSED ${r.eventId.slice(0, 12)}… ${r.defect}`)

  const conflicts = findDuplicates(accepted).filter((d) => !d.benign)
  const benign = findDuplicates(accepted).filter((d) => d.benign)
  console.log(`duplicates: ${conflicts.length} conflicting, ${benign.length} republished`)
  for (const c of conflicts) console.log(`  CONFLICT ${c.nullifier.slice(0, 16)}…`)

  console.log('\nper ledger key:')
  for (const key of [...new Set(accepted.map((a) => a.ledgerPubkey))]) {
    const s = summarise(accepted, key)
    const last = s.lastAt ? new Date(s.lastAt).toISOString() : 'never'
    console.log(
      `  ${key.slice(0, 12)}…  ${String(s.redemptions).padStart(3)} redemptions  ` +
        `${s.units.join(',').padEnd(8)} conflicts=${s.conflicts}  last=${last}`,
    )
  }

  ws.close()
  process.exit(rejected.length > 0 || conflicts.length > 0 ? 1 : 0)
})

ws.on('error', (e) => {
  console.error('relay error:', e.message)
  process.exit(1)
})

setTimeout(() => {
  console.error('timed out waiting for EOSE')
  process.exit(1)
}, 15000)
