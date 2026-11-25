import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'

import { Screen, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import {
  MIN_PASSPHRASE_LENGTH,
  beginEnrolment,
  completeEnrolment,
  offersFor,
  type EnrolmentAnnouncer,
  type EnrolmentCode,
} from '../lib/terminalEnrol'
import {
  enrolledMessageJson,
  parseSetupCode,
  type CredentialOffer,
  type ExpectedOffer,
  type OfferRefusal,
  type WrapPublisher,
} from '../lib/terminalDelivery'
import { devicePublisher, giftWraps } from '../lib/terminalDeliveryNet'
import { type RequestSigner } from '../lib/nip98'
import { deviceConfirm } from '../lib/terminalConfirm'
import { ScanRecipient } from '../components/ScanRecipient'
import { formatCheckCode } from '../lib/terminalMint'
import { refreshProfile, profileName, type Profile } from '../lib/profile'
import { TERMINAL_ROLE_LABELS, grantFor } from '../lib/terminalRole'
import type { Event } from 'nostr-tools'
import { userMessage } from '../lib/userMessage'

/**
 * A fresh device becomes a terminal (#160 phase 2, spec 2.2).
 *
 * 1. Show the device's public key as a QR and as text. It lives in memory only, so a reload
 *    starts over with a new code: a photographed code from yesterday names nothing.
 * 2. Scan the owner's setup code (`imani-terminal:1:<stall>:<voucher id>`), which names the
 *    stall and the credential this device is to accept (#160 review). Then poll for a
 *    credential DM addressed to that key, opened and checked inside `terminalEnrol.offersFor`,
 *    so the private half never leaves that module. Only the DM sealed by that stall for that
 *    credential is accepted; the device never picks among offers.
 * 3. Show the stall's public name and the check code, and ask the operator to confirm both
 *    match the owner's screen. `K` is public, so anyone can DM it a credential for THEIR
 *    stall; the code is what tells the operator which stall this is.
 * 4. Take a passphrase of at least 8 characters, store, and tell the stall "enrolled".
 *
 * Reached only with no key on the device (`Entry` sends a device holding a key elsewhere), and
 * `completeEnrolment` refuses anyway while a key is held, so this cannot overwrite a wallet.
 */

/** How often the device looks for its credential while the code is on screen. */
const POLL_MS = 4_000

/** Plain words for each refusal, because the operator has a queue and no logs. */
const REFUSAL_COPY: Record<Exclude<OfferRefusal, 'not-a-credential-dm'>, string> = {
  stale: 'An authority arrived that is more than a day old. Ask the owner to add this device again.',
  'from-the-future': 'An authority arrived dated in the future. It was ignored. Check this device’s clock.',
  'not-the-expected-offer':
    'An authority arrived that is not the one the owner’s setup code names. It was ignored.',
  'unknown-issuer': 'An authority arrived signed by a service this app does not trust. It was ignored.',
  'sealed-by-another': 'An authority arrived that was not sent by the stall it names. It was ignored.',
  unreadable: 'An authority arrived that could not be read. It was ignored.',
  'not-locked-to-this-device': 'An authority arrived for a different device. It was ignored.',
  'wrong-issuer': 'An authority arrived for a different stall than it claims. It was ignored.',
  'bad-signature': 'An authority arrived whose signature does not check out. It was ignored.',
}

export interface TerminalSetupDeps {
  /** Gift wraps addressed to `pubkey`. Relay plus gateway otherwise. */
  fetchWraps?: (pubkey: string, sinceSeconds: number) => Promise<Event[]>
  /**
   * The stall's public name, from its public records. `onLater` gets a name that arrives after the
   * first answer (a slower store, round 4), so the screen can correct "no public name".
   */
  stallName?: (stallPubkey: string, onLater?: (name: string) => void) => Promise<string | null>
  /** Where the enrolled DM goes, given the terminal's own NIP-98 signer. */
  publisherFor?: (announcer: EnrolmentAnnouncer) => WrapPublisher
  /**
   * Tells the gateway the credential arrived, so it counts as in service and stops waiting
   * (gateway-customer#187). Best effort: the enrolled DM is what the owner's list reads.
   */
  confirmAtGateway?: (voucherId: string, signer: RequestSigner) => Promise<void>
}

/**
 * The stall's public name: its kind-0 display name or handle, from the public relay (ADR 0012).
 * Null when it has published neither, and the screen then says so rather than inventing one.
 */
async function publicStallName(stallPubkey: string, onLater?: (name: string) => void): Promise<string | null> {
  const named = (p: Profile | null) => (!p || (!p.displayName && !p.nip05) ? null : profileName(p))
  const profile = await refreshProfile(stallPubkey, (later) => {
    const n = named(later)
    if (n) onLater?.(n)
  }).catch(() => null)
  return named(profile)
}

export function TerminalSetupPage({
  fetchWraps = giftWraps,
  stallName = publicStallName,
  publisherFor = (a) => devicePublisher(a.signer),
  confirmAtGateway = deviceConfirm,
}: TerminalSetupDeps = {}) {
  // Minted once, in memory, on first render. Lazy so a re-render shows the same code.
  const [code] = useState<EnrolmentCode>(() => beginEnrolment())
  const [startedAt] = useState(() => Math.floor(Date.now() / 1000))
  const [qr, setQr] = useState<string | null>(null)
  const [offer, setOffer] = useState<CredentialOffer | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // Offers the operator said did not match. Ignored for the rest of this setup,
  // so the poller does not put the same wrong stall back on screen.
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set())
  // The stall and credential the owner's setup code names. Nothing is accepted until the
  // operator has scanned it, so the device never chooses among offers (#160 review).
  const [expected, setExpected] = useState<ExpectedOffer | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)

  useEffect(() => {
    void QRCode.toDataURL(code.uri, { width: 512, margin: 1 }).then(setQr, () => setQr(null))
  }, [code.uri])

  // Look for the ONE credential the setup code names. There is no "newest wins": an offer
  // from anyone else is refused, and refusals are shown so the operator knows something
  // arrived.
  const poll = useCallback(async () => {
    if (!expected) return false
    const wraps = await fetchWraps(code.terminalPubkey, startedAt)
    const results = offersFor(wraps, undefined, expected)
    const accepted = results.find(
      (r): r is CredentialOffer => typeof r !== 'string' && !rejected.has(r.voucherId),
    )
    if (accepted) {
      setOffer(accepted)
      setRefusal(null)
      return true
    }
    // Someone else's offer is not news worth interrupting the operator with once the right
    // one is expected; it is reported only when nothing else explains the wait.
    const refused =
      results.find(
        (r): r is Exclude<OfferRefusal, 'not-a-credential-dm'> =>
          typeof r === 'string' && r !== 'not-the-expected-offer',
      ) ??
      results.find((r): r is Exclude<OfferRefusal, 'not-a-credential-dm'> => typeof r === 'string')
    if (refused) setRefusal(REFUSAL_COPY[refused])
    return false
  }, [fetchWraps, code.terminalPubkey, startedAt, rejected, expected])

  useEffect(() => {
    if (offer || !expected) return
    let stopped = false
    const tick = async () => {
      try {
        if (!stopped) await poll()
      } catch {
        // Offline. The code stays on screen and the next tick tries again.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [offer, poll, expected])

  useEffect(() => {
    if (!offer) return
    let cancelled = false
    // A name that arrives late (the slower of the gateway and the relay) replaces "no public
    // name"; it never replaces a name already shown with nothing.
    void stallName(offer.stallPubkey, (n) => {
      if (!cancelled) setName(n)
    })
      .catch(() => null)
      .then((n) => {
        if (!cancelled) setName((shown) => n ?? shown)
      })
    return () => {
      cancelled = true
    }
  }, [offer, stallName])

  const finish = async () => {
    if (!offer) return
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`)
      return
    }
    if (passphrase !== repeat) {
      setError('The two passphrases do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Not IW-15: `offer.metadata` is parsed from the credential's own signed bytes, verified
      // in `offerFromRumor`, not read from storage. `completeEnrolment` re-verifies it.
      // nosemgrep: imani-role-from-local-storage
      await completeEnrolment(
        {
          stallPubkey: offer.metadata.stall_pubkey,
          role: offer.metadata.role,
          lockedTo: offer.metadata.lock_key,
          // The grant for the role the SIGNED metadata names, which
          // `terminalActor` checks against that role. Nothing here widens it.
          permissions: grantFor(offer.metadata.role, offer.metadata.stall_pubkey),
        },
        passphrase,
        offer.name,
        { token: offer.token },
        {
          voucherId: offer.voucherId,
          idleLockMinutes: offer.idleLockMinutes,
          announce: async (tools) => {
            const wrap = tools.wrap(
              offer.stallPubkey,
              enrolledMessageJson(offer.voucherId, code.terminalPubkey),
            )
            await Promise.all([
              publisherFor(tools).publish(wrap),
              // The gateway's pending count frees the slot, and lets the credential issue.
              confirmAtGateway(offer.voucherId, tools.signer).catch(() => undefined),
            ])
          },
        },
      )
      setDone(true)
    } catch (e) {
      setError(userMessage(e, 'Could not finish setting up this terminal.'))
    } finally {
      setBusy(false)
    }
  }

  if (done && offer) {
    return (
      <Screen>
        <PageHeader title="This terminal is set up" subtitle={`${offer.name} for ${name ?? 'your stall'}`} />
        <Panel className="mb-6 p-4">
          <p className="text-sm text-mono-500">
            Its authority and passphrase are stored on this device, and the owner&apos;s list
            shows it as in service. Open the till with this passphrase.
          </p>
        </Panel>
        <Button onClick={() => window.location.replace('/terminal/unlock')}>Open the till</Button>
      </Screen>
    )
  }

  if (offer) {
    const role = TERMINAL_ROLE_LABELS[offer.metadata.role]
    return (
      <Screen>
        <PageHeader title="Check this is your stall" subtitle="Compare with the owner's phone" />
        <Panel className="mb-6 p-4">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-mono-500">Stall</dt>
              <dd className="text-lg font-semibold text-mono-900 dark:text-mono-50">
                {name ?? 'A stall with no public name'}
              </dd>
            </div>
            <div>
              <dt className="text-mono-500">Check code</dt>
              <dd className="font-mono text-2xl font-semibold text-mono-900 dark:text-mono-50">
                {formatCheckCode(offer.checkCode)}
              </dd>
            </div>
            <div>
              <dt className="text-mono-500">This terminal</dt>
              <dd className="text-mono-900 dark:text-mono-50">
                {offer.name} · {role.name}
              </dd>
            </div>
          </dl>
        </Panel>

        {!confirmed ? (
          <div className="space-y-3">
            <p className="text-sm text-mono-500">
              Only continue if the stall and the check code match the owner&apos;s screen exactly.
            </p>
            <Button className="w-full" onClick={() => setConfirmed(true)}>
              They match
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                // Not this stall. Drop the offer, never show it again, and keep
                // waiting for the right one.
                setRejected((prev) => new Set(prev).add(offer.voucherId))
                setOffer(null)
                setName(null)
              }}
            >
              They do not match
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              label="Passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <Input
              label="Repeat passphrase"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            <p className="text-xs text-mono-500">
              At least {MIN_PASSPHRASE_LENGTH} characters. Staff type it to open the till, so
              share it only with them.
            </p>
            {error ? <Alert>{error}</Alert> : null}
            <Button className="w-full" onClick={() => void finish()} disabled={busy}>
              {busy ? 'Setting up…' : 'Finish setup'}
            </Button>
          </div>
        )}
      </Screen>
    )
  }

  return (
    <Screen>
      <PageHeader title="Set this device up as a terminal" subtitle="Scan this from the owner's phone" />
      {qr ? (
        <div className="mb-4 flex justify-center">
          <img src={qr} alt="This terminal's code" className="w-full max-w-xs rounded-2xl bg-white p-4" />
        </div>
      ) : null}
      <p className="mb-2 break-all text-center font-mono text-xs text-mono-500" data-testid="terminal-code">
        {code.terminalPubkey}
      </p>
      {/* The whole signed code, for an owner who types or pastes it instead of scanning: the bare key
          above is not enough, since only this proves the key was made as a terminal. */}
      <details className="mb-2 text-center text-xs text-mono-500">
        <summary>Show the full code</summary>
        <p className="mt-1 break-all font-mono" data-testid="terminal-enrolment-code">
          {code.enrolmentCode}
        </p>
      </details>
      <p className="mb-6 text-center text-sm text-mono-500">
        This code is not a secret. Keep this screen open until setup finishes.
      </p>
      {expected ? (
        <p className="mb-6 text-center text-sm text-mono-500" role="status">
          Waiting for the owner…
        </p>
      ) : (
        <div className="mb-6">
          <p className="mb-3 text-center text-sm text-mono-500">
            When the owner&apos;s phone shows a setup code, scan it here. This device only accepts
            the authority that code names.
          </p>
          <ScanRecipient
            manualLabel="Or enter the setup code"
            onFound={() => undefined}
            onText={(text) => {
              const parsed = parseSetupCode(text)
              if (!parsed) {
                setCodeError('That is not a terminal setup code. Scan the code on the owner’s phone.')
                // Consumed: the refusal above is the answer, never an account lookup.
                return true
              }
              setCodeError(null)
              setExpected(parsed)
              return true
            }}
          />
          {codeError ? <Alert>{codeError}</Alert> : null}
        </div>
      )}
      {refusal ? <Alert>{refusal}</Alert> : null}
      <p className="mt-6 text-center text-sm text-mono-500">
        <Link to="/onboarding" className="underline">
          Back
        </Link>
      </p>
    </Screen>
  )
}
