/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * The onboarding "Log in" (#325): open a backup from Google Drive or a file,
 * see whose account it is, type the passphrase, and be in. It replaced the
 * separate /restore page and made pasting the key a small secondary link.
 *
 * Owner rule (2026-10-18): no account without a directory profile, so every
 * way in asks the directory for the key's handle before letting it in, and a
 * key with none is sent to "Finish your profile" instead.
 */

const PRIV = '1'.repeat(64)
const PUBKEY = getPublicKey(hexToBytes(PRIV))
const NPUB = nip19.npubEncode(PUBKEY)
const NSEC = nip19.nsecEncode(hexToBytes(PRIV))
const KEY_SLOT = 'imani-wallet-key'
const PASSPHRASE = 'correct horse battery'

const drive = vi.hoisted(() => ({ text: null as string | null }))
// The directory as staging behaves: the account's kind-0 names a handle, and
// that handle resolves forwards to this same key. `status: 404` = no kind-0 and
// no handle (an account that never finished its profile).
const directory = vi.hoisted(() => ({ status: 200 as number, nip05: 'amina@imani.africa' }))
const claimHandle = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../lib/drive', () => ({ getBackup: async () => drive.text }))

// The keystore, as nap's behaves: it opens whatever envelope sits in the slot,
// and only with the passphrase that envelope was sealed with.
vi.mock('../../lib/nap', async (orig) => ({
  ...(await orig<typeof import('../../lib/nap')>()),
  hasStoredKey: async () => localStorage.getItem('imani-wallet-key') !== null,
  keyStore: {
    hasKey: async () => localStorage.getItem('imani-wallet-key') !== null,
    loadKey: async (passphrase: string) => {
      const env = JSON.parse(localStorage.getItem('imani-wallet-key') ?? 'null') as { ciphertext?: string } | null
      if (!env || env.ciphertext !== `sealed:${passphrase}`) throw new Error('Invalid passphrase')
      return '1'.repeat(64)
    },
    save: async (_hex: string, passphrase: string) => {
      localStorage.setItem('imani-wallet-key', JSON.stringify({ ciphertext: `sealed:${passphrase}`, kdf: 'k', iv: 'i' }))
    },
  },
}))
vi.mock('../../lib/registration', async (orig) => ({
  ...(await orig<typeof import('../../lib/registration')>()),
  claimHandle,
}))
vi.mock('../../lib/relay', async (orig) => ({
  ...(await orig<typeof import('../../lib/relay')>()),
  publish: async () => ({ ok: 1, total: 1, errors: [] }),
  // The relay holds nothing; the gateway's answer decides.
  allEvents: async () => [],
}))
vi.mock('../../lib/config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'imani.africa' }) }))
// Offline: the relay never answers, so only the backup's own profile can name the account.
vi.mock('../../lib/profile', async (orig) => {
  const real = await orig<typeof import('../../lib/profile')>()
  return { ...real, refreshProfile: async (pubkey: string) => real.loadProfile(pubkey) ?? real.emptyProfile(pubkey) }
})
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentityState: () => ({ identity: undefined, loading: false }),
}))
vi.mock('../../hooks/useIsMerchant', () => ({ useIsMerchant: () => false }))
vi.mock('../../components/ParkedClaimBanner', () => ({ ParkedClaimBanner: () => null }))

const { OnboardingPage, RestoreRedirect } = await import('../OnboardingPage')
const { LoginPage } = await import('../LoginPage')

const backupText = (profile: unknown = {
  pubkey: PUBKEY,
  npub: NPUB,
  displayName: 'Amina',
  nip05: 'amina@imani.africa',
  picture: 'https://example.com/amina.png',
  updatedAt: 1,
}) =>
  JSON.stringify({
    format: 'imani-wallet-backup',
    version: 1,
    createdAt: '2026-10-18T00:00:00Z',
    npub: NPUB,
    pubkey: PUBKEY,
    key: { ciphertext: `sealed:${PASSPHRASE}`, kdf: 'k', iv: 'i' },
    profile,
  })

let onUnlock: ReturnType<typeof vi.fn<(hex: string) => Promise<void>>>

function renderOnboarding(entry: string | { pathname: string; state: unknown } = '/onboarding') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage onUnlock={onUnlock} />} />
        <Route path="/restore" element={<RestoreRedirect />} />
        <Route path="/login" element={<LoginPage onUnlock={onUnlock} />} />
        <Route path="/" element={<p>Home screen</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** From the first screen to "Where is your backup?". */
function openLogIn() {
  const view = renderOnboarding()
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  screen.getByText('Where is your backup?')
  return view
}

function pickFile(container: HTMLElement, text: string, name = 'backup.json') {
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => text })
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

async function logInWith(passphrase: string) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

beforeEach(() => {
  localStorage.clear()
  drive.text = null
  directory.status = 200
  directory.nip05 = 'amina@imani.africa'
  claimHandle.mockClear()
  onUnlock = vi.fn(async () => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/nostr/query') {
        if (directory.status >= 500) return new Response('{}', { status: directory.status })
        const events =
          directory.status === 200
            ? [{ pubkey: PUBKEY, kind: 0, createdAt: 1, content: JSON.stringify({ name: 'amina', nip05: directory.nip05 }) }]
            : []
        return new Response(JSON.stringify({ events, count: events.length }), { status: 200 })
      }
      if (url === `/api/v1/resolve/${encodeURIComponent(directory.nip05)}`) {
        if (directory.status !== 200) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify({ nip05: directory.nip05, hex_pubkey: PUBKEY, source: 'EXTERNAL' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('logging in from a backup', () => {
  // The main path from Google Drive: choose Drive, see the account by face and
  // name with no key, type the passphrase, and land in the wallet unlocked.
  it('Drive -> profile -> passphrase -> in', async () => {
    drive.text = backupText()
    const { container } = openLogIn()

    fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }))
    await screen.findByText('Amina')
    expect(screen.getByRole('img', { name: 'Amina' }).getAttribute('src')).toBe('https://example.com/amina.png')
    expect(screen.getByText('@amina')).toBeTruthy()
    expect(container.textContent).not.toMatch(/npub|nsec/i)

    await logInWith(PASSPHRASE)

    await screen.findByText('Home screen')
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
    expect(localStorage.getItem(KEY_SLOT)).toContain(`sealed:${PASSPHRASE}`)
  })

  // The same path from a file chosen off disk.
  it('file -> profile -> passphrase -> in', async () => {
    const { container } = openLogIn()

    pickFile(container, backupText())
    await screen.findByText('Amina')
    expect(container.textContent).not.toMatch(/npub|nsec/i)

    await logInWith(PASSPHRASE)

    await screen.findByText('Home screen')
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
  })

  // The account's name appears once, in the profile row, not again in a
  // "Loaded @amina" sentence under it (review nit on the old restore page).
  it('names the account once', async () => {
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')
    expect(screen.getAllByText(/@amina/)).toHaveLength(1)
    expect(container.textContent).not.toMatch(/Loaded/)
  })

  // A wrong passphrase says so in plain words, under the field, and leaves the
  // device exactly as it was: applyBackup rolls the key slot back.
  it('a wrong passphrase gives a clear error and writes nothing', async () => {
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')

    await logInWith('not the passphrase')

    expect((await screen.findByRole('alert')).textContent).toMatch(/passphrase does not open this backup/i)
    expect(localStorage.getItem(KEY_SLOT)).toBeNull()
    expect(Object.keys(localStorage).filter((k) => k.startsWith('imani-wallet:profile:'))).toEqual([])
    expect(onUnlock).not.toHaveBeenCalled()
  })

  // A Google account with no backup in it says so, and the two choices are
  // still right there to try again.
  it('says so when Google Drive holds no backup', async () => {
    drive.text = null
    openLogIn()

    fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/That Google account has no wallet backup/)
    expect(screen.getByRole('button', { name: /Google Drive/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /A backup file/ })).toBeTruthy()
  })

  // A file that is not a wallet backup is refused by name, nothing is written,
  // and the choices stay on screen.
  it('refuses a file that is not a backup', async () => {
    const { container } = openLogIn()

    pickFile(container, 'hello', 'notes.txt')

    expect((await screen.findByRole('alert')).textContent).toMatch(/not a wallet backup/)
    expect(screen.getByRole('button', { name: /A backup file/ })).toBeTruthy()
    expect(localStorage.getItem(KEY_SLOT)).toBeNull()
  })

  // An older backup carries no npub and no profile. It is still the
  // customer's own account, so it is never shown as "Unnamed account".
  it('an older backup with no profile is "Your account", never "Unnamed"', async () => {
    const old = JSON.stringify({
      format: 'imani-wallet-backup',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      key: { ciphertext: `sealed:${PASSPHRASE}`, kdf: 'k', iv: 'i' },
    })
    const { container } = openLogIn()
    pickFile(container, old)
    await screen.findByText('Your account')
    expect(container.textContent).not.toMatch(/Unnamed/i)
  })

  // A backup that names its account but carries no profile: still "Your
  // account", and no fragment of the key.
  it('a backup with no profile shows no key fragment', async () => {
    const { container } = openLogIn()
    pickFile(container, backupText(null))
    await screen.findByText('Your account')
    expect(container.textContent).not.toContain(PUBKEY.slice(0, 8))
    expect(container.textContent).not.toMatch(/Unnamed|npub/i)
  })

  // "Choose another backup" goes back to the two choices from the account step.
  it('goes back to the choice from the account step', async () => {
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')

    fireEvent.click(screen.getByRole('button', { name: 'Choose another backup' }))

    expect(screen.getByText('Where is your backup?')).toBeTruthy()
  })
})

describe('no account without a profile', () => {
  // The directory, not the backup file, decides: a backup whose key has no
  // directory record is not let in. Nothing stays on the device, and the
  // customer picks a handle before the wallet opens.
  it('a backup with no directory profile must finish its profile first', async () => {
    directory.status = 404
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')

    await logInWith(PASSPHRASE)

    await screen.findByText('Finish your profile')
    expect(onUnlock).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY_SLOT)).toBeNull()

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))

    await screen.findByText('Home screen')
    expect(claimHandle).toHaveBeenCalledWith('amina', PUBKEY, expect.anything())
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
    expect(localStorage.getItem(KEY_SLOT)).toContain(`sealed:${PASSPHRASE}`)
    const stored = JSON.parse(localStorage.getItem(`imani-wallet:profile:${PUBKEY}`) ?? '{}') as { nip05?: string }
    expect(stored.nip05).toBe('amina@imani.africa')
  })

  // A claim whose kind-0 never reached the relay: the directory holds
  // amina -> this key, no kind-0 names it. The backup's own handle is checked
  // (forwards), so the customer logs straight in instead of being asked for a
  // second handle on a fresh device.
  it('a backup whose kind-0 never published logs in by the handle the backup names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/nostr/query') return new Response(JSON.stringify({ events: [], count: 0 }))
        if (url === `/api/v1/resolve/${encodeURIComponent('amina@imani.africa')}`) {
          return new Response(JSON.stringify({ nip05: 'amina@imani.africa', hex_pubkey: PUBKEY }))
        }
        return new Response('{}', { status: 404 })
      }),
    )
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')

    await logInWith(PASSPHRASE)

    await screen.findByText('Home screen')
    expect(screen.queryByText('Finish your profile')).toBeNull()
    expect(claimHandle).not.toHaveBeenCalled()
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
  })

  // The claim went through but logging in failed: the customer is told, stays
  // on the step with the button live, and pressing it again finishes. The
  // retry re-sends the claim, which is safe because a claim is idempotent for
  // the same key (claimIdempotency.test.ts).
  it('Finish your profile can be retried after a failure, and finishes', async () => {
    directory.status = 404
    onUnlock.mockRejectedValueOnce(new Error('Could not log in just now. Try again.'))
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')
    await logInWith(PASSPHRASE)
    await screen.findByText('Finish your profile')

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not log in just now/)
    expect(screen.getByText('Finish your profile')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))
    await screen.findByText('Home screen')
    expect(claimHandle).toHaveBeenCalledTimes(2)
    expect(onUnlock).toHaveBeenLastCalledWith(PRIV)
    expect(localStorage.getItem(KEY_SLOT)).toContain(`sealed:${PASSPHRASE}`)
  })

  // A directory that cannot be reached is not read as "no profile": the
  // customer is told to try again and nothing is written.
  it('fails closed when the directory cannot be asked', async () => {
    directory.status = 502
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByText('Amina')

    await logInWith(PASSPHRASE)

    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not check your profile/)
    expect(screen.queryByText('Finish your profile')).toBeNull()
    expect(localStorage.getItem(KEY_SLOT)).toBeNull()
    expect(onUnlock).not.toHaveBeenCalled()
  })

  // The secondary key path obeys the same rule: a pasted key with no profile
  // stores nothing until a handle is claimed.
  it('the backup key path also requires a profile', async () => {
    directory.status = 404
    openLogIn()
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))

    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByText('Finish your profile')
    expect(localStorage.getItem(KEY_SLOT)).toBeNull()
    expect(onUnlock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))

    await screen.findByText('Home screen')
    expect(claimHandle).toHaveBeenCalledWith('amina', PUBKEY, expect.anything())
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
  })
})

describe('the backup key, as the secondary way in', () => {
  // One small link under the choices leads to the paste-key step, so someone
  // who only ever saved the key is not locked out; with a profile, they are in.
  it('"Use your backup key instead" leads to the key step and logs in', async () => {
    openLogIn()

    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    expect(screen.getByText('Use your backup key')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByText('Home screen')
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
    expect(claimHandle).not.toHaveBeenCalled()
  })
})

describe('/restore and the old links', () => {
  // Old links, bookmarks and the re-auth dialog's advice still say /restore:
  // it lands on the Log in step that now does the job.
  it('/restore redirects to the onboarding Log in step', () => {
    renderOnboarding('/restore')
    expect(screen.getByText('Where is your backup?')).toBeTruthy()
  })

  // Back from the redirected step stays in the app, on the first screen.
  it('Back from the redirected step goes to the first screen', () => {
    renderOnboarding('/restore')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy()
  })

  // "Log in" is the restore now, so no separate Restore link remains, on the
  // first screen or on the unlock screen.
  it('no Restore link remains', async () => {
    renderOnboarding()
    expect(screen.queryByRole('link', { name: /restore/i })).toBeNull()
    expect(document.querySelector('a[href="/restore"]')).toBeNull()
    cleanup()

    localStorage.setItem(KEY_SLOT, JSON.stringify({ ciphertext: 'x', kdf: 'k', iv: 'i' }))
    renderOnboarding('/login')
    await screen.findByRole('button', { name: 'Unlock' })
    expect(screen.queryByRole('link', { name: /restore/i })).toBeNull()
    expect(document.querySelector('a[href="/restore"]')).toBeNull()
  })
})

describe('the /login unlock', () => {
  // Unchanged: a device that still holds its key asks only for the passphrase,
  // under the stored profile, and offers "Use a different account".
  it('is still passphrase-only, with the profile', async () => {
    localStorage.setItem(KEY_SLOT, JSON.stringify({ ciphertext: `sealed:${PASSPHRASE}`, kdf: 'k', iv: 'i' }))
    localStorage.setItem(
      `imani-wallet:profile:${PUBKEY}`,
      JSON.stringify({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', nip05: 'amina@imani.africa', updatedAt: 1 }),
    )
    renderOnboarding('/login')

    await screen.findByRole('button', { name: 'Unlock' })
    expect(screen.getByRole('heading', { name: 'Amina' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Passphrase')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Use a different account' }).getAttribute('href')).toBe('/onboarding')
    expect(screen.queryByText('Where is your backup?')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(PRIV))
  })
})

describe('wording', () => {
  // Customers never meet protocol terms or raw keys on any of these screens.
  it('shows no npub, nsec or Nostr on the Log in screens', async () => {
    drive.text = backupText()
    const { container } = openLogIn()
    const clean = () => expect(container.textContent).not.toMatch(/npub|nsec|nostr/i)
    const placeholders = () =>
      Array.from(container.querySelectorAll('input')).map((i) => i.getAttribute('placeholder') ?? '').join(' ')

    clean()
    fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }))
    await screen.findByText('Amina')
    clean()
    expect(placeholders()).not.toMatch(/npub|nsec|nostr/i)

    fireEvent.click(screen.getByRole('button', { name: 'Choose another backup' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    clean()
    expect(placeholders()).not.toMatch(/npub|nsec|nostr/i)
  })
})

describe('another wallet on this device (#330)', () => {
  const OTHER = 'f'.repeat(64)
  function otherWalletHere() {
    localStorage.setItem(KEY_SLOT, JSON.stringify({ ciphertext: 'sealed:their-passphrase', kdf: 'k', iv: 'i' }))
    localStorage.setItem(`imani-wallet:profile:${OTHER}`, JSON.stringify({ pubkey: OTHER }))
  }

  it('pasting a different account key is refused in plain words, and the other key stays', async () => {
    otherWalletHere()
    const before = localStorage.getItem(KEY_SLOT)
    openLogIn()
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByText(/already holds another wallet/)
    expect(onUnlock).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY_SLOT)).toBe(before)
  })

  it('opening a different account backup is refused, and the other key stays', async () => {
    otherWalletHere()
    const before = localStorage.getItem(KEY_SLOT)
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByLabelText('Passphrase')
    await logInWith(PASSPHRASE)

    await screen.findByText(/already holds another wallet/)
    expect(onUnlock).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY_SLOT)).toBe(before)
  })

  // Review of #340: another wallet arriving while "Finish your profile" is open
  // (another tab finished its own login) refuses BEFORE the handle is claimed.
  it('pasted key, no profile: a wallet that arrived meanwhile refuses before any handle is claimed', async () => {
    directory.status = 404
    openLogIn()
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await screen.findByText('Finish your profile')

    otherWalletHere()
    const before = localStorage.getItem(KEY_SLOT)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))

    await screen.findByText(/already holds another wallet/)
    expect(claimHandle).not.toHaveBeenCalled()
    expect(onUnlock).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY_SLOT)).toBe(before)
    expect(localStorage.getItem(`imani-wallet:profile:${PUBKEY}`)).toBeNull()
  })

  it('backup file, no profile: a wallet that arrived meanwhile refuses before any handle is claimed', async () => {
    directory.status = 404
    const { container } = openLogIn()
    pickFile(container, backupText())
    await screen.findByLabelText('Passphrase')
    await logInWith(PASSPHRASE)
    await screen.findByText('Finish your profile')

    otherWalletHere()
    const before = localStorage.getItem(KEY_SLOT)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))

    await screen.findByText(/already holds another wallet/)
    expect(claimHandle).not.toHaveBeenCalled()
    expect(onUnlock).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY_SLOT)).toBe(before)
  })

  it('pasting a different account key is refused before the directory is even asked', async () => {
    otherWalletHere()
    openLogIn()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await screen.findByText(/already holds another wallet/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the same account, already on this device, logs in again', async () => {
    localStorage.setItem(KEY_SLOT, JSON.stringify({ ciphertext: 'sealed:old', kdf: 'k', iv: 'i' }))
    localStorage.setItem(`imani-wallet:profile:${PUBKEY}`, JSON.stringify({ pubkey: PUBKEY }))
    openLogIn()
    fireEvent.click(screen.getByRole('button', { name: 'Use your backup key instead' }))
    fireEvent.change(screen.getByLabelText('Backup key'), { target: { value: NSEC } })
    fireEvent.change(screen.getByPlaceholderText('Choose a passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: PASSPHRASE } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByText('Home screen')
    expect(onUnlock).toHaveBeenCalledWith(PRIV)
  })
})
