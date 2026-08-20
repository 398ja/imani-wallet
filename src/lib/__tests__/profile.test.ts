import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildProfileEvent,
  emptyProfile,
  mergeKind0,
  profileName,
  refreshProfile,
  saveProfile,
  type Profile,
} from '../profile'
import { fetchNewestKind0 } from '../branding'

vi.mock('../branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../branding')>()),
  fetchNewestKind0: vi.fn(),
}))

const PUBKEY = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'

const base = (over: Partial<Profile> = {}): Profile => ({ ...emptyProfile(PUBKEY), ...over })

const content = (fields: Record<string, unknown>) => JSON.stringify(fields)

describe('emptyProfile', () => {
  it('derives the npub from the pubkey', () => {
    expect(emptyProfile(PUBKEY).npub).toBe(
      'npub1gu50mzkk5t6u3yc0gpjng7g8ugscd7axcuaaqns5th7hszucu3gs2q2gk6',
    )
  })
})

describe('profileName', () => {
  it('prefers the display name, then the handle, then a short npub', () => {
    expect(profileName(base({ displayName: 'Alice', nip05: 'alice@imani.local' }))).toBe('Alice')
    expect(profileName(base({ nip05: 'alice@imani.local' }))).toBe('alice@imani.local')
    expect(profileName(base())).toBe('npub1gu50m…')
  })

  it('always returns something — Avatar derives initials from it', () => {
    expect(profileName(base())).not.toBe('')
  })
})

describe('mergeKind0', () => {
  it('reads display_name in preference to name', () => {
    const merged = mergeKind0(base(), content({ name: 'alice', display_name: 'Alice Smith' }))
    expect(merged.displayName).toBe('Alice Smith')
  })

  it('falls back to name when display_name is absent', () => {
    expect(mergeKind0(base(), content({ name: 'alice' })).displayName).toBe('alice')
  })

  it('keeps existing values when a field is absent', () => {
    // A sparse kind-0, or one written by a client that does not know every
    // field, must not silently wipe the user's profile on login.
    const merged = mergeKind0(base({ about: 'Shop', website: 'https://farm.example' }), content({ name: 'alice' }))
    expect(merged.about).toBe('Shop')
    expect(merged.website).toBe('https://farm.example')
  })

  it('keeps existing values when a field is present but empty', () => {
    const merged = mergeKind0(base({ about: 'Shop' }), content({ about: '   ' }))
    expect(merged.about).toBe('Shop')
  })

  it('drops picture and banner URLs that are not https or data', () => {
    // Anyone can publish a kind-0 claiming to be you, and these land in an
    // img src.
    const merged = mergeKind0(
      base(),
      content({ picture: 'javascript:alert(1)', banner: 'http://insecure.example/b.png' }),
    )
    expect(merged.picture).toBeUndefined()
    expect(merged.banner).toBeUndefined()
  })

  it('accepts an https picture', () => {
    const merged = mergeKind0(base(), content({ picture: 'https://blossom.example/a.png' }))
    expect(merged.picture).toBe('https://blossom.example/a.png')
  })

  it('returns the profile untouched on malformed JSON', () => {
    const original = base({ displayName: 'Alice' })
    expect(mergeKind0(original, 'not json at all')).toEqual(original)
  })

  describe('event ordering', () => {
    // Regression: the wallet PUBLISHES to the relay but READS the gateway's
    // nostrdb cache, which lags. Observed in a browser: rename yourself, log in
    // again, and the cached pre-rename kind-0 silently reverted the name.
    it('ignores an event older than the one already merged', () => {
      const current = base({ displayName: 'Alice at the Market', eventAt: 2000 })
      const stale = mergeKind0(current, content({ display_name: 'market_alice' }), 1000)
      expect(stale).toBe(current)
    })

    it('ignores an event with the same timestamp as the one already merged', () => {
      const current = base({ displayName: 'Alice at the Market', eventAt: 2000 })
      expect(mergeKind0(current, content({ display_name: 'market_alice' }), 2000)).toBe(current)
    })

    it('applies a newer event and advances eventAt', () => {
      const current = base({ displayName: 'Alice at the Market', eventAt: 2000 })
      const merged = mergeKind0(current, content({ display_name: 'Alice Renamed' }), 3000)
      expect(merged.displayName).toBe('Alice Renamed')
      expect(merged.eventAt).toBe(3000)
    })

    it('applies an event to a record that has never seen one', () => {
      const merged = mergeKind0(base(), content({ display_name: 'Alice' }), 3000)
      expect(merged.displayName).toBe('Alice')
      expect(merged.eventAt).toBe(3000)
    })

    it('still merges when no timestamp is supplied', () => {
      // Callers without a timestamp opt out of ordering rather than being
      // treated as ancient.
      const merged = mergeKind0(base({ eventAt: 9999 }), content({ display_name: 'Alice' }))
      expect(merged.displayName).toBe('Alice')
      expect(merged.eventAt).toBe(9999)
    })
  })
})

describe('buildProfileEvent', () => {
  const parse = (profile: Profile) =>
    JSON.parse(buildProfileEvent(profile).content) as Record<string, string>

  it('is a kind-0 with no tags', () => {
    const event = buildProfileEvent(base({ displayName: 'Alice' }))
    expect(event.kind).toBe(0)
    expect(event.tags).toEqual([])
  })

  it('writes both name spellings, because clients are split on which they read', () => {
    const parsed = parse(base({ displayName: 'Alice' }))
    expect(parsed.name).toBe('Alice')
    expect(parsed.display_name).toBe('Alice')
  })

  it('omits empty fields rather than sending empty strings', () => {
    // A kind-0 replaces the previous one wholesale, so "" is a positive
    // assertion that the field is blank.
    const parsed = parse(base({ displayName: 'Alice', about: '', website: '   ' }))
    expect(parsed).not.toHaveProperty('about')
    expect(parsed).not.toHaveProperty('website')
  })

  it('never emits lud16', () => {
    // This wallet has no lightning address. Writing an empty one would erase a
    // value the user may have set in another client.
    const parsed = parse(
      base({ displayName: 'Alice', about: 'Shop', website: 'https://farm.example' }),
    )
    expect(parsed).not.toHaveProperty('lud16')
  })

  it('carries the claimed handle through', () => {
    expect(parse(base({ nip05: 'alice@imani.local' })).nip05).toBe('alice@imani.local')
  })

  it('trims values', () => {
    expect(parse(base({ displayName: '  Alice  ' })).name).toBe('Alice')
  })
})

describe('refreshProfile', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    })
    vi.mocked(fetchNewestKind0).mockReset()
  })

  it('returns what is stored WHEN THE FETCH ENDS, not what was stored when it began', async () => {
    // Every login runs this concurrently with itself — the onboarding page
    // awaits one call and the app mounts another — and the fetch takes seconds.
    // A snapshot taken before the await comes back stale, and App.tsx puts the
    // result straight into state: the header rendered anonymous over a profile
    // that had already arrived, until the user reloaded the page.
    vi.mocked(fetchNewestKind0).mockImplementation(async () => {
      saveProfile({ ...emptyProfile(PUBKEY), displayName: 'Alice', eventAt: 500 })
      return null
    })

    expect((await refreshProfile(PUBKEY)).displayName).toBe('Alice')
  })

  it('merges against the stored copy the winner left behind', async () => {
    vi.mocked(fetchNewestKind0).mockImplementation(async () => {
      saveProfile({ ...emptyProfile(PUBKEY), displayName: 'Alice', eventAt: 500 })
      return { content: content({ name: 'Alice', picture: 'https://farm.example/a.png' }), createdAt: 900 }
    })

    const merged = await refreshProfile(PUBKEY)
    expect(merged.picture).toBe('https://farm.example/a.png')
    expect(merged.eventAt).toBe(900)
  })

  it('falls back to the stored profile when both stores are unreachable', async () => {
    saveProfile({ ...emptyProfile(PUBKEY), displayName: 'Alice' })
    vi.mocked(fetchNewestKind0).mockRejectedValue(new Error('offline'))

    expect((await refreshProfile(PUBKEY)).displayName).toBe('Alice')
  })
})
