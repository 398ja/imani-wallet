/**
 * Does a real A -> B transfer end in a published, verifiable kind-7378 receipt,
 * with B offline when A sends? (#98, the item left open after the delivery
 * probe; ADR 0014 "Delivery")
 *
 * `probe-transfer-signature-delivery.mts` showed the signature WRAP reaches an
 * offline recipient's catch-up once it is mirrored. This closes the loop on
 * what happens next, running the wallet's OWN code on both sides against a
 * live gateway and relay rather than a hand-built wrap:
 *
 *   1. A (sender, throwaway key) runs `sendTransferSignature`, which publishes
 *      the NIP-17 wrap to the relay AND mirrors it to the gateway cache.
 *   2. B (recipient, throwaway key, never online until now) catches up with
 *      the query `DmPollService.fetchRecentDms` issues, and each wrap goes
 *      through the real `dmCrypto` unwrap, which verifies the seal and holds
 *      the signature (`holdTransferSignatureWrap`).
 *   3. B redeems the coupon: `noteTransferReceived`, as dm-poll calls it, with
 *      the verified credited value. That pairs the two halves and queues the
 *      receipt on its random delay.
 *   4. The queued entry's publish time is brought forward to now and
 *      `publishDue` runs: the real pairing, commitment, per-transfer key and
 *      relay publish.
 *   5. The relay is queried for the receipt by its `n` tag, and it is checked
 *      with `verifyTransferReceipt` (anyone) and `openTransferReceipt` against
 *      the disclosed payload (an auditor given it), which must open to the
 *      amount A signed.
 *
 * What it does NOT exercise: the 10 min to 6 h random wait itself (step 4
 * skips it; `RECEIPT_DELAY_*` and `resumeTransferReceipts` are unit-tested),
 * a real coupon (the transfer id is derived from a stand-in token string,
 * which is all the pairing reads), and the local IndexedDB row the payload is
 * also filed on (no wallet store is opened here, so `recordTransferSignature`
 * logs that it could not and moves on; it never blocks the receipt). Set
 * PROBE_REAL_DELAY=1 to wait out the real delay instead of skipping it (up to
 * 6 h).
 *
 * Set PROBE_MIRROR_ONLY=1 (with VITE_RELAY_URL=ws://127.0.0.1:9) to send the
 * signature through the gateway mirror ALONE: the wallet's relay is dead, so
 * the wrap can reach B only via `POST /api/v1/nostr/events`, which is the #98
 * fix on its own. The receipt publish then has no relay either, so this mode
 * checks steps 1 to 3 (delivered, held, paired) and stops there.
 *
 * Throwaway identities only. Cleanup: the receipt is deleted with a NIP-09
 * request signed by its own per-transfer key. The signature wrap cannot be:
 * `nip17.wrapEvent` discards its one-off key. It is a 1059 addressed to a key
 * this probe throws away, so nobody can open it. PROBE_KEEP=1 skips cleanup.
 *
 *   GATEWAY_URL=https://wallet.staging.398ja.xyz \
 *   VITE_RELAY_URL=wss://relay.staging.398ja.xyz \
 *     npx vite-node e2e/probe-transfer-receipt-live.mts
 *
 * vite-node, not tsx: it runs the wallet's modules as the app does
 * (`import.meta.env`, the `@imani/*` aliases).
 */
import { finalizeEvent, type Event } from 'nostr-tools'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { Relay } from 'nostr-tools/relay'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)
// nostr-tools' standalone `Relay` reads the global, not the pool's setting.
;(globalThis as Record<string, unknown>).WebSocket ??= WebSocket

const GATEWAY = (process.env.GATEWAY_URL ?? 'https://wallet.staging.398ja.xyz').replace(/\/$/, '')

// ---- A browser, as far as these modules need one ---------------------------

const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
  clear: () => store.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  location: { origin: GATEWAY },
  addEventListener() {},
  removeEventListener() {},
}
// The wallet calls relative paths (`/api/v1/...`) as a page would.
const nodeFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  nodeFetch(typeof input === 'string' && input.startsWith('/') ? `${GATEWAY}${input}` : input, init)) as typeof fetch

async function relayUrl(): Promise<string> {
  if (process.env.RELAY_URL) return process.env.RELAY_URL
  const r = await nodeFetch(`${GATEWAY}/api/v1/config`)
  if (!r.ok) throw new Error(`config ${r.status}`)
  return ((await r.json()) as { relay_url: string }).relay_url
}

function identity(): { sk: string; pk: string } {
  const sk = secp256k1.utils.randomSecretKey()
  return { sk: bytesToHex(sk), pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

/** The wallet's catch-up, as DmPollService.fetchRecentDms issues it. */
async function catchUp(recipient: string): Promise<Event[]> {
  const r = await nodeFetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kinds: [1059],
      pTags: [recipient],
      since: Math.floor(Date.now() / 1000) - 7 * 86400,
      limit: 50,
    }),
  })
  if (!r.ok) throw new Error(`nostr/query ${r.status}`)
  const body = (await r.json()) as { events?: Array<Event & { createdAt?: number }> }
  // The gateway answers camelCase; the unwrap wants a Nostr event.
  return (body.events ?? []).map((e) => ({ ...e, created_at: e.created_at ?? (e.createdAt as number) }))
}

async function main() {
  const url = await relayUrl()
  console.log(`gateway ${GATEWAY}\nrelay   ${url}`)

  const nap = await import('../src/lib/nap')
  const ts = await import('../src/lib/transferSignature')
  const { createDmCryptoAdapter } = await import('../src/lib/dmCrypto')
  const { TRANSFER_RECEIPT_KIND } = await import('../src/lib/attestationKind')
  // The wallet reads its relay from `import.meta.env`, fixed when vite-node
  // starts; setting process.env here would not reach it, and a publish to the
  // default localhost relay would read as a delivery failure.
  const { RELAY_URL } = await import('../src/lib/relay')
  const mirrorOnly = process.env.PROBE_MIRROR_ONLY === '1'
  if (!mirrorOnly && RELAY_URL !== url) {
    throw new Error(`the wallet would publish to ${RELAY_URL}, not ${url}: run with VITE_RELAY_URL=${url}`)
  }
  if (mirrorOnly && RELAY_URL === url) {
    throw new Error('PROBE_MIRROR_ONLY needs the wallet relay dead: run with VITE_RELAY_URL=ws://127.0.0.1:9')
  }

  const A = identity()
  const B = identity()
  // Stands in for the redeemed coupon: the pairing reads only its transfer id.
  const token = `cashuB-probe-98-${bytesToHex(randomBytes(16))}`
  const transfer = ts.transferIdFor(token)
  const amount = 2500
  const result: Record<string, unknown> = { sender: A.pk.slice(0, 12), recipient: B.pk.slice(0, 12), transfer }

  // 1. A sends. B has never been online.
  nap.createSession(A.sk, {})
  result.mode = mirrorOnly ? 'mirror-only (wallet relay dead)' : 'relay+mirror'
  result.sent = await ts.sendTransferSignature({ transfer, recipient: B.pk, amount, unit: 'GBP', decimals: 2 })
  const nonce = ts.transferNonce(
    Uint8Array.from(Buffer.from(A.sk, 'hex')),
    transfer,
    B.pk,
  )
  const tag = ts.transferTag(transfer, nonce)

  // 2. B comes online and catches up through the real unwrap.
  nap.resetSession()
  nap.createSession(B.sk, {})
  await new Promise((r) => setTimeout(r, 2000))
  const wraps = await catchUp(B.pk)
  result.wrapsSeen = wraps.length
  const crypto = createDmCryptoAdapter()
  let held = 0
  for (const w of wraps) {
    const dm = await crypto.unwrapNip17Dm(w as never)
    if (dm?.hold) held += 1
  }
  result.signatureHeld = held

  // 3. B redeems the coupon, verified at 25.00 GBP.
  result.paired = await ts.noteTransferReceived({ token, sender: A.pk, credited: amount, unit: 'GBP', decimals: 2 })

  if (mirrorOnly) {
    console.log(JSON.stringify(result, null, 2))
    const ok = result.sent === true && wraps.length === 1 && held === 1 && result.paired === true
    console.log(ok ? 'PASS: the gateway mirror alone delivered the signature to an offline recipient' : 'FAIL')
    process.exit(ok ? 0 : 1)
  }

  // 4. The random delay: skipped (moved to now) unless PROBE_REAL_DELAY=1.
  const dueKey = [...store.keys()].find((k) => k.includes('transfer') && k.includes('due') && k.includes(B.pk))
  const due = dueKey ? (JSON.parse(store.get(dueKey)!) as Record<string, { publishAt: number }>) : {}
  const queued = Object.values(due)
  result.queued = queued.length
  if (queued.length > 0) {
    result.delayMin = Math.round((Math.max(...queued.map((d) => d.publishAt)) - Date.now()) / 60000)
    if (process.env.PROBE_REAL_DELAY === '1') {
      const wait = Math.max(0, ...queued.map((d) => d.publishAt - Date.now())) + 1000
      console.log(`waiting the real delay: ${Math.round(wait / 60000)} min`)
      await new Promise((r) => setTimeout(r, wait))
    } else {
      for (const d of queued) d.publishAt = 0
      store.set(dueKey!, JSON.stringify(due))
    }
  }
  // With the real delay, the wallet's OWN timer (`arm`, set when the pair was
  // queued) fires at publishAt and publishes the receipt itself, which is the
  // behaviour under test. This call then finds nothing due and returns 0.
  // Without it, this call is what publishes.
  const publishedNow = await ts.publishDue(B.pk)
  result.published = publishedNow
  result.publishedBy = process.env.PROBE_REAL_DELAY === '1' ? 'the wallet timer' : 'publishDue (delay skipped)'

  // 5. Find it on the relay and check it as a stranger and as an auditor.
  //    Looked up two ways: by its `n` tag (how a party holding the nonce finds
  //    it) and by its author, B's per-transfer key (to tell "not stored" from
  //    "stored but not indexed by #n").
  const relay = await Relay.connect(url)
  await new Promise((r) => setTimeout(r, 1500))
  const receiverKey = ts.transferPubkeyFor(B.pk, 'receiver', tag, nonce)
  const query = (filter: Record<string, unknown>) =>
    new Promise<Event[]>((resolve) => {
      const got: Event[] = []
      const sub = relay.subscribe([filter as never], {
        onevent: (e) => got.push(e),
        oneose: () => {
          sub.close()
          resolve(got)
        },
      })
    })
  const receipts = await query({ kinds: [TRANSFER_RECEIPT_KIND], '#n': [tag] })
  const byAuthor = await query({ kinds: [TRANSFER_RECEIPT_KIND], authors: [receiverKey] })
  result.onRelay = receipts.length
  result.onRelayByAuthor = byAuthor.length
  const receipt = receipts[0] ?? byAuthor[0]
  if (receipt) {
    result.verifies = ts.verifyTransferReceipt(receipt)
    nap.resetSession()
    nap.createSession(A.sk, {})
    const payload = nap.getSigner().withPrivkey((key) =>
      ts.signTransfer(key, { transfer, recipient: B.pk, amount, unit: 'GBP', decimals: 2 }),
    )
    result.opens = ts.openTransferReceipt(receipt, payload)
    result.receiptAgeMin = Math.round((Date.now() / 1000 - receipt.created_at) / 60)

    if (process.env.PROBE_KEEP === '1') {
      console.log('cleanup: skipped (PROBE_KEEP=1)')
    } else {
      const rsk = ts.transferSecretFor(Uint8Array.from(Buffer.from(B.sk, 'hex')), 'receiver', tag, nonce)
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['e', receipt.id],
            ['k', String(TRANSFER_RECEIPT_KIND)],
          ],
          content: 'probe-98 cleanup: throwaway test receipt',
        },
        rsk,
      )
      await relay.publish(deletion).then(
        () => console.log('cleanup: receipt deletion accepted by the relay'),
        (e) => console.log(`cleanup: receipt deletion refused: ${String(e)}`),
      )
    }
  }
  relay.close()
  console.log(JSON.stringify(result, null, 2))

  const ok =
    result.sent === true &&
    wraps.length === 1 &&
    held === 1 &&
    result.paired === true &&
    (process.env.PROBE_REAL_DELAY === '1' ? true : result.published === 1) &&
    result.onRelay === 1 &&
    result.verifies === true &&
    (result.opens as { ok?: boolean; amount?: number })?.ok === true &&
    (result.opens as { amount?: number })?.amount === amount
  console.log(ok ? 'PASS: offline recipient published a verifiable 7378 that opens to the signed amount' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
