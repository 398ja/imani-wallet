import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { CheckCircle2, XCircle } from 'lucide-react'
import { NapProvider, useNapSession, useNapCallbacks } from '@imani/nap-react'
import type { NapSession } from '@imani/nap-client-web'

import { createSession, resetSession } from './lib/nap'
import { openWallet, onWalletChanged } from './lib/wallet'
import { startDmPoll } from './lib/dmPoll'
import { startIncomingNotifications } from './lib/incomingNotifications'
import { reconcilePendingSends } from './lib/pay'
import { reconcileRequests } from './lib/vreq'
import { sweepBurnable } from './lib/burn'
import { restoreIssued } from './lib/issuedRecords'
import { restoreTx, backfillTx } from './lib/txRecords'
import { restoreVouchers, backfillVouchers } from './lib/voucherRecords'
import { logout as runLogout } from './lib/logout'
import { emptyProfile, loadProfile, refreshProfile, type Profile } from './lib/profile'
import {
  canTrade,
  loadMerchant,
  refreshMerchant,
  type MerchantProfile,
} from './lib/merchant'
import { clearPendingBackup, peekPendingBackup } from './lib/onboardingHandoff'
import { forgetResume, recover, remember } from './lib/resume'
import { Centered, Fatal } from './components/ui'
import { Header } from './components/ui/Header'
import { LoginPage } from './pages/LoginPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { WelcomePage } from './pages/WelcomePage'
import { MerchantsPage } from './pages/MerchantsPage'
import { MerchantHomePage } from './pages/MerchantHomePage'
import {
  MerchantTransactionsPage,
  IssuedCouponsPage,
  IssuedCouponPage,
} from './pages/MerchantRecordPages'
import { MerchantEditPage } from './pages/MerchantEditPage'
import { SellPage } from './pages/SellPage'
import { CashbackIssuePage } from './pages/CashbackIssuePage'
import { MerchantDashboardPage } from './pages/MerchantDashboardPage'
import { RedeemPage } from './pages/RedeemPage'
import { MerchantPage } from './pages/MerchantPage'
import { CouponsPage, TransactionsPage } from './pages/RecordListPages'
import { CouponPage, TransactionPage } from './pages/RecordDetailPages'
import { ScanPage } from './pages/ScanPage'
import { PayPage } from './pages/PayPage'
import { SendPage } from './pages/SendPage'
import { ReceivePage } from './pages/ReceivePage'
import { CashbackRedeemPage } from './pages/CashbackRedeemPage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { LedgerPage } from './pages/LedgerPage'
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

        // Advance notice of an incoming payment, imani-apps' Artemis pattern.
        // Settlement through dm-poll can lag seconds to minutes behind the
        // moment a payer commits, so the gateway enqueues a token-free "on its
        // way" envelope the instant the send starts; this drains that queue and
        // raises a sonner toast. Never touches balance or history — that stays
        // dm-poll's job on the real redemption. Stopped on logout, like the
        // poller above, for the same StrictMode reason.
        startIncomingNotifications(pubkey)

        // Finish any send this wallet stopped waiting for. The 20s poll in
        // pay.ts is not a verdict — a saga can complete minutes later — and
        // until this ran, one that did left the customer holding a coupon whose
        // proofs were already burnt, with no payment in their history and their
        // change unclaimed. Never throws; see reconcilePendingSends.
        void reconcilePendingSends(pubkey).then((settled) => {
          if (settled > 0) console.info(`[app] settled ${settled} pending payment(s)`)
        })

        // And settle any payment request whose money is already in the till.
        // Settlement used to run only while the merchant sat on the "Waiting
        // for payment" screen, so walking away from it left a paid sale reading
        // as unpaid forever. See reconcileRequests.
        void reconcileRequests(pubkey).then(
          ({ settled }) => {
            if (settled > 0) console.info(`[app] settled ${settled} payment request(s)`)
          },
          () => {},
        )

        // Rebuild the books from the relay. Logout wipes the device, so on a
        // fresh browser — or a new phone — this is what puts the history back.
        // Runs on every login rather than only an empty wallet, so a payment
        // made on another device shows up here too; rows are keyed on their own
        // id, so re-writing one is an overwrite, not a duplicate.
        //
        // Deliberately after setReady: it is a background reconciliation, and
        // holding the whole app on a relay round-trip would make every login
        // wait for a network that may not answer. None of these throw.
        //
        // restoreIssued first, and only until the next release: it reads the
        // old kind-30078 `imani:issued:` records that predate txRecords. Rows it
        // restores are republished in the new shape by the backfill below, so
        // nothing is stranded when it goes.
        //
        // Coupons FIRST. They are the customer's money and the root of every
        // customer screen — the shop list is built from what the wallet holds,
        // so until they are back the app reads "No coupons yet" no matter how
        // much history has been restored behind it.
        void restoreVouchers(pubkey)
          .then((coupons) => {
            if (coupons > 0) console.info(`[app] restored ${coupons} coupon(s) from the relay`)
            // After the restore, so a coupon that came back from the relay is
            // swept too. Catches any redemption whose burn failed at the time —
            // until it runs, a coupon this merchant issued is spendable again.
            return sweepBurnable(pubkey)
          })
          .then((burnt) => {
            if (burnt > 0) console.info(`[app] burnt ${burnt} redeemed coupon(s)`)
            return backfillVouchers(pubkey)
          })
          .then(() => restoreIssued(pubkey))
          .then((sales) => {
            if (sales > 0) console.info(`[app] restored ${sales} legacy sale record(s)`)
            return restoreTx(pubkey)
          })
          .then((restored) => {
            if (restored > 0) console.info(`[app] restored ${restored} transactions from the relay`)
            // And push up anything the relay is missing — transactions made
            // before this existed, while a relay was refusing writes, or whose
            // publish lost the race with a closing tab.
            return backfillTx(pubkey)
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

  // Every arriving coupon is a candidate payment for an open request, and the
  // merchant is rarely on the screen that shows it — the till, the home screen
  // and a closed app all have to settle a sale just the same.
  // Only once the wallet is open: `onWalletChanged` subscribes to the storage
  // itself and throws "Wallet not opened yet" if it is not there — thrown from
  // an effect on mount, that is a blank screen instead of a login.
  useEffect(() => {
    if (!ready) return
    return onWalletChanged(() => void reconcileRequests(pubkey).catch(() => {}))
  }, [ready, pubkey])

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
            trading ? <MerchantHomePage /> : <MerchantsPage />
          }
        />
        {trading && (
          <>
            <Route path="/sell" element={<SellPage pubkey={pubkey} merchant={merchant} />} />
            {/* Under /sell because it is the other half of the same job —
                and guarded by the same `trading` check, since issuing
                cashback needs `merchant.issuanceCurrency` exactly as Sell does. */}
            <Route path="/sell/cashback" element={<CashbackIssuePage merchant={merchant} />} />
            <Route path="/redeem" element={<RedeemPage pubkey={pubkey} merchant={merchant} />} />
            <Route path="/merchant/transactions" element={<MerchantTransactionsPage />} />
            <Route path="/merchant/coupons" element={<IssuedCouponsPage />} />
            <Route path="/merchant/coupon/:voucherId" element={<IssuedCouponPage />} />
            <Route
              path="/merchant/dashboard"
              element={<MerchantDashboardPage pubkey={pubkey} merchant={merchant} />}
            />
          </>
        )}
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/pay" element={<PayPage pubkey={pubkey} />} />
        <Route path="/send" element={<SendPage pubkey={pubkey} />} />
        <Route path="/receive" element={<ReceivePage profile={profile} />} />
        <Route path="/receive/cashback" element={<CashbackRedeemPage />} />
        <Route path="/merchants/:pubkey" element={<MerchantPage />} />
        <Route path="/merchants/:pubkey/coupons" element={<CouponsPage />} />
        <Route path="/merchants/:pubkey/transactions" element={<TransactionsPage />} />
        <Route path="/coupon/:tokenId" element={<CouponPage />} />
        <Route
          path="/transaction/:id"
          element={<TransactionPage pubkey={pubkey} trading={trading} />}
        />
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
          path="/settings/ledger"
          element={
            // Merchant-only, same predicate as the stall editor: the redemption
            // ledger is a record of coupons HONOURED, which a customer has none
            // of, and the ledger key is meaningless for them.
            merchant !== null ? <LedgerPage /> : <Navigate to="/settings" replace />
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
  // (MerchantsPage) do so with `[]` deps — on a re-render those keep the previous
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
  // Whether the reload-resume attempt below has finished. Rendering the public
  // routes while it is still running would flash the passphrase screen at a user
  // who is about to be let straight back in — and worse, `Entry` would redirect
  // to /login and replace the URL they actually reloaded.
  const [resuming, setResuming] = useState(true)

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
      // Cache the key for the life of this TAB so a reload does not ask for the
      // passphrase again. Written only after login succeeds: a key that the
      // gateway would not accept is not worth resuming into. See lib/resume.ts
      // for why this is not simply sessionStorage.
      const pubkey = next.getSession()?.pubkey
      if (pubkey) void remember(pubkey, privkeyHex)
      setSession(next)
    },
    [callbacks],
  )

  /**
   * Put a reloaded tab back where it was.
   *
   * Two things have to line up, and BOTH are checked: the NAP session cookie
   * must still be good (`resume()` asks the server, and returns null on 401),
   * and this tab must still hold its wrapped copy of the key. Either one alone
   * is not enough — a live cookie without a key gives an app that cannot
   * decrypt a single gift wrap, and a key without a cookie is not authenticated.
   *
   * `verifyIdentity` is not passed: the signer here is one we just built from
   * the cached key, so nap comparing it against itself proves nothing. The
   * meaningful check is the explicit pubkey comparison below, which catches a
   * cookie and a cached key that belong to different accounts — a stale tab
   * after an account switch elsewhere.
   *
   * Note which failures discard the cache and which do not. Only a DEFINITIVE
   * answer clears it: a 401 (nap returns null), or an identity disagreement.
   * A 5xx or a dead network throws, and throwing must NOT forget — the cache is
   * the only copy of the key this tab has, and dropping it on a transient
   * gateway blip sends the user to the passphrase screen for the rest of the
   * tab's life over an error that would have cleared by itself. This is exactly
   * what a gateway-down reload does, and it is what nap's own `resume()`
   * documents about keeping a remembered signer through a 401.
   */
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const cached = await recover()
        if (!cached || !live) return

        const next = createSession(cached.privkeyHex, callbacks)
        const restored = await next.resume()
        if (!live) return

        if (!restored) {
          // A definitive 401: the cookie is gone or expired. The cached key
          // alone cannot authenticate, and keeping it would retry this on every
          // reload forever.
          resetSession()
          forgetResume()
          return
        }
        if (next.getSession()?.pubkey !== cached.pubkey) {
          console.warn('[app] resume: session and cached key disagree on identity — refusing')
          resetSession()
          forgetResume()
          return
        }
        setSession(next)
      } catch (e) {
        // Transient: a 5xx, a dropped connection, a gateway restart. Fall back
        // to the passphrase screen for THIS load, but keep the cache so the next
        // reload can resume — see the note above.
        console.warn('[app] resume failed, falling back to unlock:', e)
        resetSession()
      } finally {
        if (live) setResuming(false)
      }
    })()
    return () => {
      live = false
    }
  }, [callbacks])

  if (resuming && !session) {
    return (
      <Shell>
        <Centered>Restoring your session…</Centered>
      </Shell>
    )
  }

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
  return (
    <div className="min-h-screen bg-mono-50 dark:bg-mono-950">
      {children}
      {/*
        One global toast region for the whole app. The incoming-payment drain
        loop (lib/incomingNotifications) is the first caller.

        Bottom-right, so the toast never covers the page header or the amount a
        user is reading, and it arrives from the same edge the thumb rests on.
        Both offsets clear the gesture-nav bar: the Toaster is `fixed`, so it
        does not inherit #root's safe-area padding.

        Why `unstyled` and what `.material` then provides is documented beside
        the CSS it belongs to, in index.css — it was restated here in full, and
        two copies of a styling rationale drift apart the moment one is edited.
      */}
      <Toaster
        position="bottom-right"
        closeButton
        offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)', right: '1rem' }}
        mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)', left: '1rem', right: '1rem' }}
        icons={{
          success: <CheckCircle2 className="h-5 w-5 text-green-600" />,
          error: <XCircle className="h-5 w-5 text-red-500" />,
        }}
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              'material flex w-full items-start gap-3 overflow-hidden rounded-2xl border border-mono-900/5 p-4 shadow-xl shadow-mono-950/10 dark:border-mono-50/10 dark:shadow-black/40',
            icon: 'flex h-5 w-5 shrink-0 items-center justify-center',
            content: 'flex min-w-0 flex-1 flex-col gap-0.5',
            // Vibrancy: over a blurred surface, text needs more weight and more
            // contrast than it would on a flat one, and the tracking tightens
            // as the size goes up. Flat mid-grey is what goes illegible here.
            title: 'text-[15px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50',
            description: 'text-[13px] leading-snug text-mono-600 dark:text-mono-300',
            // Trailing, inline, and 28px — a tap target rather than the 20px
            // corner circle sonner floats by default. Swipe-to-dismiss stays,
            // but it is a gesture, so it cannot be the only way out.
            closeButton:
              'pressable order-last ml-1 flex h-7 w-7 self-center shrink-0 items-center justify-center rounded-full text-mono-500 hover:bg-mono-900/5 dark:text-mono-400 dark:hover:bg-mono-50/10',
            actionButton:
              'pressable shrink-0 self-center rounded-full bg-mono-900 px-3 py-1.5 text-[13px] font-medium text-mono-50 dark:bg-mono-50 dark:text-mono-900',
          },
        }}
      />
    </div>
  )
}
