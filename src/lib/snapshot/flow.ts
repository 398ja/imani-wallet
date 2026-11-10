import type { SupportSnapshotConfig } from '../config'
import { buildSnapshot } from './build'
import { encryptSnapshot, type SealedSnapshot } from './crypto'
import {
  COMPLETE_PATH, handoffBody, snapshotFileName, uploadSnapshot, validateSnapshotCode, writeRecord,
  type HandoffBody, type SignedPost, type ValidatedCode,
} from './service'
import type { BuiltSnapshot, SnapshotSigner, SnapshotSources } from './types'
import { verifyArchive } from './verify'

/**
 * The snapshot flow as a small state machine the screens drive (#589 sections 8 and 11):
 *
 *   code -> (validate online) -> preview -> (build, sign, encrypt) -> size -> (Upload now) -> sent
 *                                                                        \-> (Not now) -> kept
 *
 * Nothing is built before a code validates, and nothing leaves the device before "Upload now":
 * the only network calls are `validate`, then `upload`, `sendDm` and `complete`, in that order,
 * each only from `upload()`. Everything is injected so tests run the real flow without a network.
 */
export interface FlowDeps {
  config: SupportSnapshotConfig
  signer: SnapshotSigner
  collect: () => Promise<SnapshotSources>
  post: SignedPost
  fetch: typeof fetch
  /** NIP-17 gift wrap to the support pubkey and publish. Resolves true when it landed. */
  sendDm: (supportPubkey: string, content: string) => Promise<boolean>
  /** Persist the encrypted bytes for "Not now" / resume, and drop them. */
  keep: (sha256: string, bytes: Uint8Array) => Promise<void>
  drop: (sha256: string) => Promise<void>
  storage?: Storage
  now?: () => number
}

export class SnapshotFlow {
  code: ValidatedCode | null = null
  built: BuiltSnapshot | null = null
  sealed: SealedSnapshot | null = null
  fileName: string | null = null
  dm: HandoffBody | null = null
  private readonly now: () => number

  constructor(private readonly deps: FlowDeps) {
    this.now = deps.now ?? Date.now
  }

  async validate(typed: string): Promise<ValidatedCode> {
    this.code = await validateSnapshotCode(typed, this.deps.post)
    return this.code
  }

  /** Build, verify our own output, encrypt. Requires a validated code. */
  async prepare(includeMemos: boolean): Promise<{ built: BuiltSnapshot; size: number }> {
    if (!this.code) throw new Error('A snapshot needs a validated code from support first.')
    const sources = await this.deps.collect()
    const built = await buildSnapshot(sources, {
      ticket: this.code.ticket,
      codeRef: this.code.codeRef,
      supportPubkey: this.deps.config.supportPubkey,
      ttlSeconds: this.deps.config.ttlSeconds,
      includeMemos,
      signer: this.deps.signer,
      now: this.now(),
      maxBytes: Math.min(this.code.maxBytes, 20 * 1024 * 1024),
    })
    const check = verifyArchive(built.zip)
    if (!check.ok) throw new Error(`The snapshot failed its own check (${check.reason}). Nothing was shared.`)
    this.built = built
    this.sealed = await encryptSnapshot(built.zip)
    this.fileName = snapshotFileName(this.code.ticket, this.deps.signer.pubkey, this.now())
    return { built, size: this.sealed.ciphertext.length }
  }

  private record(state: 'kept' | 'uploaded' | 'shared' | 'failed') {
    if (!this.sealed || !this.code || !this.fileName) return
    writeRecord(this.deps.signer.pubkey, {
      sha256: this.sealed.sha256,
      ticket: this.code.ticket,
      server: state === 'kept' ? null : this.deps.config.blossomUrl,
      state,
      size: this.sealed.ciphertext.length,
      createdAt: this.now(),
      keepUntil: this.code.codeExpiresAt,
      fileName: this.fileName,
    }, this.deps.storage)
  }

  /** "Not now": keep the encrypted file on the device until the code expires. Uploads nothing. */
  async notNow(): Promise<void> {
    if (!this.sealed) throw new Error('Nothing to keep.')
    await this.deps.keep(this.sealed.sha256, this.sealed.ciphertext)
    this.record('kept')
  }

  /** "Upload now": the only place anything leaves the device. */
  async upload(): Promise<HandoffBody> {
    if (!this.code || !this.sealed || !this.built || !this.fileName) throw new Error('Nothing to upload.')
    if (this.code.grantExpiresAt * 1000 < this.now()) throw new Error('The upload permission expired. Enter the code again.')
    const { url } = await uploadSnapshot(this.deps.config.blossomUrl, this.sealed, this.code.grant, this.deps.signer, this.deps.fetch, this.now())
    this.record('uploaded')
    const body = await handoffBody({
      ticket: this.code.ticket,
      codeRef: this.code.codeRef,
      url,
      sealed: this.sealed,
      fileName: this.fileName,
      kCorr: this.built.kCorr,
      signer: this.deps.signer,
      expiresAt: this.built.manifest.expires_at,
      now: this.now(),
    })
    const sent = await this.deps.sendDm(this.deps.config.supportPubkey, JSON.stringify(body))
    if (!sent) {
      this.record('failed')
      throw new Error('The snapshot was uploaded but support could not be told. Try again.')
    }
    // Best effort: the code becomes `used`. Support also marks it used when it validates the DM.
    await this.deps.post(COMPLETE_PATH, { upload_grant: this.code.grant, sha256: this.sealed.sha256 }).catch(() => undefined)
    this.record('shared')
    await this.deps.drop(this.sealed.sha256).catch(() => undefined)
    this.dm = body
    return body
  }
}
