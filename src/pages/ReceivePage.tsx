import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { nip19 } from 'nostr-tools'

import { Screen, BackLink, PageHeader, Alert } from '../components/ui'
import { handleLabel } from '../lib/format'
import type { Profile } from '../lib/profile'

/**
 * Receive: show this customer's address as a QR code for the merchant to scan.
 *
 * Display only — no scanning, no transaction. The merchant scans this and sends
 * coupons to it as a NIP-17 DM.
 *
 * **The QR carries the NIP-05 handle**, not the npub. Both name the same
 * destination, but only one of them is something a person can read back over a
 * market stall, and "npub1qq…" on a customer's screen is the single most
 * confusing thing in this app. Registration writes `handle@domain` into the
 * profile and publishes it in kind-0 (`lib/registration.ts`), and the merchant's
 * scanner resolves it back to the pubkey through `/api/v1/resolve` before
 * addressing anything.
 *
 * An earlier version of this comment said nothing in the stack could produce the
 * alias. That was true of the endpoint it had guessed at and is no longer true
 * of the stack: probed live, `/api/v1/resolve/{nip05}` answers 200 with
 * `hex_pubkey` for every registered handle on staging.
 *
 * The npub remains the fallback, for accounts registered before handles existed
 * — and it is what a local dev machine falls back to in practice, since
 * `/api/v1/resolve` resolves only publicly served domains and `imani.local` is
 * not one.
 */
export function ReceivePage({ profile }: { profile: Profile }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)

  const npub = (() => {
    try {
      return nip19.npubEncode(profile.pubkey)
    } catch {
      return null
    }
  })()

  const code = profile.nip05 ?? npub

  useEffect(() => {
    if (!code) return
    QRCode.toDataURL(code, { width: 512, margin: 1 }).then(setDataUrl, (e: Error) =>
      setQrError(e.message),
    )
  }, [code])

  // Derived, not stored: "no address at all" is a fact about the profile, known
  // at render, and setting it from the effect is a cascading render.
  const error = code ? qrError : 'This account has no usable address.'

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Receive" subtitle="Show this to the merchant." />

      {error && <Alert>Could not load your address: {error}</Alert>}

      {dataUrl && (
        <div className="flex flex-col items-center gap-4">
          <img
            src={dataUrl}
            alt={`QR code for ${code}`}
            className="w-full max-w-xs rounded-2xl bg-white p-4"
          />
          {profile.displayName && (
            <p className="text-center text-lg font-semibold text-mono-900 dark:text-mono-50">
              {profile.displayName}
            </p>
          )}
          {/*
            The label is `@song`; the QR above still carries the full
            `song@domain`. They differ deliberately — the merchant's scanner
            resolves the address by fetching the domain, so the machine-readable
            side needs both halves, while the half a person reads back across a
            stall is the one that is theirs.

            Monospace only when it is the npub: a handle is a word, not a key.
          */}
          <p
            className={`break-all text-center text-sm ${
              profile.nip05
                ? 'text-mono-900 dark:text-mono-50'
                : 'font-mono text-mono-500'
            }`}
          >
            {profile.nip05 ? handleLabel(profile.nip05) : code}
          </p>
        </div>
      )}
    </Screen>
  )
}
