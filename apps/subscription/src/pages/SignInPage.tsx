import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CloudDownload, FileText, KeyRound } from 'lucide-react'

import { Button } from '@wallet/components/ui/Button'
import { Input } from '@wallet/components/ui/Input'
import { Alert, Panel, Screen, PageHeader } from '@wallet/components/ui/layout'
import { signerFromKey, type Signer } from '../lib/signer'
import { keyFromBackup, keyFromDrive, keyInThisBrowser, openKey, type FoundKey } from '../lib/walletKey'

/**
 * Sign in with the stall's wallet key.
 *
 * Arriving from the wallet (the usual way), the key the wallet keeps in this browser is found
 * straight away and only the wallet passphrase is asked for. Otherwise the stall picks its wallet
 * backup from Google Drive or a file on this device, then types the same passphrase.
 */
export function SignInPage({ onSignedIn }: { onSignedIn: (s: Signer, next: string) => void }) {
  const [params] = useSearchParams()
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/account'
  const [found, setFound] = useState<FoundKey | null>(() => keyInThisBrowser())
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (found) passRef.current?.focus()
  }, [found])

  const run = async (name: string, fn: () => Promise<void>) => {
    setError(null)
    setBusy(name)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const unlock = () =>
    run('unlock', async () => {
      if (!found) return
      const { sk, pubkey } = await openKey(found, passphrase)
      setPassphrase('')
      onSignedIn(signerFromKey(sk, pubkey, found.source, found.name), next)
    })

  const fromDrive = () => run('drive', async () => setFound(await keyFromDrive()))

  const fromFile = (f: File | undefined) =>
    f && run('file', async () => setFound(keyFromBackup(await f.text(), 'file')))

  return (
    <Screen>
      <PageHeader
        title="Sign in with your wallet"
        subtitle="Your plan belongs to your Imani stall. Open your wallet key with the passphrase you use in the wallet."
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {found ? (
        <Panel className="mb-4 p-4">
          <div className="mb-3 flex items-start gap-3">
            <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-mono-900 dark:text-mono-50">
                {found.name ?? 'Your stall'}
                {found.source === 'browser' ? ', from your wallet on this device' : found.source === 'drive' ? ', from Google Drive' : ', from your backup file'}
              </p>
              {found.npub ? <p className="truncate text-mono-500">{found.npub}</p> : null}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
          >
            <Input
              ref={passRef}
              label="Wallet passphrase"
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <Button type="submit" className="mt-3 w-full" disabled={busy !== null || !passphrase}>
              {busy === 'unlock' ? 'Opening…' : 'Continue'}
            </Button>
          </form>
        </Panel>
      ) : (
        <p className="mb-4 text-sm text-mono-500">
          Your wallet key is not on this device. Use the backup you made in the wallet.
        </p>
      )}

      <Panel className="divide-y divide-mono-200 dark:divide-mono-800">
        <button type="button" className="press-row flex w-full items-center gap-3 p-4 text-left" disabled={busy !== null} onClick={() => void fromDrive()}>
          <CloudDownload className="h-5 w-5 shrink-0 text-mono-500" aria-hidden />
          <span className="text-sm font-medium">{busy === 'drive' ? 'Opening Google…' : 'Use my backup from Google Drive'}</span>
        </button>
        <button type="button" className="press-row flex w-full items-center gap-3 p-4 text-left" disabled={busy !== null} onClick={() => file.current?.click()}>
          <FileText className="h-5 w-5 shrink-0 text-mono-500" aria-hidden />
          <span className="text-sm font-medium">{busy === 'file' ? 'Reading…' : 'Use a backup file from this device'}</span>
        </button>
      </Panel>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Wallet backup file"
        onChange={(e) => {
          void fromFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </Screen>
  )
}
