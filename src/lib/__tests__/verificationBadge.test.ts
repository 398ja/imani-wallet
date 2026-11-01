/**
 * The verification badge (#418): the public attestation, the badge in force at a moment, and the
 * reader's checks that a stall cannot award itself one.
 */
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools'
import { BUNDLED_CATALOG, badgeOf, licenceOf, parseCatalog, type LicenceGrant } from '@imani/licence'

import {
  badgeAt,
  nextBadgeChange,
  parseVerification,
  VERIFICATION_KIND,
  verificationD,
  verificationJson,
  type BadgeWindow,
} from '../verificationBadge'
import { attestedWindows, grantWindows } from '../verificationReader'
import { licenceMetadataJson } from '../licenceIssue'

const SELLER_SK = generateSecretKey()
const SELLER = getPublicKey(SELLER_SK)
const STALL_SK = generateSecretKey()
const STALL = getPublicKey(STALL_SK)
const NOW = 1_800_000_000
const DAY = 86_400

const bronze: BadgeWindow = { badge: 'bronze', validFrom: NOW - DAY, validTo: NOW + 30 * DAY }

function attestation(sk: Uint8Array, stall: string, windows: BadgeWindow[], d = verificationD(stall)): Event {
  return finalizeEvent(
    { kind: VERIFICATION_KIND, created_at: NOW, tags: [['d', d]], content: verificationJson(stall, windows) },
    sk,
  )
}

const read = (event: Event | null, over: { seller?: string } = {}) =>
  attestedWindows(STALL, { seller: over.seller ?? SELLER, fetchNewest: async () => event, verify: verifyEvent })

describe('the badge in force', () => {
  it('shows from valid_from and is gone at valid_to, with no grace', () => {
    expect(badgeAt([bronze], NOW)).toBe('bronze')
    expect(badgeAt([bronze], bronze.validFrom - 1)).toBeNull()
    expect(badgeAt([bronze], bronze.validFrom)).toBe('bronze')
    expect(badgeAt([bronze], bronze.validTo - 1)).toBe('bronze')
    expect(badgeAt([bronze], bronze.validTo)).toBeNull()
  })

  it('takes the highest of several at once (Essentials and Pro held together is silver)', () => {
    const silver: BadgeWindow = { badge: 'silver', validFrom: NOW - DAY, validTo: NOW + DAY }
    expect(badgeAt([bronze, silver], NOW)).toBe('silver')
    expect(badgeAt([bronze, silver], NOW + 2 * DAY)).toBe('bronze')
  })

  it('an early renewal opens when the current window ends', () => {
    const renewal: BadgeWindow = { badge: 'bronze', validFrom: bronze.validTo, validTo: bronze.validTo + 30 * DAY }
    expect(badgeAt([bronze, renewal], bronze.validTo)).toBe('bronze')
  })

  it('knows when to look again, so a screen left open drops a lapsed badge', () => {
    expect(nextBadgeChange([bronze], NOW)).toBe(bronze.validTo)
    expect(nextBadgeChange([bronze], bronze.validTo)).toBeUndefined()
  })

  it('no windows, no badge', () => {
    expect(badgeAt([], NOW)).toBeNull()
  })
})

describe('the published attestation', () => {
  it('round-trips, and leaves out everything about money', () => {
    const json = verificationJson(STALL, [bronze])
    expect(parseVerification(json, STALL)).toEqual([bronze])
    expect(json).not.toMatch(/paid|price|stripe|sub_|subscription/i)
  })

  it('is about exactly one stall: another key reads nothing from it', () => {
    expect(parseVerification(verificationJson(STALL, [bronze]), 'f'.repeat(64))).toBeNull()
  })

  it('drops a window it cannot read rather than guessing', () => {
    const content = JSON.stringify({
      type: 'imani-verification/1',
      stall: STALL,
      badges: [
        { badge: 'platinum', valid_from: NOW - DAY, valid_to: NOW + DAY },
        { badge: 'gold', valid_from: NOW + DAY, valid_to: NOW - DAY },
        { badge: 'gold', valid_from: 'soon', valid_to: NOW + DAY },
        { badge: 'silver', valid_from: NOW - DAY, valid_to: NOW + DAY },
      ],
    })
    expect(parseVerification(content, STALL)).toEqual([{ badge: 'silver', validFrom: NOW - DAY, validTo: NOW + DAY }])
    expect(parseVerification('not json', STALL)).toBeNull()
  })
})

describe('reading another stall’s badge', () => {
  it('accepts the seller’s signed attestation', async () => {
    expect(await read(attestation(SELLER_SK, STALL, [bronze]))).toEqual([bronze])
  })

  it('refuses one the STALL signed for itself', async () => {
    expect(await read(attestation(STALL_SK, STALL, [{ ...bronze, badge: 'gold' }]))).toEqual([])
  })

  it('refuses a seller event whose content was edited after signing', async () => {
    const e = attestation(SELLER_SK, STALL, [bronze])
    expect(await read({ ...e, content: verificationJson(STALL, [{ ...bronze, badge: 'gold' }]) })).toEqual([])
  })

  it('refuses the seller’s attestation about a different stall served under this one', async () => {
    const other = getPublicKey(generateSecretKey())
    expect(await read(attestation(SELLER_SK, other, [bronze], verificationD(STALL)))).toEqual([])
  })

  it('shows nothing when this build pins no seller', async () => {
    expect(await read(attestation(SELLER_SK, STALL, [bronze]), { seller: '' })).toEqual([])
  })

  it('shows nothing when there is no attestation, or the read fails', async () => {
    expect(await read(null)).toEqual([])
    expect(
      await attestedWindows(STALL, { seller: SELLER, fetchNewest: async () => { throw new Error('offline') } }),
    ).toEqual([])
  })
})

describe('the stall’s own licences', () => {
  const grant = (over: Partial<LicenceGrant>): LicenceGrant => ({ features: [], expiresAt: NOW + DAY, pilot: false, ...over })

  it('Essentials is bronze, Pro is silver, Starter and unknown tiers none', () => {
    expect(badgeOf({ tier: 'basic' }, BUNDLED_CATALOG)).toBe('bronze')
    expect(badgeOf({ tier: 'pro' }, BUNDLED_CATALOG)).toBe('silver')
    expect(badgeOf({ tier: 'free' }, BUNDLED_CATALOG)).toBeNull()
    expect(badgeOf({ tier: 'custom' }, BUNDLED_CATALOG)).toBeNull()
    expect(badgeOf({}, BUNDLED_CATALOG)).toBeNull()
  })

  it('a hand grant earns the badge it names (#418 Q3), gold included', () => {
    expect(badgeOf({ tier: 'custom', badge: 'gold' }, BUNDLED_CATALOG)).toBe('gold')
    expect(badgeOf({ tier: 'custom', badge: 'platinum' }, BUNDLED_CATALOG)).toBeNull()
  })

  it('maps verified grants to windows, valid_from included', () => {
    const windows = grantWindows(
      [grant({ tier: 'basic', validFrom: NOW - DAY }), grant({ tier: 'free' }), grant({ tier: 'pro' })],
      BUNDLED_CATALOG,
    )
    expect(windows).toEqual([
      { badge: 'bronze', validFrom: NOW - DAY, validTo: NOW + DAY },
      { badge: 'silver', validFrom: 0, validTo: NOW + DAY },
    ])
  })

  it('a catalog that says nothing about badges awards none', () => {
    const old = parseCatalog(JSON.stringify({
      version: 9,
      overshoot_pct: 10,
      tiers: { free: { features: [], limits: {} }, basic: { features: ['terminals'], limits: {} } },
    }))!
    expect(badgeOf({ tier: 'basic' }, old)).toBeNull()
    const remapped = parseCatalog(JSON.stringify({
      version: 9,
      overshoot_pct: 10,
      tiers: { free: { features: [], limits: {} }, basic: { features: [], limits: {}, badge: 'gold' } },
    }))!
    expect(badgeOf({ tier: 'basic' }, remapped)).toBe('gold')
  })

  it('a grant signs its badge into the licence, and the wallet reads it back', () => {
    const meta = licenceMetadataJson({
      lockKey: STALL,
      subscriptionId: 'sub_g',
      paidAmountMinor: 0,
      paidCurrency: 'GBP',
      tier: 'custom',
      grantKind: 'custom',
      limits: { terminals: 5 },
      badge: 'gold',
    })
    const licence = licenceOf({
      issuerPublicKey: 'a'.repeat(64),
      issuerSignature: 'sig',
      merchantMetadata: meta,
      expiresAt: NOW + DAY,
    } as never)
    expect(licence?.badge).toBe('gold')
  })
})
