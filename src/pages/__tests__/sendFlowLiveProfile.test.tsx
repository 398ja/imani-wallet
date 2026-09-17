/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { brandingFromKind0 } from '../../lib/branding'
import { identityLabel, identitySubLabel, humanName } from '../../lib/identity'

/**
 * The real staging kind-0, through the real mapping.
 *
 * The unit tests stub `merchantBranding`, which is right for the component's
 * decision but proves nothing about the SHAPE of what staging actually serves.
 * This pins the whole chain — the live kind-0 content, `brandingFromKind0`, and
 * the label ladder — against the exact bytes fetched from the gateway, so a
 * field named differently upstream fails here rather than in someone's hand.
 */
const LIVE = '{"name":"magneto","display_name":"magneto","nip05":"magneto@staging.398ja.xyz"}'
const PUBKEY = '8205d1c1c9294c22023d85df2e1d450f08b2e8d3677a72d2af7879d4c1e4a9d1'

describe('a real staging profile', () => {
  it('names them and shows their handle, not a key', () => {
    const b = brandingFromKind0(LIVE)
    const identity = { name: b.organizationName, nip05: b.nip05, picture: b.logoUrl }

    expect(identityLabel(PUBKEY, identity)).toBe('magneto')
    expect(identitySubLabel(identity)).toBe('@magneto')
    expect(identityLabel(PUBKEY, identity)).not.toMatch(/8205d1c1/)
  })

  /** The exact bug: the coupon's "name" is the issuer's hex id. */
  it('rejects the hex placeholder a coupon carries as a name', () => {
    expect(humanName(PUBKEY)).toBeUndefined()
  })
})
