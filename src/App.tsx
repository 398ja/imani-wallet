import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { NapProvider, useNapSession, useNapCallbacks } from '@imani/nap-react'
import type { NapSession } from '@imani/nap-client-web'

import { createSession, resetSession } from './lib/nap'
import { openWallet } from './lib/wallet'
import { startDmPoll } from './lib/dmPoll'
import { restoreIssued, backfillIssued } from './lib/issuedRecords'
import { logout as runLogout } from './lib/logout'
import { emptyProfile, loadProfile, refreshProfile, type Profile } from './lib/profile'
import {
  canTrade,
  loadMerchant,
  refreshMerchant,
  type MerchantProfile,
} from './lib/merchant'
import { clearPendingBackup, peekPendingBackup } from './lib/onboardingHandoff'
import { Centered, Fatal } from './components/ui'
import { Header } from './components/ui/Header'
import { LoginPage } from './pages/LoginPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { WelcomePage } from './pages/WelcomePage'
import { FarmersPage } from './pages/FarmersPage'
import { MerchantHomePage } from './pages/MerchantHomePage'
import {
  MerchantTransactionsPage,
  IssuedCouponsPage,
  IssuedCouponPage,
} from './pages/MerchantRecordPages'
import { MerchantEditPage } from './pages/MerchantEditPage'
import { SellPage } from './pages/SellPage'
import { MerchantStatsPage } from './pages/MerchantStatsPage'
import { RedeemPage } from './pages/RedeemPage'
import { FarmerPage } from './pages/FarmerPage'
import { CouponsPage, TransactionsPage } from './pages/RecordListPages'
import { CouponPage, TransactionPage } from './pages/RecordDetailPages'
import { ScanPage } from './pages/ScanPage'
import { PayPage } from './pages/PayPage'
import { ReceivePage } from './pages/ReceivePage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { SecurityPage } from './pages/SecurityPage'
import { BackupPage, RestorePage } from './pages/BackupPages'

/**
 * Everything behind the NAP session gate.
 *
 * The wallet's IndexedDB is user-scoped and the DM poller needs the unlocked
 * key, so both start only once we know who the user is.
 */
function AuthedApp({ pubkey, onLoggedOut }: { pubkey: string; onLoggedOut: () => void }) {
  // What the SERVER says this key may do. nap-react keeps these in sync with the
  // session body, and its own types are blunt about the limit: "anything that
  // treats this as enforcement is a vulnerability rather than a feature". The
  // enforcement is gateway-portal's `coupon:issue` guard on issuance.
  const { permissions } = useNapSession()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [profile, setProfile] = useState<Profile>(() => loadProfile(pubkey) ?? emptyProfile(pubkey))
  // Null is a real answer, not "not loaded yet": it means this key has published
  // no merchant record, which is what makes an account a customer. Seeded from
  // localStorage so the first render already knows which home screen to show.
  const [merchant, setMerchant] = useState<MerchantProfile | null>(() => loadMerchant(pubkey))

  // A registration that just finished leaves the new nsec here. Reading it once,
  // on mount, is what lets the backup screen survive the remount that logging in
  // causes — the alternative is showing the key on a screen the user reaches
  // before they are authenticated.
  const [backupNsec, setBackupNsec] = useState(() => peekPendingBackup(pubkey))

  useEffect(() => {
    let live = true
    openWallet(pubkey).then(
      () => {
        if (!live) return
        setReady(true)
        // Receiving coupons is imani-apps' pipeline verbatim: DmPollService
        // reading gift wraps through the gateway's nostrdb, never the relay.
        startDmPoll(pubkey)

        // Rebuild the merchant's books from the relay. Logout wipes the device,
        // so on a fresh browser — or a new phone — this is what puts the sales
        // back. Runs on every login rather than only an empty wallet, so a sale
        // made on another device shows up here too; rows are keyed on the
        // voucher id, so re-writing one is an overwrite, not a duplicate.
        //
        // Deliberately after setReady: it is a background reconciliation, and
        // holding the whole app on a relay round-trip would make every login
        // wait for a network that may not answer. Neither call throws.
        void restoreIssued(pubkey).then((restored) => {
          if (restored > 0) console.info(`[app] restored ${restored} sales from the relay`)
          // And push up anything the relay is missing — sales made before this
          // existed, or while a relay was refusing writes.
          return backfillIssued(pubkey)
        })
      },
      (e) => live && setError(e as Error),
    )
    // No stopDmPoll() here. The poller's lifetime is the session, not this
    // component. Tearing it down on unmount loses the race with the async
    // openWallet() under StrictMode's mount/unmount/remount: the cleanup fires
    // while the promise is still pending, then the resolved promise starts a
    // poller that the already-run cleanup will never stop — observed as
    // "Fetched 1 gift wrap events" immediately followed by "Stopping...", with
    // the coupon dropped mid-processing. Stopped on logout instead.
    return () => {
      live = false
    }
  }, [pubkey])

  // Reconcile the local copy with the relay, as bottin does on every login.
  // Never throws — an unreachable relay leaves the stored profile in place.
  useEffect(() => {
    let live = true
    refreshProfile(pubkey).then((p) => live && setProfile(p))
    return () => {
      live = false
    }
  }, [pubkey])

  // The merchant record, read straight off the relay rather than the gateway's
  // cache — see newestAddressable in lib/relay.ts. Also never throws: a relay we
  // cannot reach leaves whatever localStorage already had, which is why the
  // merchant home does not flicker back to the customer one on a bad connection.
  useEffect(() => {
    let live = true
    refreshMerchant(pubkey).then((m) => live && setMerchant(m))
    return () => {
      live = false
    }
  }, [pubkey])

  const onLogout = useCallback(() => {
    void runLogout(pubkey).then((done) => done && onLoggedOut())
  }, [pubkey, onLoggedOut])

  if (error) return <Fatal title="Could not open the wallet" detail={error.message} />
  if (!ready) return <Centered>Opening wallet…</Centered>

  // The backup screen takes over the whole app rather than sitting on a route:
  // it is the only chance to save a key that cannot be recovered, so it must not
  // be navigable away from by a stray link or a back button.
  if (backupNsec) {
    return (
      <WelcomePage
        nsec={backupNsec}
        profile={profile}
        onDone={() => {
          clearPendingBackup()
          setBackupNsec(null)
        }}
      />
    )
  }

  // The session's authority AND a stall to sell from — see `canTrade`. A `const`
  // so TypeScript narrows `merchant` for the screens behind it.
  const trading = canTrade(permissions, merchant)

  return (
    <>
      <Header profile={profile} merchant={trading} onLogout={onLogout} />
      <Routes>
        {/*
          The role split. A merchant gets a different home and the two money
          screens that go with it; everything below — coupons, transactions,
          profile, security, backup — is identical for both, because a merchant
          holds coupons too (that is what redeeming produces).

          Sell and Redeem are guarded on `trading` rather than merely hidden:
          both need `merchant.issuanceCurrency` to have an amount at all, so a
          customer reaching /sell by typing it must land somewhere real.
        */}
        <Route
          path="/"
          element={
            trading ? <MerchantHomePage profile={profile} merchant={merchant} /> : <FarmersPage />
          }
        />
        {trading && (
          <>
            <Route path="/sell" element={<SellPage pubkey={pubkey} merchant={merchant} />} />
            <Route path="/redeem" element={<RedeemPage pubkey={pubkey} merchant={merchant} />} />
            <Route path="/merchant/transactions" element={<MerchantTransactionsPage />} />
            <Route path="/merchant/coupons" element={<IssuedCouponsPage />} />
            <Route path="/merchant/coupon/:voucherId" element={<IssuedCouponPage />} />
            <Route
              path="/merchant/stats"
              element={<MerchantStatsPage pubkey={pubkey} merchant={merchant} />}
            />
          </>
        )}
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/pay" element={<PayPage pubkey={pubkey} />} />
        <Route path="/receive" element={<ReceivePage pubkey={pubkey} />} />
        <Route path="/farmer/:pubkey" element={<FarmerPage />} />
        <Route path="/farmer/:pubkey/coupons" element={<CouponsPage />} />
        <Route path="/farmer/:pubkey/transactions" element={<TransactionsPage />} />
        <Route path="/coupon/:tokenId" element={<CouponPage />} />
        <Route path="/transaction/:id" element={<TransactionPage />} />
        <Route path="/profile" element={<ProfilePage profile={profile} />} />
        {/* `merchant !== null`, NOT `trading`: a CLOSED stall must stay reachable
            or the Open-for-business switch could never be turned back on. It is
            also what hides the Merchant section from customers entirely — they
            have no stall record, and selling is chosen at registration. Only the
            trading SCREENS are gated on `active` (see `canTrade`). */}
        <Route path="/settings" element={<SettingsPage merchant={merchant !== null} />} />
        <Route
          path="/settings/merchant"
          element={
            // Same predicate as the row that leads here, so a customer who types
            // the URL lands where the link would have taken them rather than on a
            // stall editor for a stall that does not exist.
            merchant !== null ? (
              <MerchantEditPage pubkey={pubkey} merchant={merchant} onSaved={setMerchant} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/profile"
          element={<ProfileEditPage profile={profile} onSaved={setProfile} />}
        />
        <Route path="/settings/security" element={<SecurityPage onLogout={onLogout} />} />
        <Route path="/settings/backup" element={<BackupPage profile={profile} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

function Gate({ session, onLoggedOut }: { session: NapSession; onLoggedOut: () => void }) {
  const { isAuthenticated } = useNapSession()

  if (!isAuthenticated) return <Centered>Signing in…</Centered>

  // Read during render, not in an effect. The pubkey is part of the established
  // session rather than a signer round-trip, so it is available synchronously —
  // mirroring it into state would only add a render and a cascading-update lint
  // error. Reading it from the session rather than the signer also means a
  // locked key does not stop the app knowing who is logged in.
  const pubkey = session.getSession()?.pubkey
  if (!pubkey) return <Centered>Reading identity…</Centered>
  // `key` so an identity change REMOUNTS everything below rather than
  // re-rendering it. Screens subscribe to the wallet in effects, and several
  // (FarmersPage) do so with `[]` deps — on a re-render those keep the previous
  // user's subscription and never reload. Remounting tears them down, and it is
  // one attribute against auditing every screen's dependency array.
  return <AuthedApp key={pubkey} pubkey={pubkey} onLoggedOut={onLoggedOut} />
}

/**
 * The screens reachable without a session.
 *
 * Registration lives here rather than in bottin now: the gateway's
 * `POST /api/v1/nip05` claims a handle for a raw pubkey, so the wallet no longer
 * has to send people elsewhere to get an identity.
 */
function PublicRoutes({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage onUnlock={onUnlock} />} />
      <Route path="/onboarding" element={<OnboardingPage onUnlock={onUnlock} />} />
      <Route path="/restore" element={<RestorePage onUnlock={onUnlock} />} />
      {/* Anything else, including deep links into the authed app, lands on the
          entry screen; the deep link is not preserved because every authed route
          needs a wallet that does not exist yet. */}
      <Route path="*" element={<Entry />} />
    </Routes>
  )
}

/** Unlock if this browser holds a key, otherwise sign up. */
function Entry() {
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    // hasStoredKey is async (IndexedDB), so this cannot be decided in a render.
    import('./lib/nap').then(({ hasStoredKey }) =>
      hasStoredKey().then(
        (has) => setTarget(has ? '/login' : '/onboarding'),
        () => setTarget('/onboarding'),
      ),
    )
  }, [])

  if (!target) return <Centered>Checking…</Centered>
  return <Navigate to={target} replace />
}

export default function App() {
  // useNapCallbacks() is how session transitions reach React state. Its
  // `callbacks` object is render-stable by design, so the session is built once.
  const [napState, callbacks] = useNapCallbacks()
  const [session, setSession] = useState<NapSession | null>(null)

  // The session cannot exist before the key does — a key-holding signer is
  // constructed from it — so login unlocks first, then builds the session.
  const onUnlock = useCallback(
    async (privkeyHex: string) => {
      const next = createSession(privkeyHex, callbacks)
      try {
        await next.login()
      } catch (e) {
        // Clear the singletons before rethrowing. `createSession` returns the
        // cached session and IGNORES the key it is passed, so a session left
        // behind by a failed login would be handed to the next unlock attempt —
        // and if that attempt used a different key (unlock fails, user imports
        // another nsec), the app would run as the FIRST identity while the
        // keystore held the second. getSigner(), openWallet() and the DM poller
        // would all be working on the wrong pubkey, with no error anywhere.
        resetSession()
        throw e
      }
      setSession(next)
    },
    [callbacks],
  )

  return (
    <Shell>
      {session ? (
        // identityChange is required, not optional: omitting it makes every
        // account switch surface as session_expired, which callers retry — and
        // a silent retry across an identity change is the privilege transfer
        // the guard exists to stop.
        <NapProvider session={session} identityChange={napState.identityChange}>
          <Gate session={session} onLoggedOut={() => setSession(null)} />
        </NapProvider>
      ) : (
        <PublicRoutes onUnlock={onUnlock} />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-mono-50 dark:bg-mono-950">{children}</div>
}
