import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { createDmCryptoAdapter, toLegacyMetadata } from '../dmCrypto'
import { buildVoucherToken, dmEnvelope } from './voucherFixtures'
import { resetChunkAssembly } from '../dmChunks'
import javaChunks from './fixtures/java-encoded-chunks.json'
import javaPayload from './fixtures/java-encoded-payload.json'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * A stand-in for the app's signer, lockable like the real one.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above the imports, so its factory
 * cannot close over an ordinary `const` declared below it.
 */
const signerState = vi.hoisted(() => ({ privkey: null as string | null, pubkey: '' }))
const collectEnrolled = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('../terminalDeliveryNet', () => ({ collectEnrolled }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    get pubkey() {
      return signerState.pubkey
    },
    privkeyHex() {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return signerState.privkey
    },
    // IW-14: the scoped borrow, which throws while locked exactly as privkeyHex did — the
    // locked-wallet case must stay distinguishable from a malformed wrap.
    withPrivkey<T>(borrow: (key: Uint8Array) => T): T {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return borrow(hexToBytes(signerState.privkey))
    },
  }),
}))

const MERCHANT = '7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448'

/**
 * Captured verbatim from a live delivery — merchant issues via gateway-portal,
 * Lightning auto-settles, the gateway NIP-17 gift-wraps it, and this is the
 * rumor content the customer decrypts.
 */
const DELIVERED = JSON.stringify({
  type: 'cashu_token_transfer',
  version: '1.0',
  token: 'cashuBv2F0gb9haUgA4zcuYdBWBWFwhr9hYRkBAGFzeQS8WyJWT1VDSEVSIiwi',
  memo: 'Rosa Green Farm — market voucher',
  unit: 'EUR',
  voucher_id: '17be770a-0000-4000-8000-000000000000',
  face_value: 500,
  face_unit: 'EUR',
  face_decimals: 2,
  token_amount: 500,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: MERCHANT,
  sender_pubkey: MERCHANT,
  created_at: 1786570642,
  // Epoch SECONDS. Verified against a live delivery by decrypting the gift wrap
  // off the gateway's nostrdb — 1794346639 is 2026-11-10, the issuer's 90 days.
  expires_at: 1794346639,
  expired: false,
})

const crypto = createDmCryptoAdapter()

describe('dm-poll CryptoAdapter', () => {
  it('maps the gateway JSON envelope into TokenMetadata', () => {
    // The wire format is snake_case; TokenMetadata is camelCase. Getting this
    // wrong loses issuerId, and a coupon with no issuer cannot be attributed to
    // a merchant — it just silently fails to appear under anyone.
    const meta = crypto.parseTokenTransferMessage(DELIVERED)

    expect(meta).not.toBeNull()
    expect(meta!.issuerId).toBe(MERCHANT)
    expect(meta!.faceValue).toBe(500)
    expect(meta!.faceUnit).toBe('EUR')
    expect(meta!.faceDecimals).toBe(2)
    expect(meta!.tokenAmount).toBe(500)
    expect(meta!.voucherId).toBe('17be770a-0000-4000-8000-000000000000')
    // Not on dm-poll's TokenMetadata, so nothing type-checks this one for us.
    expect((meta as unknown as Record<string, unknown>).expiresAt).toBe(1794346639)
  })

  describe('unwrapNip17Dm', () => {
    /** A real NIP-17 gift wrap, so the unwrap path is exercised for real. */
    function giftWrap() {
      const recipientSk = generateSecretKey()
      const senderSk = generateSecretKey()
      const wrap = nip17.wrapEvent(senderSk, { publicKey: getPublicKey(recipientSk) }, 'hello')
      return { recipientSk: bytesToHex(recipientSk), wrap }
    }

    it('decrypts with the signer key, ignoring the one it is handed', async () => {
      const { recipientSk, wrap } = giftWrap()
      signerState.privkey = recipientSk

      // A key that could not open this wrap is passed as the argument. If the
      // adapter used it — as it did when DmPollService held the key — this
      // fails. The point of the change is that the poller carries no key copy
      // that could outlive `signer.clearKey()`.
      const unwrapped = await createDmCryptoAdapter().unwrapNip17Dm(
        wrap as never,
        bytesToHex(generateSecretKey()),
      )

      expect(unwrapped?.content).toBe('hello')
    })

    it('throws while the wallet is locked instead of consuming the event', async () => {
      const { wrap } = giftWrap()
      signerState.privkey = null

      // A lock is TRANSIENT. Returning null here would have dm-poll record it
      // the same way it records a malformed wrap; throwing surfaces the real
      // reason. Either way the event survives — only the success paths call
      // `eventTracker.add` — but the operator gets told why.
      await expect(
        createDmCryptoAdapter().unwrapNip17Dm(wrap as never, ''),
      ).rejects.toThrow(/locked/i)
    })

    it('returns null for a wrap addressed to someone else', async () => {
      const { wrap } = giftWrap()
      // Unlocked, but not the recipient: malformed-or-not-ours, which must stay
      // a null so one undecryptable event cannot stall the poll.
      signerState.privkey = bytesToHex(generateSecretKey())

      expect(await createDmCryptoAdapter().unwrapNip17Dm(wrap as never, '')).toBeNull()
    })

    // #160 phase 6, found by the local gate (B5, E4). A till's "enrolled" DM was read only by the
    // Terminals screen's poll, so an owner on any other screen, or on a restored phone, kept the
    // till Waiting. dm-poll opening one must ask the owner's app to collect it now.
    it('asks for the enrolled notices to be collected when a till says it is enrolled', async () => {
      const stallSk = generateSecretKey()
      const tillSk = generateSecretKey()
      signerState.privkey = bytesToHex(stallSk)
      signerState.pubkey = getPublicKey(stallSk)
      const content = JSON.stringify({ type: 'imani-terminal-enrolled/1', voucher_id: 'v1', terminal_pubkey: getPublicKey(tillSk) })
      const wrap = nip17.wrapEvent(tillSk, { publicKey: getPublicKey(stallSk) }, content)

      await createDmCryptoAdapter().unwrapNip17Dm(wrap as never, '')

      await vi.waitFor(() => expect(collectEnrolled).toHaveBeenCalledWith(getPublicKey(stallSk)))
    })

    /**
     * A coupon too big for one DM, through the real gift-wrap path.
     *
     * This is the incident end to end. A token above the gateway's
     * `direct_limit_bytes` is sent as several `cashu_dm_chunk` wraps, and
     * nothing reassembled them: each fell through to the text parser, produced
     * no token, and was classified `non_token_dm` — marked processed and never
     * retried. Three real coupons (200, 150, 150) were acked by two relays and
     * never seen again.
     *
     * Wrapped for real rather than calling `offerChunk` directly, because the
     * bug was not in the reassembly but in nothing CALLING it.
     */
    describe('a coupon that arrives in pieces', () => {
      const chunkWraps = (recipientSk: Uint8Array, chunks: unknown[]) => {
        const senderSk = generateSecretKey()
        return chunks.map((chunk) =>
          nip17.wrapEvent(senderSk, { publicKey: getPublicKey(recipientSk) }, JSON.stringify(chunk)),
        )
      }

      it('yields the whole coupon once the last piece is unwrapped', async () => {
        resetChunkAssembly()
        const recipientSk = generateSecretKey()
        signerState.privkey = bytesToHex(recipientSk)

        const wraps = chunkWraps(recipientSk, javaChunks as unknown[])
        const adapter = createDmCryptoAdapter()

        // The first wrap is a real DM that is not yet a coupon. HELD keeps it
        // unconsumed (and out of the failed tracker) so the poll re-offers it;
        // anything that consumes it loses the money.
        const first = await adapter.unwrapNip17Dm(wraps[0] as never, '')
        expect(first?.hold).toBe(true)
        expect(adapter.extractToken(first!.content)).toBeNull()

        const done = await adapter.unwrapNip17Dm(wraps[1] as never, '')
        expect(done?.content).toBe(JSON.stringify(javaPayload))
      })

      it('hands the reassembled coupon on as an ordinary token DM', async () => {
        resetChunkAssembly()
        const recipientSk = generateSecretKey()
        signerState.privkey = bytesToHex(recipientSk)

        const wraps = chunkWraps(recipientSk, javaChunks as unknown[])
        const adapter = createDmCryptoAdapter()
        await adapter.unwrapNip17Dm(wraps[0] as never, '')
        const done = await adapter.unwrapNip17Dm(wraps[1] as never, '')

        // Everything downstream is synchronous and expects a whole
        // `cashu_token_transfer`, so the rest of the pipeline must not be able
        // to tell this coupon was ever split.
        expect(adapter.extractToken(done!.content)).toBe(
          (javaPayload as { token: string }).token,
        )
      })
    })
  })

  it('extracts the token from the JSON envelope', () => {
    expect(crypto.extractToken(DELIVERED)).toMatch(/^cashuBv2F0/)
  })

  it('still handles the legacy human-readable format', () => {
    // dm-poll's own TokenParser owns this path; we only add JSON in front of
    // it. If the fallthrough breaks, older senders stop being received.
    const legacy = '🎁 Token Transfer: 1.00 USD\nBacking: MINIMAL | Amount: 69 sats\ncashuAtoken123'
    expect(crypto.extractToken(legacy)).toContain('cashuA')
    expect(crypto.parseTokenTransferMessage(legacy)?.faceValue).toBe(1)
  })

  it('ignores JSON that is not a token transfer', () => {
    expect(crypto.parseTokenTransferMessage('{"type":"something_else"}')).toBeNull()
    expect(crypto.extractToken('{"type":"something_else"}')).toBeNull()
  })

  it('fingerprints by content so a redelivered voucher collapses to one row', () => {
    const token = 'cashuBv2F0gb9haUg'
    expect(crypto.getTokenFingerprint(token)).toBe(crypto.getTokenFingerprint(token))
    expect(crypto.getTokenFingerprint(token)).toHaveLength(32)
    expect(crypto.getTokenFingerprint('other')).not.toBe(crypto.getTokenFingerprint(token))
  })

  it('hands tokenRedemption the snake_case keys it actually reads', () => {
    // Regression guard for a silent failure, not a hypothetical: dm-poll's
    // TokenMetadata is camelCase, tokenRedemption reads snake_case, and the
    // mismatch persisted a coupon with issuer_id null. Nothing threw — the
    // merchant list groups by issuer, so the coupon simply never appeared.
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({
        type: 'cashu_token_transfer',
        token: 'cashuBv2xyz',
        voucher_id: 'v-1',
        face_value: 500,
        face_unit: 'EUR',
        face_decimals: 2,
        token_amount: 500,
        backing_strategy: 'PROPORTIONAL',
        issuer_id: 'merchantpubkey',
        memo: 'market day',
        expires_at: 1794346639,
      }),
    )
    const legacy = toLegacyMetadata(parsed as unknown as Record<string, unknown>, 'senderpubkey')

    expect(legacy.issuer_id).toBe('merchantpubkey')
    expect(legacy.face_value).toBe(500)
    expect(legacy.face_unit).toBe('EUR')
    expect(legacy.face_decimals).toBe(2)
    expect(legacy.token_amount).toBe(500)
    expect(legacy.backing_strategy).toBe('PROPORTIONAL')
    // tokenRedemption reads `metadata.expires_at`; the DM speaks camelCase by
    // the time it reaches here. Miss this hop and the coupon stores a null
    // expiry — /inspect 404s on this deployment, so there is no second source.
    expect(legacy.expires_at).toBe(1794346639)
    expect(legacy.memo).toBe('market day')
    expect(legacy.sender_pubkey).toBe('senderpubkey')
  })

  /**
   * Who PAID, as opposed to who MINTED.
   *
   * The gateway signs every gift wrap it relays with its own key, so the
   * envelope's signer is never the payer on a relayed send. The payload carries
   * the real answer in `sender_pubkey` — set by gateway-core's
   * `Nip17DmSendPublisher` from the send row — and this parser used to drop it
   * on the floor, leaving dm-poll with nothing but `issuer_id` to guess from.
   * That guess sent the settlement receipt to the stall that minted the coupon
   * instead of the customer who spent it.
   */
  it('carries the payload payer, distinct from the issuer that minted', () => {
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({
        type: 'cashu_token_transfer',
        token: 'cashuBv2xyz',
        voucher_id: 'v-1',
        face_value: 500,
        face_unit: 'EUR',
        issuer_id: 'merchantpubkey',
        sender_pubkey: 'payerpubkey',
      }),
    ) as unknown as Record<string, unknown>

    expect(parsed.senderPubkey).toBe('payerpubkey')
    // Still recorded, and still a different question.
    expect(parsed.issuerId).toBe('merchantpubkey')
  })

  it('lets the payload payer outrank the envelope signer', () => {
    // The gateway wraps on the payer's behalf, so the signer is the GATEWAY.
    // Preferring it would credit a relay for someone else's payment.
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({
        type: 'cashu_token_transfer',
        token: 'cashuBv2xyz',
        sender_pubkey: 'payerpubkey',
      }),
    )
    const legacy = toLegacyMetadata(parsed as unknown as Record<string, unknown>, 'gatewaypubkey')

    expect(legacy.sender_pubkey).toBe('payerpubkey')
  })

  it('still uses the envelope signer for a bare wrap that names no payer', () => {
    // A direct wallet-to-wallet NIP-17 wrap, where the signer genuinely is the
    // payer and there is no payload field to prefer.
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({ type: 'cashu_token_transfer', token: 'cashuBv2xyz' }),
    )
    const legacy = toLegacyMetadata(parsed as unknown as Record<string, unknown>, 'directsender')

    expect(legacy.sender_pubkey).toBe('directsender')
  })

  it('carries the request and bundle ids the gateway sends', () => {
    // Both are on the wire — `TokenTransferMessage` has serialised them for as
    // long as bundles have existed — and both were dropped here. Without them a
    // merchant's till sees two coupons and no way to tell they are the two
    // halves of one payment, so the request stays pending on money it has.
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({
        type: 'cashu_token_transfer',
        token: 'cashuBv2xyz',
        issuer_id: 'merchantpubkey',
        request_id: 'pay-1',
        bundle_id: 'b'.repeat(32),
      }),
    ) as unknown as Record<string, unknown>

    expect(parsed.requestId).toBe('pay-1')
    expect(parsed.bundleId).toBe('b'.repeat(32))

    const legacy = toLegacyMetadata(parsed)
    expect(legacy.request_id).toBe('pay-1')
    expect(legacy.bundle_id).toBe('b'.repeat(32))
  })

  it('carries the declared bundle total and count as hints (#94)', () => {
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({
        type: 'cashu_token_transfer',
        token: 'cashuBv2xyz',
        bundle_id: 'b'.repeat(32),
        bundle_total: 600,
        bundle_part_index: 1,
        bundle_part_count: '2',
      }),
    ) as unknown as Record<string, unknown>

    expect(parsed.bundleTotal).toBe(600)
    expect(parsed.bundlePartIndex).toBe(1)
    expect(parsed.bundlePartCount).toBe(2)

    // Declared figures never reach the ledger's snake_case metadata: the row
    // builder reads face_value / token_amount, and a sender-chosen total must
    // not be able to stand in for either.
    const legacy = toLegacyMetadata(parsed)
    expect(legacy.face_value).toBeUndefined()
    expect(legacy).not.toHaveProperty('bundle_total')
  })

  it('drops a garbled or partial declaration rather than half of it', () => {
    for (const extra of [
      { bundle_total: -1, bundle_part_index: 0, bundle_part_count: 2 },
      { bundle_total: 600, bundle_part_index: 0, bundle_part_count: 0 },
      { bundle_total: 600, bundle_part_count: 2 },
      { bundle_total: 'lots', bundle_part_index: 0, bundle_part_count: 2 },
    ]) {
      const parsed = crypto.parseTokenTransferMessage(
        JSON.stringify({ type: 'cashu_token_transfer', token: 'cashuBv2xyz', bundle_id: 'b'.repeat(32), ...extra }),
      ) as unknown as Record<string, unknown>
      expect(parsed.bundleId).toBe('b'.repeat(32))
      expect(parsed.bundleTotal).toBeUndefined()
      expect(parsed.bundlePartCount).toBeUndefined()
    }
  })

  it('ignores declared fields with no bundle id (a single-voucher send)', () => {
    const parsed = crypto.parseTokenTransferMessage(
      JSON.stringify({ type: 'cashu_token_transfer', token: 'cashuBv2xyz', bundle_total: 600, bundle_part_index: 0, bundle_part_count: 2 }),
    ) as unknown as Record<string, unknown>
    expect(parsed.bundleId).toBeUndefined()
    expect(parsed.bundleTotal).toBeUndefined()
  })
})

describe('voucher metadata comes from the token, not the envelope', () => {
  const crypto = createDmCryptoAdapter()

  it('overrides a lying envelope with the signed voucher', () => {
    const { token, voucher } = buildVoucherToken()
    // The sender claims a different issuer and 100x the value.
    const content = dmEnvelope(token, {
      issuer_id: 'f'.repeat(64),
      face_value: 100000,
      face_unit: 'EUR',
      voucher_id: 'not-the-real-one',
    })

    const meta = crypto.parseTokenTransferMessage(content) as Record<string, unknown>

    expect(meta.issuerId).toBe(voucher.issuerId)
    expect(meta.voucherId).toBe(voucher.voucherId)
    expect(meta.faceUnit).toBe('GBP')
    // 1782 sats * 0.05611672278338945 = 100 minor units, not the claimed 100000.
    expect(meta.faceValue).toBe(100)
    expect(meta.validation).toMatchObject({ signatureValid: true, signedFaceValue: 1000 })
  })

  it('refuses a voucher whose signature does not check out', () => {
    // Altering fields BEFORE signing just yields a different valid voucher, so
    // the forgery has to be applied after: the blob now says 10x the face value
    // the issuer put their name to. Refused outright rather than flagged and
    // carried forward — tampering after issuance is the only way to produce it.
    const { token } = buildVoucherToken({}, [1000, 782], { faceValue: 10000 })

    expect(crypto.parseTokenTransferMessage(dmEnvelope(token))).toBeNull()
  })

  it('gives GiftWrapProcessor no token to redeem for a failed signature', () => {
    // The refusal above was cosmetic on its own: `process` reads the token
    // first and folds a null metadata away as `?? {}`, so the forgery was still
    // swapped at the mint and saved — with an empty envelope, which also made
    // `refuseIfOverRedeemed` skip it. No token is what actually stops it.
    const { token } = buildVoucherToken({}, [1000, 782], { faceValue: 10000 })

    expect(crypto.extractToken(dmEnvelope(token))).toBeNull()
  })

  it('still hands over a genuine voucher, and plain ecash', () => {
    const { token } = buildVoucherToken()

    expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
    expect(crypto.extractToken(dmEnvelope('cashuBnotavoucher'))).toBe('cashuBnotavoucher')
  })

  /**
   * #131/#133 review (HIGH-2): a voucher at a mint the wallet does not list is
   * HANDED OVER here, not dropped. Returning no token marks the delivery processed
   * for good, so a mere mismatch between two services' mint settings would lose
   * every coupon. The redemption gate holds it instead: nothing is swapped, the
   * delivery stays unconsumed, and the wallet shows it as waiting to be verified.
   */
  it('hands over a voucher at an unlisted mint, for the redemption gate to hold', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'https://mint.staging.398ja.xyz')
    try {
      const { token } = buildVoucherToken() // stamped `http://mint.test`
      expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * And the same voucher at the trusted mint is handed over: the refusal above
   * is the mint, not anything else about the fixture.
   */
  it('hands over the same voucher when its mint is trusted', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'http://mint.test/')
    try {
      const { token } = buildVoucherToken()
      expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * A voucher that arrives before the trusted list has loaded must not be refused
   * HERE: no token marks the delivery processed for good, which lost the coupon.
   * It is handed over, and the redemption gate defers it until the list is known.
   */
  it('hands over a voucher while the trusted list is still unknown, for the redemption gate to defer', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    try {
      const { token } = buildVoucherToken()
      expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('clamps a value inflated past the signed face value', () => {
    // A rewritten ratio on a legacy voucher looks exactly like this: proofs are
    // genuine, the derived value exceeds what was ever issued.
    const { token } = buildVoucherToken({ issuanceRatio: 2.5 }, [1000, 782])
    const meta = crypto.parseTokenTransferMessage(dmEnvelope(token)) as Record<string, unknown>

    // 1782 * 2.5 = 4455, far past the 1000 that was issued.
    expect(meta.faceValue).toBe(1000)
    expect(meta.validation).toMatchObject({ cappedAtFaceValue: true })
  })

  it('leaves plain non-voucher ecash alone', () => {
    const meta = crypto.parseTokenTransferMessage(
      dmEnvelope('cashuBnotavoucher', { face_value: 42, issuer_id: 'abc' }),
    ) as Record<string, unknown>

    expect(meta.faceValue).toBe(42)
    expect(meta.issuerId).toBe('abc')
    expect(meta.validation).toBeUndefined()
  })
})
