import { useEffect, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'

import { Alert, Button, Input, Panel, Screen } from '../components/ui'
import { keyStore } from '../lib/nap'
import { startSignerPage, walletConsentStore, type SignerPage, type SignerView } from '../lib/napSignerPage'
import { signerPolicy, siteDescription, siteName } from '../lib/napSignerPolicy'
import { createWalletSigner } from '../lib/signer'
import { isTerminalDevice } from '../lib/terminalEnrol'
import { shortPubkey } from '../lib/format'

/**
 * `/nap/signer`: the popup a sister site opens to sign someone in with this wallet (#411, #410 G10).
 * The logic is `lib/napSignerPage.ts`; this is what the person sees. It is rendered on its own,
 * outside the wallet's app shell: no session, no relay, no DM poll, just this question.
 *
 * Its headers differ from every other wallet page on purpose (deploy/nginx.conf): COOP
 * `unsafe-none`, because anything stricter severs `window.opener` and the site can never hear the
 * answer, and `frame-ancestors 'none'`, because consent in a frame can be clickjacked.
 */
export function NapSignerPage() {
  const [view, setView] = useState<SignerView>({ state: 'waiting' })
  const page = useRef<SignerPage | null>(null)

  useEffect(() => {
    // StrictMode mounts effects twice in development: the first start is aborted before it can
    // announce itself, so the site hears "ready" from one signer only.
    const abort = new AbortController()
    let started: SignerPage | null = null
    void startSignerPage({
      policy: signerPolicy(),
      keyStore,
      makeSigner: createWalletSigner,
      isTerminal: isTerminalDevice,
      consentStore: walletConsentStore(),
      onView: (v) => !abort.signal.aborted && setView(v),
      signal: abort.signal,
    }).then((p) => {
      started = p
      if (!abort.signal.aborted) page.current = p
      else p.close()
    })
    // The key must not outlive the popup: zero it as the window goes, not when GC gets to it.
    const leave = () => started?.close()
    window.addEventListener('pagehide', leave)
    return () => {
      abort.abort()
      window.removeEventListener('pagehide', leave)
      started?.close()
      page.current = null
    }
  }, [])

  return (
    <Screen>
      <div className="mx-auto mt-8 max-w-sm">
        <p className="mb-6 text-center text-sm font-medium text-mono-500">Imani wallet</p>
        <SignerBody view={view} page={page} />
      </div>
    </Screen>
  )
}

function SignerBody({ view, page }: { view: SignerView; page: React.RefObject<SignerPage | null> }) {
  switch (view.state) {
    case 'waiting':
      return <p className="text-center text-callout text-mono-500">Waiting for the site that opened this window…</p>
    case 'unavailable':
      return <Unavailable reason={view.reason} />
    case 'unlock':
      return <Unlock origin={view.origin} error={view.error} page={page} />
    case 'consent':
      return (
        <Panel className="p-5">
          <ShieldCheck className="mb-3 h-7 w-7 text-mono-500" aria-hidden />
          <h1 className="text-title font-semibold">Sign in to {siteName(view.request.origin)}?</h1>
          <p className="mt-2 text-callout text-mono-500">
            It wants to sign you in as <span className="font-mono">{shortPubkey(view.request.pubkey)}</span> to{' '}
            {siteDescription(view.request.origin)}.
          </p>
          <p className="mt-2 text-sm text-mono-500">
            Your key stays here. The site can only get sign-in proofs for itself, for a few minutes, and you can remove it
            under Settings › Security › Connected sites.
          </p>
          <div className="mt-5 flex flex-col gap-3">
            <Button onClick={() => page.current?.answerConsent(true)}>Allow</Button>
            <Button variant="ghost" onClick={() => page.current?.answerConsent(false)}>
              Not now
            </Button>
          </div>
        </Panel>
      )
    case 'connected':
      return (
        <Panel className="p-5 text-center">
          <h1 className="text-title font-semibold">You are signed in</h1>
          <p className="mt-2 text-callout text-mono-500">
            {view.grants.map((g) => siteName(g.origin)).join(', ')} can carry on. You can go back to it; keep this window
            open until it says you are signed in.
          </p>
        </Panel>
      )
    case 'declined':
      return (
        <Panel className="p-5 text-center">
          <h1 className="text-title font-semibold">Not signed in</h1>
          <p className="mt-2 text-callout text-mono-500">{siteName(view.origin)} was not given anything. You can close this window.</p>
          <Button className="mt-4 w-full" variant="secondary" onClick={() => window.close()}>
            Close
          </Button>
        </Panel>
      )
    case 'ended':
      return (
        <Panel className="p-5 text-center">
          <h1 className="text-title font-semibold">Finished</h1>
          <p className="mt-2 text-callout text-mono-500">This window no longer signs anything. You can close it.</p>
          <Button className="mt-4 w-full" variant="secondary" onClick={() => window.close()}>
            Close
          </Button>
        </Panel>
      )
  }
}

function Unavailable({ reason }: { reason: Extract<SignerView, { state: 'unavailable' }>['reason'] }) {
  const text = {
    'no-opener': 'This page signs you in to Imani sites. Open it from the site you want to sign in to.',
    framed: 'This page cannot be used inside another page.',
    'no-key': 'There is no wallet on this device yet. Open Imani wallet, create or restore your wallet, then try again.',
    terminal: 'This device is a till. A till cannot sign anyone in to other sites.',
    'no-sites': 'This wallet is not set up to sign you in to any other site.',
  }[reason]
  return <Alert>{text}</Alert>
}

function Unlock({ origin, error, page }: { origin: string; error?: string; page: React.RefObject<SignerPage | null> }) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Panel className="p-5">
      <KeyRound className="mb-3 h-7 w-7 text-mono-500" aria-hidden />
      <h1 className="text-title font-semibold">Unlock your wallet</h1>
      <p className="mt-2 text-callout text-mono-500">
        {origin ? siteName(origin) : 'A site'} asked to sign you in. Enter your wallet passphrase to continue. It is checked here,
        on this device, and never sent anywhere.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!passphrase || busy) return
          setBusy(true)
          page.current
            ?.submitPassphrase(passphrase)
            .catch(() => {})
            .finally(() => {
              setBusy(false)
              setPassphrase('')
            })
        }}
      >
        <Input
          label="Passphrase"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          error={error}
        />
        <Button type="submit" disabled={!passphrase || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => page.current?.cancelUnlock()}>
          Not now
        </Button>
      </form>
    </Panel>
  )
}
