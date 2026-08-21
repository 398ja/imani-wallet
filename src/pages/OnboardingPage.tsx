import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { Button, Input, Alert, Switch } from '../components/ui'
import { gatewayConfig } from '../lib/config'
import { toPrivkeyHex, keyStore } from '../lib/nap'
import { HandleTakenError, isHandleAvailable, register } from '../lib/registration'
import { refreshProfile } from '../lib/profile'
import {
  DEFAULT_CURRENCY,
  DEFAULT_VALIDITY_DAYS,
  merchantFieldsValid,
  type MerchantFields,
} from '../lib/merchant'
import { MerchantFieldset } from '../components/MerchantFieldset'
import {
  passphraseStrength,
  validateConfirmation,
  validateHandle,
  validatePassphrase,
  type Strength,
} from '../lib/validate'

/**
 * Getting into the wallet.
 *
 * Registration is the same for both roles, so being a merchant is a switch on
 * the account form rather than a screen of its own — the extra stall questions
 * only appear once it is on. A customer answers one screen; a merchant answers
 * three, and none of them asks anything a previous answer did not make relevant.
 *
 * The merchant's two extra screens are in this order for a reason: the profile
 * comes FIRST, because the name and description customers see are the stall's
 * own, and the metadata screen that follows deliberately no longer repeats
 * them. Asking for a business name after a display name got two answers.
 *
 * A returning user never sees any of this: `Entry` in App.tsx checks
 * `hasStoredKey()` and sends a browser that already holds a key straight to
 * /login for the passphrase prompt. This tree is the empty-browser path.
 *
 * Steps rather than routes, deliberately. The whole flow is one decision tree
 * with shared draft state, and a half-filled `/onboarding/account` URL is not
 * something anyone should be able to link to or reload into.
 */
type Step = 'start' | 'account' | 'import'

export function OnboardingPage({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const [step, setStep] = useState<Step>('start')

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-mono-900 dark:text-mono-50">Voucher wallet</h1>
        {step === 'start' && (
          <p className="mt-1 text-sm text-mono-500">Vouchers for the merchants you actually go to.</p>
        )}
      </div>

      {step === 'start' && (
        <div className="space-y-3">
          <Button size="lg" className="w-full" onClick={() => setStep('account')}>
            Register
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            onClick={() => setStep('import')}
          >
            Log in
          </Button>

          {/* For a browser that HAS a key but got here anyway — via "Use a
              different account" on the login screen. Entry would have routed it
              to /login on its own. */}
          <p className="pt-2 text-center text-sm text-mono-500">
            Already set up on this device?{' '}
            <Link to="/login" className="pressable underline hover:text-mono-900 dark:hover:text-mono-50">
              Unlock
            </Link>
          </p>
        </div>
      )}

      {step === 'account' && <CreateForm onUnlock={onUnlock} onBack={() => setStep('start')} />}

      {step === 'import' && <ImportForm onUnlock={onUnlock} onBack={() => setStep('start')} />}
    </div>
  )
}

function BackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" className="w-full" disabled={disabled} onClick={onClick}>
      Back
    </Button>
  )
}

/** Availability is advisory — see `isHandleAvailable`. Never gates submission. */
type Availability = 'idle' | 'checking' | 'free' | 'taken'

function CreateForm({
  onUnlock,
  onBack,
}: {
  onUnlock: (privkeyHex: string) => Promise<void>
  onBack: () => void
}) {
  const [handle, setHandle] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [domain, setDomain] = useState<string | null>(null)
  const [availability, setAvailability] = useState<Availability>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A merchant signup is the customer one plus a second screen. `step` only ever
  // reaches 'merchant' while the switch is on, so a customer never meets the
  // stall questions at all.
  const [isMerchant, setIsMerchant] = useState(false)
  const [step, setStep] = useState<'account' | 'profile' | 'merchant'>('account')
  const [displayName, setDisplayName] = useState('')
  const [about, setAbout] = useState('')
  const [merchant, setMerchant] = useState<MerchantFields>(() => ({
    active: true,
    categories: [],
    issuanceCurrency: DEFAULT_CURRENCY,
    voucherValidityDays: DEFAULT_VALIDITY_DAYS,
  }))

  useEffect(() => {
    gatewayConfig().then(
      (c) => setDomain(c.nip05Domain),
      () => setDomain(null),
    )
  }, [])

  const handleError = handle === '' ? undefined : validateHandle(handle)

  // Debounced, and only once the handle is well-formed — no point asking the
  // directory about a name the claim would reject anyway.
  useEffect(() => {
    if (handle === '' || handleError) {
      setAvailability('idle')
      return
    }
    setAvailability('checking')
    let live = true
    const timer = setTimeout(() => {
      isHandleAvailable(handle).then(
        (free) => live && setAvailability(free ? 'free' : 'taken'),
        // A failed probe is not a taken handle. Say nothing rather than block.
        () => live && setAvailability('idle'),
      )
    }, 400)
    // `live` as well as clearTimeout: the timer may already have fired, leaving
    // an in-flight request whose answer is about a handle the user has since
    // edited. Without the flag a slow reply for "ali" can overwrite the verdict
    // for "alice".
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [handle, handleError])

  const passphraseError = passphrase === '' ? undefined : validatePassphrase(passphrase)
  const confirmError = confirm === '' ? undefined : validateConfirmation(passphrase, confirm)
  const complete =
    handle !== '' && passphrase !== '' && confirm !== '' && !handleError && !passphraseError && !confirmError

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // register() stashes the backup key and logs in as its last two steps, in
      // that order — the login remounts the app, and the backup screen is what
      // the remount renders.
      await register(
        handle,
        passphrase,
        onUnlock,
        isMerchant ? merchant : undefined,
        isMerchant
          ? { displayName: displayName.trim() || undefined, about: about.trim() || undefined }
          : undefined,
      )
    } catch (e) {
      // A taken handle is a field problem, not a failed registration: the key is
      // kept, nothing was persisted, and changing one word fixes it.
      //
      // Only that case marks the field. A gateway 500 or a DOMAIN_NOT_VERIFIED
      // is not the handle's fault, and flagging it as taken would contradict the
      // error shown below and send the user off to invent a new one.
      if (e instanceof HandleTakenError) {
        setError(`${handle} is taken. Try another.`)
        setAvailability('taken')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  // Step two. Rendered instead of the account form rather than below it, so the
  // merchant questions cannot be mistaken for more account questions.
  //
  // No photo here. Uploading one needs a Blossom auth event, and at this point
  // in the flow the key exists but nothing has been claimed or stored yet — the
  // avatar is one tap away at /profile the moment the account is real.
  if (step === 'profile') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Your business</h2>
          <p className="mt-0.5 text-sm text-mono-500">
            The name and description customers see on your vouchers.
          </p>
        </div>

        <Input
          label="Display name"
          placeholder="Bridge Street Coffee"
          value={displayName}
          maxLength={128}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
        />

        <div>
          <label
            htmlFor="about"
            className="mb-2 block text-sm font-medium text-mono-600 dark:text-mono-400"
          >
            About
          </label>
          <textarea
            id="about"
            rows={3}
            maxLength={1000}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            disabled={busy}
            placeholder="Independent coffee shop on Bridge Street"
            className="w-full rounded-xl border border-mono-200 bg-white px-4 py-3 text-mono-900 placeholder:text-mono-400 focus:border-mono-400 focus:outline-none disabled:opacity-50 dark:border-mono-700 dark:bg-mono-800 dark:text-mono-50"
          />
        </div>

        <Button size="lg" className="w-full" disabled={busy} onClick={() => setStep('merchant')}>
          Continue
        </Button>

        <BackButton disabled={busy} onClick={() => setStep('account')} />
      </div>
    )
  }

  // Step three.
  if (step === 'merchant') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">What you sell</h2>
          {/* Currency and validity are on this screen because they are the two
              answers that cannot be revised — better asked while someone is
              still deciding than found locked in settings afterwards. Where you
              trade is not, and can wait. */}
          <p className="mt-0.5 text-sm text-mono-500">
            The currency and expiry are fixed once you start selling. Everything else you can change
            in settings later.
          </p>
        </div>

        <MerchantFieldset value={merchant} onChange={setMerchant} disabled={busy} mode="create" />

        <Button
          size="lg"
          className="w-full"
          disabled={busy || !merchantFieldsValid(merchant)}
          onClick={submit}
        >
          {busy ? 'Creating your account…' : 'Create merchant account'}
        </Button>

        <BackButton disabled={busy} onClick={() => setStep('account')} />

        {error && <Alert>{error}</Alert>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">
          Your account
        </h2>
        <p className="mt-0.5 text-sm text-mono-500">Pick a handle and a passphrase.</p>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <span className="text-mono-400">@</span>
          <Input
            placeholder="your-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
          />
        </div>
        <p className="mt-1 text-xs text-mono-500">
          {handleError ? (
            <span className="text-red-600">{handleError}</span>
          ) : availability === 'taken' ? (
            <span className="text-red-600">Already taken.</span>
          ) : availability === 'checking' ? (
            'Checking…'
          ) : availability === 'free' ? (
            <span className="text-green-600">Looks available.</span>
          ) : domain ? (
            `You will be ${handle || 'your-handle'}@${domain}`
          ) : (
            ' '
          )}
        </p>
      </div>

      <div>
        <Input
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
        {passphrase !== '' && <StrengthBar strength={passphraseStrength(passphrase)} />}
        {passphraseError && <p className="mt-1 text-xs text-red-600">{passphraseError}</p>}
      </div>

      <div>
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {confirmError && <p className="mt-1 text-xs text-red-600">{confirmError}</p>}
      </div>

      {/* Last, under the fields it does not change: everything above is asked of
          both roles, and this only decides whether there is a second screen. */}
      <Switch
        label="I am a merchant"
        hint="Issue vouchers and take them as payment."
        checked={isMerchant}
        disabled={busy}
        onChange={setIsMerchant}
      />

      {/* A merchant does not submit from here — the account details are only
          half of what registration needs, so this advances to step two and
          `register` is called once, with everything. */}
      <Button
        size="lg"
        className="w-full"
        disabled={busy || !complete}
        onClick={
          isMerchant
            ? () => {
                // Seeded from the handle rather than left blank: a merchant who
                // taps straight through still ends up with the name they just
                // chose, not an anonymous npub on every coupon.
                if (displayName === '') setDisplayName(handle)
                setStep('profile')
              }
            : submit
        }
      >
        {isMerchant ? 'Continue' : busy ? 'Creating your account…' : 'Create account'}
      </Button>

      <BackButton disabled={busy} onClick={onBack} />

      {error && <Alert>{error}</Alert>}

      <p className="text-center text-xs text-mono-400">
        Your passphrase encrypts your key on this device. It is never sent anywhere, and it cannot
        be reset.
      </p>
    </div>
  )
}

const STRENGTH_STYLE: Record<Strength, { width: string; className: string }> = {
  weak: { width: '25%', className: 'bg-red-500' },
  fair: { width: '50%', className: 'bg-orange-500' },
  good: { width: '75%', className: 'bg-yellow-500' },
  strong: { width: '100%', className: 'bg-green-600' },
}

function StrengthBar({ strength }: { strength: Strength }) {
  const { width, className } = STRENGTH_STYLE[strength]
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-mono-200 dark:bg-mono-800">
        <div
          className={`h-full transition-all duration-200 ease-out motion-reduce:transition-none ${className}`}
          style={{ width }}
        />
      </div>
      <span className="text-xs capitalize text-mono-500">{strength}</span>
    </div>
  )
}

/**
 * Bring an existing key.
 *
 * This is the old LoginPage's enrol branch. It gains a profile fetch: a key that
 * has been used elsewhere usually already has a kind-0, and pulling it means the
 * header has a name and a face on the very first screen.
 */
function ImportForm({
  onUnlock,
  onBack,
}: {
  onUnlock: (privkeyHex: string) => Promise<void>
  onBack: () => void
}) {
  const [nsec, setNsec] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const passphraseError = passphrase === '' ? undefined : validatePassphrase(passphrase)
  const confirmError = confirm === '' ? undefined : validateConfirmation(passphrase, confirm)
  const complete = nsec !== '' && passphrase !== '' && confirm !== '' && !passphraseError && !confirmError

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // Throws a readable message on a mistyped key, before anything is stored.
      const hex = toPrivkeyHex(nsec)
      await keyStore.save(hex, passphrase)
      await onUnlock(hex)

      // No `saveProfile(emptyProfile(...))` here. Writing a blank record first
      // erases whatever this browser already knew about the key — handle,
      // display name, eventAt — and re-entering your own nsec, or importing
      // after a restore, is an ordinary thing to do. refreshProfile keeps any
      // existing record and merges onto it, so a cold gateway cache costs
      // nothing instead of losing the profile.
      await refreshProfile(getPublicKey(hexToBytes(hex)))
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Log in</h2>
        {/* Says what "log in" means here, because it is not a password prompt:
            this browser holds no key, so one has to be brought to it. */}
        <p className="mt-0.5 text-sm text-mono-500">
          Enter the backup key from an account you already have.
        </p>
      </div>

      <Input
        type="password"
        placeholder="nsec1… (your Nostr key)"
        value={nsec}
        onChange={(e) => setNsec(e.target.value)}
        autoComplete="off"
      />
      <div>
        <Input
          type="password"
          placeholder="Choose a passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
        {passphrase !== '' && <StrengthBar strength={passphraseStrength(passphrase)} />}
        {passphraseError && <p className="mt-1 text-xs text-red-600">{passphraseError}</p>}
      </div>
      <div>
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {confirmError && <p className="mt-1 text-xs text-red-600">{confirmError}</p>}
      </div>

      <Button size="lg" className="w-full" disabled={busy || !complete} onClick={submit}>
        {busy ? 'Unlocking…' : 'Add key and unlock'}
      </Button>

      <BackButton disabled={busy} onClick={onBack} />

      {error && <Alert>{error}</Alert>}

      <p className="text-center text-xs text-mono-400">
        Your key is encrypted with this passphrase and never leaves this device.
      </p>
    </div>
  )
}
