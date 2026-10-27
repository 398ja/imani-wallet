import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Button } from '@wallet/components/ui/Button'
import { Input } from '@wallet/components/ui/Input'
import { Alert, Panel, Screen, PageHeader } from '@wallet/components/ui/layout'
import { bunkerSigner, extensionSigner, hasExtension, keySigner, type Signer } from '../lib/signer'

/**
 * Sign in with the stall's own key. Nothing is created and nothing is stored: the key (or the
 * extension, or the remote signer) only signs this tab's requests.
 */
export function SignInPage({ onSignedIn }: { onSignedIn: (s: Signer, next: string) => void }) {
  const [params] = useSearchParams()
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/account'
  const [bunker, setBunker] = useState('')
  const [nsec, setNsec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (make: () => Promise<Signer> | Signer) => {
    setError(null)
    setBusy(true)
    try {
      onSignedIn(await make(), next)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <PageHeader title="Sign in with your stall" subtitle="Use the key your Imani stall trades with. There is no separate account." />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {hasExtension() ? (
        <Panel className="mb-4 p-4">
          <p className="mb-3 text-sm text-mono-500">A Nostr extension is installed in this browser.</p>
          <Button className="w-full" disabled={busy} onClick={() => void attempt(extensionSigner)}>
            Sign in with the extension
          </Button>
        </Panel>
      ) : null}

      <Panel className="mb-4 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void attempt(() => bunkerSigner(bunker))
          }}
        >
          <Input label="Remote signer" placeholder="bunker://…" value={bunker} onChange={(e) => setBunker(e.target.value)} />
          <Button type="submit" variant="secondary" className="mt-3 w-full" disabled={busy || !bunker.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
      </Panel>

      <details className="mb-4">
        <summary className="pressable cursor-pointer py-1 text-sm text-mono-500">Use my secret key instead</summary>
        <Panel className="mt-2 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void attempt(() => keySigner(nsec))
            }}
          >
            <Input
              label="Stall secret key"
              type="password"
              autoComplete="off"
              placeholder="nsec1…"
              value={nsec}
              onChange={(e) => setNsec(e.target.value)}
            />
            <p className="mt-2 text-xs text-mono-500">Kept in this tab’s memory only. It is never sent or saved.</p>
            <Button type="submit" variant="secondary" className="mt-3 w-full" disabled={busy || !nsec.trim()}>
              Sign in
            </Button>
          </form>
        </Panel>
      </details>
    </Screen>
  )
}
