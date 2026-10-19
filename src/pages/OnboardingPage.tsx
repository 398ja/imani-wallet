import { useEffect, useReducer, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { Button, Input, Alert, Switch } from '../components/ui'
import { BackupLogin } from '../components/BackupLogin'
import { FinishProfileStep } from '../components/FinishProfileStep'
import { gatewayConfig } from '../lib/config'
import { toPrivkeyHex, keyStore, hasStoredKey } from '../lib/nap'
import { refuseIfAnotherWallet } from '../lib/keySlotGuard'
import { claimProfile, ProfileMissingError, rememberHandle, requireProfile } from '../lib/profileGate'
import { HandleTakenError, isHandleAvailable, register } from '../lib/registration'
import { refreshProfile } from '../lib/profile'
import { userMessage } from '../lib/userMessage'
import {
  DEFAULT_CURRENCY,
  DEFAULT_VALIDITY_DAYS,
  merchantFieldsValid,
  type MerchantFields,
} from '../lib/merchant'
import { MerchantFieldset } from '../components/MerchantFieldset'
import { ParkedClaimBanner } from '../components/ParkedClaimBanner'
import { peekPendingClaim } from '../lib/pendingClaim'
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
 *
 * Each step does push a history entry, though — same URL, the step carried in
 * the router's location state. Android's back gesture is the platform's primary
 * navigation, and a WebView with nothing to pop exits the app: without this,
 * back from three screens into registration means goodbye rather than back.
 *
 * "Log in" (#325) opens a backup: Google Drive or a backup file, then the
 * account, then the passphrase. Pasting the key itself is the secondary 'key'
 * step behind a small link on that screen, for someone who only ever saved it.
 * `/restore` redirects to the 'login' step, so old links still land here.
 */
export type OnboardingStep = 'start' | 'account' | 'profile' | 'merchant' | 'login' | 'key'
type Step = OnboardingStep

/**
 * Where `/restore` goes now (#325): the onboarding Log in step, which is where
 * a backup is opened. Old links, bookmarks and the advice people were given
 * still say /restore, so it must land somewhere that does the job.
 */
export function RestoreRedirect() {
  return <Navigate to="/onboarding" replace state={{ step: 'login' satisfies Step }} />
}

export function OnboardingPage({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  // The step lives in history rather than in `useState`, so back walks the flow
  // instead of leaving it. `navigate('.')` re-pushes this same URL, so the step
  // rides in location state and the address bar never names it.
  const location = useLocation()
  const navigate = useNavigate()
  const step = (location.state as { step?: Step } | null)?.step ?? 'start'
  const push = (next: Step) => navigate('.', { state: { step: next } })
  // Back walks history, except where there is none to walk: `/restore`
  // redirects straight onto the Log in step with `replace`, and a fresh tab
  // opened on it has nothing behind it. Popping there would leave the app, so
  // it goes to the first screen instead.
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('.', { replace: true, state: { step: 'start' } })
  }
  const walletHere = useWalletOnDeviceWithParkedClaim()

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
          {/* A claim link parked on the way here (claim links phase 3, spec 4.4). Above the
              buttons. Register stays primary on a fresh device, and it never blocks anything. */}
          <ParkedClaimBanner />
          {/* A voucher is waiting AND this device already holds a wallet (reached via "Use a
              different account", or a stale tab): the likely intent is the wallet they have, so
              unlocking it is primary and registering a second account is not (spec 4.4). */}
          {walletHere && (
            <Button size="lg" className="w-full" onClick={() => navigate('/login')}>
              I already have an account
            </Button>
          )}
          <Button
            size="lg"
            variant={walletHere ? 'outline' : undefined}
            className="w-full"
            onClick={() => push('account')}
          >
            Register
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            onClick={() => push('login')}
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

          {/* No separate Restore link any more (#325): "Log in" IS restoring,
              from Google Drive or a backup file. This is still where logging
              out lands (logout erases the key, so `Entry` routes here), and the
              re-auth dialog points people at "Log in" on this screen. */}

          {/* #160 phase 2: the way in for a stall's extra device. A terminal has
              no account, so it does not register or log in. */}
          <p className="text-center text-sm text-mono-500">
            <Link
              to="/terminal/setup"
              className="pressable underline hover:text-mono-900 dark:hover:text-mono-50"
            >
              Set this device up as a terminal
            </Link>
          </p>
        </div>
      )}

      {(step === 'account' || step === 'profile' || step === 'merchant') && (
        <CreateForm step={step} onStep={push} onUnlock={onUnlock} onBack={back} />
      )}

      {step === 'login' && (
        <BackupLogin onUnlock={onUnlock} onBack={back} onUseKey={() => push('key')} />
      )}

      {step === 'key' && <KeyForm onUnlock={onUnlock} onBack={back} />}
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
  step,
  onStep,
  onUnlock,
  onBack,
}: {
  step: 'account' | 'profile' | 'merchant'
  onStep: (next: 'profile' | 'merchant') => void
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
  const [merchantChosen, setIsMerchant] = useState(false)
  // A registration that starts from a claim link (cashback or gift) is a customer one: only
  // customers redeem. Read on every render, with the banner's rule (a live, unexpired entry), so
  // a claim parked after the switch was turned on (back navigation, a second tab) still wins, and
  // `isMerchant` cannot be true here whatever the switch state says.
  const claimDriven = peekPendingClaim() !== null
  const isMerchant = merchantChosen && !claimDriven
  // A claim parked by another tab fires `storage` here: re-render so the switch and the merchant
  // steps go at once rather than on the next keystroke (review of #254).
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const onStorage = () => rerender()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
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

  // Reloading restores the step from history but not the draft above it, which
  // would leave a merchant screen ready to submit an empty account. Only the
  // step you could have reached honestly renders.
  // A claim-driven registration never reaches the merchant screens, whatever history holds.
  const current = complete && isMerchant ? step : 'account'

  const submit = async () => {
    // Re-read at the moment of submitting: `isMerchant` is from the last render, and a claim parked
    // since then (another tab, no render in between) must still win. Refuse rather than silently
    // create a customer from the merchant screen: the re-render shows the customer-only form.
    if (isMerchant && peekPendingClaim() !== null) {
      rerender()
      return
    }
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
        setError(userMessage(e))
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
  if (current === 'profile') {
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

        <Button size="lg" className="w-full" disabled={busy} onClick={() => onStep('merchant')}>
          Continue
        </Button>

        <BackButton disabled={busy} onClick={onBack} />
      </div>
    )
  }

  // Step three.
  if (current === 'merchant') {
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

        <BackButton disabled={busy} onClick={onBack} />

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
            <span className="text-red-600 dark:text-red-400">{handleError}</span>
          ) : availability === 'taken' ? (
            <span className="text-red-600 dark:text-red-400">Already taken.</span>
          ) : availability === 'checking' ? (
            'Checking…'
          ) : availability === 'free' ? (
            <span className="text-green-700 dark:text-green-500">Looks available.</span>
          ) : domain ? (
            `You will be @${handle || 'your-handle'}`
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
        {passphraseError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{passphraseError}</p>
        )}
      </div>

      <div>
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {confirmError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{confirmError}</p>
        )}
      </div>

      {/* Last, under the fields it does not change: everything above is asked of
          both roles, and this only decides whether there is a second screen. */}
      {/* Hidden, not disabled, when a claim link brought them here: a disabled switch invites
          "why can't I?". Selling is chosen only at registration (see SettingsPage), so this
          does not promise a later way to become a merchant. */}
      {claimDriven ? (
        <p className="text-center text-sm text-mono-500">
          You're redeeming a voucher, so this is a customer account.
        </p>
      ) : (
        <Switch
          label="I am a merchant"
          hint="Issue vouchers and take them as payment."
          checked={isMerchant}
          disabled={busy}
          onChange={setIsMerchant}
        />
      )}

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
                onStep('profile')
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
 * Bring the backup key itself: the secondary way in (#325).
 *
 * The main "Log in" opens a backup. This stays, behind a small link, for
 * someone who only ever saved the key: they paste it and choose a passphrase
 * for this device.
 *
 * The account must have a profile (owner rule, #325). The directory is asked
 * BEFORE anything is stored, so a key with no profile writes nothing and goes
 * to "Finish your profile" instead of being let in anonymously.
 */
function KeyForm({
  onUnlock,
  onBack,
}: {
  onUnlock: (privkeyHex: string) => Promise<void>
  onBack: () => void
}) {
  const [key, setKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A key whose account has no profile yet: in memory only, until a handle is claimed.
  const [missing, setMissing] = useState<string | null>(null)
  const navigate = useNavigate()

  const passphraseError = passphrase === '' ? undefined : validatePassphrase(passphrase)
  const confirmError = confirm === '' ? undefined : validateConfirmation(passphrase, confirm)
  const complete = key !== '' && passphrase !== '' && confirm !== '' && !passphraseError && !confirmError

  // Only once the account is known to have a profile is the key worth keeping.
  const install = async (hex: string) => {
    // Another account's key in the slot would be overwritten, orphaning its vouchers (#330).
    await refuseIfAnotherWallet(hex)
    await keyStore.save(hex, passphrase)
    await onUnlock(hex)
    // No `saveProfile(emptyProfile(...))` here. Writing a blank record first
    // erases whatever this browser already knew about the key. refreshProfile
    // keeps any existing record and merges onto it.
    await refreshProfile(getPublicKey(hexToBytes(hex)))
    navigate('/', { replace: true })
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      // Throws a readable message on a mistyped key, before anything is stored.
      const hex = toPrivkeyHex(key)
      // Before the profile is even asked for: nothing is written for a refused key (#330).
      await refuseIfAnotherWallet(hex)
      try {
        rememberHandle(hex, await requireProfile(hex))
      } catch (e) {
        if (e instanceof ProfileMissingError) {
          setMissing(hex)
          return
        }
        throw e
      }
      await install(hex)
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (missing) {
    return (
      <FinishProfileStep
        onCancel={() => setMissing(null)}
        onClaim={async (handle) => {
          await claimProfile(missing, handle)
          await install(missing)
        }}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Use your backup key</h2>
        {/* Says what this means, because it is not a password prompt: this
            browser holds no key, so one has to be brought to it. */}
        <p className="mt-0.5 text-sm text-mono-500">
          Paste the backup key you saved, then choose a passphrase for this device.
        </p>
      </div>

      <Input
        type="password"
        placeholder="Paste your backup key"
        aria-label="Backup key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
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
        {passphraseError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{passphraseError}</p>
        )}
      </div>
      <div>
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {confirmError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{confirmError}</p>
        )}
      </div>

      <Button size="lg" className="w-full" disabled={busy || !complete} onClick={submit}>
        {busy ? 'Logging in…' : 'Log in'}
      </Button>

      <BackButton disabled={busy} onClick={onBack} />

      {error && <Alert>{error}</Alert>}

      <p className="text-center text-xs text-mono-400">
        Your key is encrypted with this passphrase and never leaves this device.
      </p>
    </div>
  )
}

/**
 * True when a voucher link is parked AND this device already holds a wallet (spec 4.4). Then the
 * start step offers the existing wallet first rather than pushing a second registration.
 */
function useWalletOnDeviceWithParkedClaim(): boolean {
  const [walletHere, setWalletHere] = useState(false)
  useEffect(() => {
    if (!peekPendingClaim()) return
    let live = true
    void hasStoredKey().then(
      (has) => live && setWalletHere(has),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])
  return walletHere
}
