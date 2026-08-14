import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { nip19 } from 'nostr-tools'

import { Screen, BackLink, PageHeader, Alert } from '../components/ui'
import { shortPubkey } from '../lib/format'

/**
 * Receive: show this customer's address as a QR code for the farmer to scan.
 *
 * Display only — no scanning, no transaction. The farmer scans this and sends
 * coupons to it as a NIP-17 DM.
 *
 * The design called for a nip05 here. This shows the npub instead, and the
 * reason is worth recording rather than quietly reverting later: a nip05 is an
 * alias that a sender resolves to exactly this pubkey, so the npub is the same
 * destination without the human-readable name — but nothing in this stack can
 * produce the alias. Registration belongs to bottin (out of scope, §2),
 * bottin's `.well-known/nostr.json` here is `{"names":{}}`, and no per-pubkey
 * reverse-lookup endpoint exists on any tier — the `/api/v1/identity/{pubkey}`
 * this used to call 404s, having been written from assumption. Calling a
 * guessed endpoint for absent data is what produced the failing screen.
 *
 * ponytail: npub only. Show the nip05 when a customer actually has one — which
 * needs a bottin registration flow and a real lookup endpoint, not a guess.
 */
export function ReceivePage({ pubkey }: { pubkey: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const npub = (() => {
    try {
      return nip19.npubEncode(pubkey)
    } catch {
      return null
    }
  })()

  useEffect(() => {
    if (!npub) {
      setError('This account has no usable public key.')
      return
    }
    QRCode.toDataURL(npub, { width: 512, margin: 1 }).then(setDataUrl, (e: Error) =>
      setError(e.message),
    )
  }, [npub])

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Receive" subtitle="Show this to the farmer." />

      {error && <Alert>Could not load your address: {error}</Alert>}

      {dataUrl && (
        <div className="flex flex-col items-center gap-4">
          <img
            src={dataUrl}
            alt={`QR code for ${npub}`}
            className="w-full max-w-xs rounded-2xl bg-white p-4"
          />
          <p className="break-all text-center font-mono text-sm text-mono-900 dark:text-mono-50">
            {npub}
          </p>
          <p className="font-mono text-xs text-mono-400">{shortPubkey(pubkey)}</p>
        </div>
      )}
    </Screen>
  )
}
