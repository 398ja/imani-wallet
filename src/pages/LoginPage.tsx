import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { Avatar, Button, Input, Alert, Centered } from '../components/ui'
import { keyStore, hasStoredKey } from '../lib/nap'
import { loadProfile, profileName, refreshProfile, type Profile } from '../lib/profile'

/**
 * Unlock a key this browser already holds.
 *
 * Only unlocking. Enrolling a key moved to /onboarding, which is where creating
 * an account lives too — this screen exists for the returning user, and asking
 * them nothing but a passphrase is the point.
 *
 * The wallet holds the customer's key because receiving coupons needs NIP-44
 * decryption to unwrap NIP-17 gift wraps, and NAP is an authentication protocol
 * whose signer only signs. At rest the key is PBKDF2 + AES-GCM encrypted by
 * nap's WebCrypto store; in memory it exists only between unlock and lock.
 */
export function LoginPage({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const [enrolled, setEnrolled] = useState<boolean | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    hasStoredKey().then(setEnrolled, () => setEnrolled(false))
  }, [])

  // Nothing to unlock — send them to sign-up rather than showing a passphrase
  // box for a key that does not exist.
  useEffect(() => {
    if (enrolled === false) navigate('/onboarding', { replace: true })
  }, [enrolled, navigate])

  // The recognition card. Which identity is stored is not knowable without
  // decrypting the key, so this reads the profile record left beside it — the
  // reason that record holds a copy of the public metadata at all.
  useEffect(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('imani-wallet:profile:'))
    if (keys.length !== 1) return
    setProfile(loadProfile(keys[0].slice('imani-wallet:profile:'.length)))
  }, [])

  const unlock = async () => {
    setBusy(true)
    setError(null)
    try {
      const hex = await keyStore.loadKey(passphrase)
      await onUnlock(hex)
      // Reconcile with the relay on the way in, as bottin does: a profile edited
      // on another device should be current here before the header renders.
      void refreshProfile(getPublicKey(hexToBytes(hex)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (enrolled === null) return <Centered>Checking…</Centered>

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      {profile?.banner && (
        <div
          className="h-24 rounded-2xl bg-mono-200 bg-cover bg-center dark:bg-mono-800"
          style={{ backgroundImage: `url(${profile.banner})` }}
        />
      )}

      <div className="flex flex-col items-center gap-3 text-center">
        {profile && <Avatar src={profile.picture} name={profileName(profile)} size="xl" />}
        <div>
          <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">
            {profile ? profileName(profile) : 'Welcome back'}
          </h1>
          {profile?.nip05 && <p className="font-mono text-sm text-mono-500">{profile.nip05}</p>}
        </div>
      </div>

      <div className="space-y-3">
        <Input
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="current-password"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passphrase && !busy) void unlock()
          }}
        />
        <Button
          size="lg"
          className="w-full"
          disabled={busy || !passphrase}
          onClick={() => void unlock()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <p className="text-center text-xs text-mono-400">
          Your key stays encrypted until you unlock it.
        </p>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="flex justify-center gap-4 text-sm text-mono-500">
        <Link to="/onboarding" className="underline hover:text-mono-900 dark:hover:text-mono-50">
          Use a different account
        </Link>
        <Link to="/restore" className="underline hover:text-mono-900 dark:hover:text-mono-50">
          Restore from backup
        </Link>
      </div>
    </div>
  )
}
