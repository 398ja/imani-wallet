/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools'

/**
 * The device side of setup, driven as a screen (#160 phase 2, spec 2.2).
 *
 * Only the network edge is faked: a mailbox standing in for the relay and gateway. The real
 * `terminalEnrol`, the real NIP-17 wraps and real signed credentials run, so the screen is
 * proven against the same bytes a real owner's phone would send. The key store is faked
 * because jsdom has no IndexedDB.
 */

const saved: Array<{ privkeyHex: string; passphrase: string }> = []
vi.mock('../../lib/nap', () => ({
  keyStore: {
    save: async (privkeyHex: string, passphrase: string) => void saved.push({ privkeyHex, passphrase }),
    hasKey: async () => false,
  },
  getSigner: () => {
    throw new Error('a terminal in setup has no session signer')
  },
}))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }))
// The camera is not under test: the stub hands the typed text straight to the page.
vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onText }: { onText?: (t: string) => boolean }) => (
    <input aria-label="setup code" onChange={(e) => onText?.(e.target.value)} />
  ),
}))

const confirmed: string[] = []
const { TerminalSetupPage } = await import('../TerminalSetupPage')
const { forgetPendingKey, forgetTerminal, storedTerminal } = await import('../../lib/terminalEnrol')
const { credentialMessageJson, unwrapSealed, wrapMessage } = await import('../../lib/terminalDelivery')
const { checkCode, formatCheckCode } = await import('../../lib/terminalMint')
const { setupCode } = await import('../../lib/terminalDelivery')

/** The operator scans the owner's setup code for this stall and credential. */
function scanSetupCode(stall = STALL, voucherId = VOUCHER_ID) {
  fireEvent.change(screen.getByLabelText('setup code'), { target: { value: setupCode(stall, voucherId) } })
}
const { buildLockedCredentialToken } = await import('../../lib/__tests__/voucherFixtures')

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const VOUCHER_ID = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'

/** The relay, as a mailbox keyed by recipient. */
let mailbox: Event[] = []
const published: Event[] = []

function renderPage() {
  return render(
    <MemoryRouter>
      <TerminalSetupPage
        fetchWraps={async (pubkey) => mailbox.filter((e) => e.tags.some((t) => t[1] === pubkey))}
        stallName={async () => 'Test Stall'}
        publisherFor={() => ({ publish: async (w) => (published.push(w), true) })}
        confirmAtGateway={async (id) => void confirmed.push(id)}
      />
    </MemoryRouter>,
  )
}

/** The device's code, read off the screen the way the owner's camera would. */
const shownCode = () => screen.getByTestId('terminal-code').textContent!.trim()

/** The owner's phone sends a credential to the code it scanned. */
function ownerSends(device: string, sealKey = STALL_KEY) {
  mailbox.push(
    wrapMessage(
      sealKey,
      device,
      credentialMessageJson({
        voucherId: VOUCHER_ID,
        token: buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: device, voucherId: VOUCHER_ID }),
        stallPubkey: STALL,
        name: 'Front counter',
        idleLockMinutes: 10,
      }),
    ),
  )
}

// The build names the key that signs terminal credentials, as every deploy must now: a terminal
// credential whose signer is not on VITE_VOUCHER_ISSUER_PUBKEYS is refused (#160 review, IW-15).
beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
  localStorage.clear()
  saved.length = 0
  published.length = 0
  mailbox = []
  forgetPendingKey()
  forgetTerminal()
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('showing the code', () => {
  // The device shows its public key and says plainly that it is not a secret.
  // Nothing is stored just for showing it.
  it('shows a public key, says it is not a secret, and stores nothing', () => {
    renderPage()

    expect(shownCode()).toMatch(/^[0-9a-f]{64}$/)
    expect(screen.getByText(/This code is not a secret/)).toBeTruthy()
    expect(localStorage.length).toBe(0)
  })
})

describe('the whole setup, owner and device', () => {
  // Spec 2.2 end to end: the owner sends, the device shows the stall's name
  // and the same check code, the operator confirms and sets a passphrase, the
  // device stores its authority and tells the stall it is in service.
  // Real NIP-44 and Schnorr work on every poll: given room under a loaded suite.
  it('receives, confirms, sets a passphrase, stores and announces', { timeout: 20_000 }, async () => {
    renderPage()
    const device = shownCode()
    scanSetupCode()
    ownerSends(device)

    expect(await screen.findByText('Test Stall', {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.getByText(formatCheckCode(checkCode(VOUCHER_ID, STALL, device)))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'They match' }))
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'counter-pass' } })
    fireEvent.change(screen.getByLabelText('Repeat passphrase'), { target: { value: 'counter-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))

    expect(await screen.findByText(/This terminal is set up/)).toBeTruthy()
    expect(storedTerminal()?.stallPubkey).toBe(STALL)
    expect(storedTerminal()?.terminalPubkey).toBe(device)
    expect(storedTerminal()?.voucherId).toBe(VOUCHER_ID)
    // The enrolled DM went to the stall and is sealed by this device.
    expect(published).toHaveLength(1)
    expect(unwrapSealed(published[0], STALL_KEY)?.sealer).toBe(device)
    // And the private key is in no element of the page.
    expect(document.body.innerHTML).not.toContain(saved[0].privkeyHex)
  })

  // Decision 2: a short passphrase is refused on the screen, before storing.
  // Real NIP-44 and Schnorr work on every poll: given room under a loaded suite.
  it('refuses a passphrase under 8 characters', { timeout: 20_000 }, async () => {
    renderPage()
    scanSetupCode()
    ownerSends(shownCode())
    await screen.findByText('Test Stall', {}, { timeout: 8000 })
    fireEvent.click(screen.getByRole('button', { name: 'They match' }))
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'short' } })
    fireEvent.change(screen.getByLabelText('Repeat passphrase'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))

    expect(await screen.findByText(/at least 8 characters/)).toBeTruthy()
    expect(storedTerminal()).toBeNull()
    expect(saved).toEqual([])
  })

  // An operator who sees the wrong stall or code says so, and nothing is
  // stored: the device goes back to waiting for the right one.
  it('stores nothing when the operator says the codes do not match', { timeout: 15_000 }, async () => {
    renderPage()
    scanSetupCode()
    ownerSends(shownCode())
    await screen.findByText('Test Stall', {}, { timeout: 8000 })

    // The wrong offer stays in the mailbox: the device must not show it again.
    fireEvent.click(screen.getByRole('button', { name: 'They do not match' }))

    expect(await screen.findByText(/Waiting for the owner/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 4500))
    expect(screen.queryByRole('button', { name: 'They match' })).toBeNull()
    expect(storedTerminal()).toBeNull()
    expect(saved).toEqual([])
  })

  // A credential sealed by someone other than the stall it names arrives at
  // this public key. It is refused in words and nothing is offered.
  // Real NIP-44 and Schnorr work on every poll: given room under a loaded suite.
  it('refuses a credential sealed by another key, and says so', { timeout: 20_000 }, async () => {
    renderPage()
    scanSetupCode()
    ownerSends(shownCode(), generateSecretKey())

    expect(await screen.findByText(/not sent by the stall it names/, {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'They match' })).toBeNull()
    expect(storedTerminal()).toBeNull()
  })
})

describe('#160 review: the operator binds setup to the owner\'s screen', () => {
  // The hijack: an onlooker who read the device's code sends their own,
  // well-formed offer, sealed by their own key. Before the fix the device
  // showed the newest acceptable offer, which could be theirs. Now the device
  // waits for the owner's setup code and shows only the offer it names, so the
  // intruder's offer is never on screen even when it arrives first.
  it('never shows an intruder\'s offer, and shows the owner\'s', { timeout: 20_000 }, async () => {
    renderPage()
    const device = shownCode()
    const intruderKey = generateSecretKey()
    const intruder = getPublicKey(intruderKey)
    mailbox.push(
      wrapMessage(
        intruderKey,
        device,
        credentialMessageJson({
          voucherId: 'bbbbbbbb-6cea-4a7d-b681-9d5d62cc9dd9',
          token: buildLockedCredentialToken({
            stallKey: intruderKey,
            devicePubkey: device,
            voucherId: 'bbbbbbbb-6cea-4a7d-b681-9d5d62cc9dd9',
          }),
          stallPubkey: intruder,
          name: 'Front counter',
          idleLockMinutes: 10,
        }),
      ),
    )
    scanSetupCode()
    ownerSends(device)

    expect(await screen.findByText('Test Stall', {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.getByText(formatCheckCode(checkCode(VOUCHER_ID, STALL, device)))).toBeTruthy()
  })

  // Nothing is offered before the setup code is scanned, whatever arrives.
  it('offers nothing before the setup code is scanned', { timeout: 15_000 }, async () => {
    renderPage()
    ownerSends(shownCode())
    await new Promise((r) => setTimeout(r, 4500))

    expect(screen.queryByText('Check this is your stall')).toBeNull()
    expect(screen.getByText(/scan it here/)).toBeTruthy()
  })

  // Something that is not a setup code is refused in words.
  it('refuses text that is not a setup code', () => {
    renderPage()
    fireEvent.change(screen.getByLabelText('setup code'), { target: { value: `nostr:${STALL}` } })

    expect(screen.getByText(/not a terminal setup code/)).toBeTruthy()
  })

  // On finishing, the device tells the gateway the credential arrived, so its
  // pending count frees the slot and the credential may issue.
  it('confirms the credential at the gateway', { timeout: 20_000 }, async () => {
    confirmed.length = 0
    renderPage()
    scanSetupCode()
    ownerSends(shownCode())
    await screen.findByText('Test Stall', {}, { timeout: 8000 })
    fireEvent.click(screen.getByRole('button', { name: 'They match' }))
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'counter-pass' } })
    fireEvent.change(screen.getByLabelText('Repeat passphrase'), { target: { value: 'counter-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))

    await screen.findByText(/This terminal is set up/)
    expect(confirmed).toEqual([VOUCHER_ID])
  })
})
