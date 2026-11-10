import { isUnverifiableVoucherError, tokenProofs } from '../voucherToken'
import { getSigner } from '../nap'
import { listVouchers, getWallet } from '../wallet'
import { appVersion, deployVersion } from '../about'
import { RELAY_URL } from '../relay'
import { trustedMintUrls } from '../trustedMint'
import { wrapMessage } from '../giftWrap'
import { ownerPublisher } from '../terminalDeliveryNet'
import type { SupportSnapshotConfig } from '../config'
import { recentErrors } from './errorRing'
import { defaultPost } from './service'
import type { FlowDeps } from './flow'
import type { SnapshotSigner, SnapshotSources } from './types'

/**
 * The real sources and network for a snapshot, in the running app. Kept apart from the builder so
 * the builder never imports a store, a signer or the network, and its tests never need them.
 */
export async function collectSources(pubkey: string, stall: boolean): Promise<SnapshotSources> {
  const vouchers = await listVouchers()
  const transactions = await getWallet().getAllTransactions()
  const proofShapes: SnapshotSources['proofShapes'] = {}
  for (const v of vouchers) {
    try {
      const proofs = tokenProofs(v.token)
      proofShapes[v.token_id] = {
        amounts: proofs.map((p) => p.amount),
        keysets: [...new Set(proofs.map((p) => p.id))],
        hasDleq: proofs.some((p) => !!p.dleq),
      }
    } catch (e) {
      // An unverifiable voucher, or a token this reader does not know: the row still goes in, without
      // its shape. Never treated as plain ecash: the snapshot only describes, it never spends or credits.
      if (isUnverifiableVoucherError(e)) continue
    }
  }
  const storage: Array<[string, string]> = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k !== null) storage.push([k, localStorage.getItem(k) ?? ''])
  }
  let usage: number | undefined
  let quota: number | undefined
  try {
    const est = await navigator.storage?.estimate?.()
    usage = est?.usage
    quota = est?.quota
  } catch {
    /* not available */
  }
  return {
    selfPubkey: pubkey,
    stall,
    vouchers,
    transactions,
    storage,
    errors: recentErrors(),
    idbStores: ['wallet_vouchers', 'wallet_transactions'],
    proofShapes,
    environment: {
      appVersion: appVersion(),
      buildRef: deployVersion(),
      gatewayUrl: window.location.origin,
      mintUrls: trustedMintUrls(),
      relayUrls: [RELAY_URL],
      blossomUrl: null,
      userAgent: navigator.userAgent,
      language: navigator.language,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
      storageUsage: usage,
      storageQuota: quota,
    },
  }
}

const KEEP_DB = 'imani-wallet-snapshots'

function keepDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEEP_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kept')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** "Not now" keeps only ciphertext, in its own IndexedDB store, until the code expires. */
export async function keepCiphertext(sha: string, bytes: Uint8Array): Promise<void> {
  const db = await keepDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kept', 'readwrite')
    tx.objectStore('kept').put(bytes, sha)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function dropCiphertext(sha: string): Promise<void> {
  const db = await keepDb()
  await new Promise<void>((resolve) => {
    const tx = db.transaction('kept', 'readwrite')
    tx.objectStore('kept').delete(sha)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
  db.close()
}

export async function loadCiphertext(sha: string): Promise<Uint8Array | null> {
  const db = await keepDb()
  const out = await new Promise<Uint8Array | null>((resolve) => {
    const req = db.transaction('kept').objectStore('kept').get(sha)
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
    req.onerror = () => resolve(null)
  })
  db.close()
  return out
}

function walletSigner(): SnapshotSigner {
  const s = getSigner()
  return {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t) as never,
  }
}

export function appDeps(config: SupportSnapshotConfig, stall: boolean): FlowDeps {
  const signer = walletSigner()
  return {
    config,
    signer,
    collect: () => collectSources(signer.pubkey, stall),
    post: defaultPost,
    fetch: (...a) => fetch(...a),
    sendDm: async (to, content) => ownerPublisher.publish(getSigner().withPrivkey((key) => wrapMessage(key, to, content))),
    keep: keepCiphertext,
    drop: dropCiphertext,
  }
}

/**
 * Read support's ack DMs (section 8 step 5): gift wraps to us, sealed by the support key, whose
 * rumor is `imani-support-snapshot-ack`. Checked when the snapshot screen opens, so the record
 * moves to "Received by support, deleted from server" without touching the voucher DM poller.
 */
export async function pollAcks(pubkey: string, supportPubkey: string, sinceSeconds: number): Promise<number> {
  const { giftWraps } = await import('../terminalDeliveryNet')
  const { unwrapSealed } = await import('../giftWrap')
  const { applyAck } = await import('./service')
  const wraps = await giftWraps(pubkey, sinceSeconds)
  let n = 0
  for (const w of wraps) {
    const opened = getSigner().withPrivkey((key) => unwrapSealed(w, key))
    if (!opened || opened.sealer !== supportPubkey) continue
    if (applyAck(pubkey, opened.rumor.content)) n++
  }
  return n
}
