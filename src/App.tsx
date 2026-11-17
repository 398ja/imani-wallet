import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Toaster } from 'sonner'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { NapProvider, useNapSession, useNapCallbacks } from '@imani/nap-react'
import type { NapSession } from '@imani/nap-client-web'

import { createSession, getSigner, resetSession } from './lib/nap'
import { openWallet, onWalletChanged, onWalletOpenStatus, retryOpenWallet, setBeforeWalletRelease, walletOpenStatus, type WalletOpenStatus } from './lib/wallet'
import { releaseWalletForOtherTab } from './lib/walletHandover'
import { RestoringVouchers, WalletOpening } from './components/WalletOpening'
import { startDmPoll } from './lib/dmPoll'
import { startIncomingNotifications } from './lib/incomingNotifications'
import { startCatalogRefresh } from './lib/entitlement'
import { sweepSharedFiles } from './lib/download'
import { startPaymentReceipts, stopPaymentReceipts } from './lib/paymentReceiptDrain'
import { startCashbackClaims, stopCashbackClaims } from './lib/cashbackClaimDrain'
import { startPushListener, stopPushListener } from './lib/notifications/listener'
import { resyncPushSubscription } from './lib/notifications/manager'
import { reconcilePendingSends } from './lib/pay'
import { reconcileRequests } from './lib/vreq'
import { sweepBurnable } from './lib/burn'
import { reconcileClaims } from './lib/claimReconcile'
import { sweepInterruptedReceives } from './lib/receiveSweep'
import { saveRecoveredSwapBack } from './lib/swapBack'
import { restoreIssued } from './lib/issuedRecords'
import { restoreTx, backfillTx } from './lib/txRecords'
import { collectTillSalesForOwner } from './lib/tillSalesNet'
import { startRosterSync, syncRosterNow } from './lib/terminalRosterSyncNet'
import { startOnlineShopSync } from './lib/onlineShopPublisher'
import { restoreVouchers, backfillVouchers } from './lib/voucherRecords'
import { restoreCashbackStash } from './lib/cashbackStash'
import { restoreCheckoutCodes, startCheckoutCodeBackup } from './lib/checkoutCodeBackup'
import { useLogout } from './lib/useLogout'
import { LogoutBlockedDialog } from './components/LogoutBlocked'
import { emptyProfile, loadProfile, refreshProfile, type Profile } from './lib/profile'
import { handleLabel } from './lib/format'
import { reauthenticate } from './lib/reauth'
import { useSessionReauth } from './lib/useSessionReauth'
import { ReauthDialog } from './components/ui/ReauthDialog'
import { HeldCouponsNotice } from './components/ui/HeldCouponsNotice'
import {
  canTrade,
  canRunStall,
  loadMerchant,
  refreshMerchant,
  type MerchantProfile,
} from './lib/merchant'
import { clearPendingBackup, peekPendingBackup } from './lib/onboardingHandoff'
import { forgetResume, recover, remember } from './lib/resume'
import { catchUpMerchantGrant } from './lib/merchantGrantCatchUp'
import { Centered, Fatal } from './components/ui'
import { Header } from './components/ui/Header'
import { LoginPage } from './pages/LoginPage'
import { OnboardingPage, RestoreRedirect } from './pages/OnboardingPage'
import { TerminalSetupPage } from './pages/TerminalSetupPage'
import { TerminalApp } from './pages/TerminalApp'
import { isTerminalDevice } from './lib/terminalEnrol'
import { WelcomePage } from './pages/WelcomePage'
import { MerchantsPage } from './pages/MerchantsPage'
import { MerchantHomePage } from './pages/MerchantHomePage'
import { OpenStallOnly, SellingStallOnly } from './components/StallClosed'
import {
  MerchantTransactionsPage,
  IssuedCouponsPage,
  IssuedCouponPage,
  ExpiringVouchersPage,
} from './pages/MerchantRecordPages'
import { MerchantEditPage } from './pages/MerchantEditPage'
import { PaymentsSettingsPage } from './pages/PaymentsSettingsPage'
import { NotificationSettingsPage } from './pages/NotificationSettingsPage'
import { SellPage } from './pages/SellPage'
import { CashbackIssuePage } from './pages/CashbackIssuePage'
import { MerchantDashboardPage } from './pages/MerchantDashboardPage'
import { RedeemPage } from './pages/RedeemPage'
import { MerchantPage } from './pages/MerchantPage'
import { ClaimLandingPage, ResumeParkedClaim } from './pages/ClaimLandingPage'
import { takeAfterLogin } from './lib/afterLogin'
import { refreshOwnBadge, setVerificationOwner } from './lib/verificationReader'
import { SUBSCRIPTION_STATUS_EVENT } from './lib/subscriptionStatusStore'
import { GiftLandingPage } from './pages/GiftLandingPage'
import { GiftReturnPage } from './pages/GiftReturnPage'
import { finishCashlinkIntentsNow, finishPendingCashlinkClaims, reconcileGiftLinks, restoreScanIfDue } from './lib/giftLinks'
import { runCashlinkExpiryNoticesAfterReconcile } from './lib/cashlinkExpiryNotice'
import { BuyPage } from './pages/BuyPage'
import { BuyCancelledPage, BuyDonePage } from './pages/BuyReturnPages'
import { PublicProfilePage } from './pages/PublicProfilePage'
import { CouponsPage, ExpiringCouponsPage, TransactionsPage } from './pages/RecordListPages'
import { useExpiryReminders } from './hooks/useExpiryReminders'
import { CouponPage, TransactionPage } from './pages/RecordDetailPages'
import { ScanPage } from './pages/ScanPage'
import { PayPage } from './pages/PayPage'
import { UseOnlinePage } from './pages/UseOnlinePage'
import { checkoutCodesEnabled } from './lib/checkoutCodePorts'
import { SendPage } from './pages/SendPage'
import { SendLinkPage } from './pages/SendLinkPage'
import { ReceivePage } from './pages/ReceivePage'
import { CashbackCodeRetiredPage } from './pages/CashbackCodeRetiredPage'
import { ProfilePage } from './pages/ProfilePage'
import { FinishProfilePrompt } from './components/FinishProfilePrompt'
import { claimProfileWith } from './lib/profileGate'
import { SettingsPage } from './pages/SettingsPage'
import { SupportSnapshotPage } from './pages/SupportSnapshotPage'
import { FleetSnapshotPage } from './pages/FleetSnapshotPage'
import { fleetController } from './lib/fleet/app'
import { DeleteAccountPage } from './pages/DeleteAccountPage'
import { AboutPage } from './pages/AboutPage'
import { LedgerPage } from './pages/LedgerPage'
import { SubscriptionPage } from './pages/SubscriptionPage'
import { TerminalsPage } from './pages/TerminalsPage'
import { TerminalEnrolPage } from './pages/TerminalEnrolPage'
import { OnlineShopPage } from './pages/OnlineShopPage'
import { useTerminalIdentity } from './lib/useTerminalIdentity'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { SecurityPage } from './pages/SecurityPage'
import { BackupPage } from './pages/BackupPages'
import { fulfilmentOf, registerRequestTerms } from './lib/terminalTill'
import { listenForLogout } from './lib/logoutTabs'

/**
 * The stall's own till asks gateway-core too (#300), through the same check a terminal uses, so
 * a coupon receive that stalls cannot hold it on "Waiting for payment" after core counted the
 * payment. Signed with the session's signer when it runs. Built once, so the Redeem screen's
 * watch is not restarted on every render.
 */
const OWNER_FULFILMENT = fulfilmentOf()
const OWNER_REGISTER = registerRequestTerms()

// Another tab's logout (or a newer version) asks for the store: stop the
// writers and let a receive in flight land, then let go (lib/walletHandover).
// For the life of the document, not of AuthedApp (review of #353): the store
// and the poller outlive an unmount (a lapsed session shows the passphrase
// dialog with AuthedApp gone), and a release then must still drain first.
setBeforeWalletRelease(() => releaseWalletForOtherTab())

/** `/merchants/:pubkey/coupons` (the list's old address) to `/merchants/:pubkey/vouchers`. */
function VouchersRedirect() {
  const { pubkey = '' } = useParams()
  return <Navigate to={`/merchants/${encodeURIComponent(pubkey)}/vouchers`} replace />
}

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
  // Why the store is not open yet, or that another tab took it (#352). Seeded
  // from the module so a remount does not flash back to "opening".
  const [openStatus, setOpenStatus] = useState<WalletOpenStatus>(() => walletOpenStatus())
  // Bumped by the waiting screen's Try again, which re-runs the open below.
  const [openAttempt, setOpenAttempt] = useState(0)
  // The coupons coming back from their backup after login: said quietly, on
  // the home screen, so an empty list is not mistaken for an empty wallet.
  const [restoring, setRestoring] = useState(false)
  // #558: the sealed history (kind 7376) is back from the relay. The account-deletion liability
  // check reads issued rows from it, so it waits for this rather than answer from an empty device.
  const [historyRestored, setHistoryRestored] = useState(false)

  useEffect(() => onWalletOpenStatus(setOpenStatus), [])
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
    ;(openAttempt === 0 ? openWallet : retryOpenWallet)(pubkey).then(
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

        // The signed tier catalog, now and daily (#506): a stall that never opens Settings ›
        // Subscription still gets a newer limit. Same for every account, so started once.
        startCatalogRefresh()

        // A backup saved through the share sheet last session may still sit in the app's cache
        // (it is kept until the target app has read it). Clear it now. Native only, never throws.
        void sweepSharedFiles()

        // The other half of the same idea, for when the app is NOT open: a
        // push the service worker (or the native plugin) received is posted
        // back here so it reaches the bell. Without it, a user who dismisses
        // the OS notification has no record of it, and one who taps it lands
        // on an empty inbox. Deduped on id against the drain loop above, so an
        // event delivered by both is still one line.
        startPushListener(pubkey)

        // Repair a push registration that has quietly gone stale.
        //
        // Browsers rotate and expire push endpoints, and the
        // `pushsubscriptionchange` event meant to announce that is unreliable.
        // When it happens the wallet still says notifications are on, the
        // browser still holds a subscription, and the gateway is pushing at a
        // dead endpoint — so the phone goes silent with nothing on screen
        // admitting it. Re-POSTing the current subscription upserts on the
        // endpoint hash, so this is a no-op when nothing moved.
        //
        // Never prompts and never subscribes: it only repairs what the user
        // already switched on. Never throws.
        void resyncPushSubscription(pubkey)

        // And the SENDER's side of a settlement: receipts saying a coupon we
        // sent has been claimed. Distinct from the two loops above, which are
        // about money arriving — this is about money we already parted with
        // being picked up, which the sender otherwise never learns.
        //
        // The gateway pushes this too, the moment the receipt is posted. This
        // loop is what reaches a user whose browser refuses notifications, and
        // it dedupes on receiptId against that push, so a claim delivered both
        // ways is still one line in the bell.
        startPaymentReceipts(pubkey)

        // And the stall's side of a cashback: "€5.00 cashback claimed (CB-…)"
        // when a customer redeems a code this stall issued (#158). The portal
        // pushes it too; this drain reaches a browser that refuses
        // notifications and picks up claims the portal's reconcile repaired
        // without a push. Deduped on the cashback id against the push, and it
        // stamps the row Claimed so the Vouchers list needs no status fetch.
        // Started for every account: a customer's drain is a quiet 403.
        startCashbackClaims(pubkey)

        // Every change to the terminal list is published, debounced, to the owner's other
        // devices (#160 phase 6). Stopped on logout.
        startRosterSync(pubkey)
        // And the stall's profile follows it: a shop turning In service is advertised from any
        // screen, not only while Terminals is open (#402).
        startOnlineShopSync(pubkey)

        // This account's own avatar reads the licences it holds as well as the public attestation
        // (#418), so its badge is right the moment a plan arrives, before the service publishes.
        setVerificationOwner(pubkey)

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
        // The cashback stash logout backed up (#331): merged back, banked by the
        // redeem screen's replay as before. Never throws.
        void restoreCashbackStash(pubkey).then((n) => {
          if (n > 0) console.info(`[app] restored ${n} pending cashback token(s)`)
        })
        // #557: the checkout codes logout backed up, merged back with the refund counter lifted past
        // every restored index. dm-poll's /mine pass then carries each one on. Never throws.
        startCheckoutCodeBackup()
        void restoreCheckoutCodes(pubkey).then((n) => {
          if (n > 0) console.info(`[app] restored ${n} checkout code record(s)`)
        })
        setRestoring(true)
        void restoreVouchers(pubkey)
          .finally(() => live && setRestoring(false))
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
            if (live) setHistoryRestored(true)
            // And push up anything the relay is missing — transactions made
            // before this existed, while a relay was refusing writes, or whose
            // publish lost the race with a closing tab.
            return backfillTx(pubkey)
          })
          // A till's sales, sent to this stall as sealed sale records (#160 phase 6, wallet#202).
          // After the history restore, so a sale already filed on another of the owner's devices
          // comes back as that row and is not written again. Never throws.
          // The owner's terminal list, from the relay (#160 phase 6, F4): logout wipes it from
          // this device, and it is the only place the stall's revocation handles live. Merged
          // into local, then checked against the mint. Before till sales, so a sale is
          // attributed by name. Never throws.
          .then(() => syncRosterNow(pubkey))
          .then(() => collectTillSalesForOwner(pubkey))
          .then((tillSales) => {
            if (tillSales > 0) console.info(`[app] filed ${tillSales} till sale(s)`)
          })
          // Last, once both the coupons and the history are back: re-files
          // redemptions written without their claim (pre-#90 rows) against
          // the issuance, so claimed/outstanding and the ceiling see them
          // (#95). Never throws; a customer wallet returns at once.
          .then(() => reconcileClaims(pubkey))
          .then(({ filed, unreadable }) => {
            if (filed > 0) console.info(`[app] re-filed ${filed} redemption(s) against their issuance`)
            if (unreadable > 0) console.info(`[app] ${unreadable} redemption(s) could not be matched: coupon not on this device`)
          })
          // Then finish any receive whose swap went through while the page was
          // dying. The proofs exist at the mint and are spendable only by this
          // wallet; without this they are money nobody can reach (#123).
          //
          // Runs LAST and never rejects, so a mint that is down delays nobody's
          // balance and the rest of start-up is unaffected.
          //
          // The save is deliberately a REFUSAL for now, and that is the honest
          // wiring rather than a placeholder. Nothing creates these intents yet:
          // `receiveTokenByOwnSwap` exists and no call site uses it, so the
          // pending list is always empty and this never runs. Supplying a save
          // that quietly dropped the proofs would be a landmine for whoever
          // switches the receive on, because it would look wired and lose money
          // the first time it fired. Throwing logs the amount at ERROR instead.
          //
          // The one exception is "Swap back to sats" (cashu-mint#540): it tags its coupon row with
          // the swap id before swapping, so a recovered swap back goes back onto that row.
          .then(() =>
            sweepInterruptedReceives(pubkey, async (swap) => {
              if (await saveRecoveredSwapBack(swap)) return
              throw new Error(
                `no save is wired for recovered receives yet (swap ${swap.swapId}); ` +
                  'wire one before switching the wallet-side receive on',
              )
            }),
          )
          .then((recovered) => {
            if (recovered > 0) {
              console.info(`[app] recovered ${recovered} interrupted receive(s) from the mint`)
            }
          })
          // Gift links (claim links phase 4, spec 3.3). After the history restore, so a link sent
          // from another device is known by its row. The restore scan adopts any outstanding link
          // this device's history does not know (a lost phone), then every outstanding link is
          // checked by NUT-07: spent is claimed, and past its expiry it is taken back. Never throws.
          .then(() => restoreScanIfDue(pubkey))
          // #295 phase 4: a Cashlink this wallet started to claim and did not finish (the page
          // died after the burn) is finished first, from the factors it wrote down. Never throws.
          .then(async (adopted) => {
            const done = await finishPendingCashlinkClaims(pubkey)
            if (done > 0) console.info(`[app] finished ${done} Cashlink claim(s)`)
            // #543: a Cashlink made on the direct path that a page left part way.
            const made = await finishCashlinkIntentsNow(pubkey)
            if (made > 0) console.info(`[app] finished ${made} Cashlink(s) being made`)
            return adopted
          })
          .then((adopted) => {
            if (adopted > 0) console.info(`[app] found ${adopted} outstanding gift link(s)`)
            return reconcileGiftLinks()
          })
          .then(({ claimed, reclaimed }) => {
            if (claimed + reclaimed > 0) console.info(`[app] gift links: ${claimed} claimed, ${reclaimed} taken back`)
            // #295 phase 0: tell the sender about each Cashlink that expired, once. After the
            // reconcile, so a link it just took back says so instead of "open Imani".
            return runCashlinkExpiryNoticesAfterReconcile(pubkey)
          })
          .catch(() => {
            // Never blocks start-up; logged inside.
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
      // Unlike the pollers above, this one IS safe to stop here: it holds no
      // in-flight work, only an event listener bound to this account's pubkey.
      // Leaving it attached across a logout would record the next account's
      // pushes into the previous account's inbox.
      stopPushListener()
      // Same reasoning: a receipt drain left running across a logout would
      // sign with the previous account's session and file the next account's
      // claims into the wrong inbox.
      stopPaymentReceipts()
      stopCashbackClaims()
      setVerificationOwner(undefined)
    }
  }, [pubkey, openAttempt])

  // A licence is a voucher, so it arrives as a wallet write: re-read this account's own badge then,
  // and when the subscription service says a plan changed. Debounced, because a restore writes
  // hundreds of rows and each would otherwise re-verify every licence held.
  useEffect(() => {
    if (!ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refreshOwnBadge, 1500)
    }
    const off = onWalletChanged(later)
    window.addEventListener(SUBSCRIPTION_STATUS_EVENT, later)
    return () => {
      if (timer) clearTimeout(timer)
      off()
      window.removeEventListener(SUBSCRIPTION_STATUS_EVENT, later)
    }
  }, [ready])


  /**
   * Whether this device is a terminal, and what it may do today.
   *
   * Null actor on the stall's own device, which is the common case and behaves
   * exactly as it always has. On a terminal this carries the role gating and
   * the lapse notice that terminals ticket 07 built — until this line existed
   * those were correct code no user could reach.
   */
  // `pubkey` is the key that unlocked this session: the device's own key on a
  // terminal. Passed in so the credential's lock is compared with the key this
  // device actually holds, not with the record being checked (#160, G9).
  const terminal = useTerminalIdentity({ devicePubkey: pubkey })

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

  // #265: "voucher about to expire" bell entries, filed while the wallet is open. Local only.
  useExpiryReminders(pubkey, ready)

  // #591: fleet snapshots. AuthedApp is mounted only while the key is unlocked, so this is the
  // unlock / lock pair: the loop runs only while opted in, unlocked and visible. Inert (no request
  // of any kind) unless the gateway serves fleet_enabled and this wallet opted in.
  const isStall = merchant !== null
  useEffect(() => {
    if (!ready) return
    const c = fleetController(pubkey, isStall)
    void c.unlock().catch(() => undefined)
    return () => c.lock()
  }, [ready, pubkey, isStall])

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

  // A logout in another tab pauses this one first, and this tab answers it
  // only once nothing here is mid receive or mid send (#335, lib/logoutTabs.ts).
  useEffect(() => listenForLogout(pubkey), [pubkey])

  // Refused, with a dialog, until every held voucher is read back from its
  // backup (owner rule 2026-10-18; lib/logout.ts `attemptLogout`).
  const logoutFlow = useLogout(pubkey, onLoggedOut)
  const onLogout = logoutFlow.logout

  // Released first (review of #353): once this tab has let go of the store, the
  // open refuses, and that refusal is not a fault to show as one.
  if (openStatus === 'released') {
    return <WalletOpening status={openStatus} onRetry={() => setOpenAttempt((n) => n + 1)} />
  }
  if (error) return <Fatal title="Could not open the wallet" detail={error.message} />
  // Not a dead screen any more (#352): it spins, says why it waits, and offers
  // Try again; once another tab has taken the store, it asks for a reload.
  if (!ready) {
    return <WalletOpening status={openStatus} onRetry={() => setOpenAttempt((n) => n + 1)} />
  }

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
  // #434: the ROLE, open or closed. A closed stall keeps the merchant home, header and every
  // trading route; the screens grey their actions out and say why instead of disappearing.
  const stallOwner = canRunStall(permissions, merchant)

  return (
    <>
      <Header profile={profile} merchant={stallOwner} terminal={terminal.actor !== null} onLogout={onLogout} />
      {/* Coupons the trusted-mint gate is holding, so a wait is never mistaken for a loss (#133). */}
      <HeldCouponsNotice pubkey={pubkey} className="mt-2" />
      {/* #352: the wallet opens first and the vouchers fill in as they come back. */}
      {restoring && <RestoringVouchers />}
      {/* #332, #339: a quiet, dismissible link for an account with no handle, on Home only. Never a gate. */}
      <FinishProfilePrompt profile={profile} />
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
            /*
              Someone who arrived holding a claim link came for a voucher, not
              for an empty wallet. If one is still parked after onboarding,
              finish that first. Decided inside `ResumeParkedClaim` on every
              visit to `/`, not here: this element is built when AuthedApp
              renders, which is not on navigation.
            */
            <ResumeParkedClaim pubkey={pubkey}>
              <ResumeAfterLogin>
              {stallOwner ? (
                <MerchantHomePage
                  actor={terminal.actor ?? undefined}
                  session={terminal.session}
                  refusal={terminal.refusal}
                  closed={!merchant.active}
                  salesClosed={merchant.salesClosed === true}
                />
              ) : (
                <MerchantsPage pubkey={pubkey} />
              )}
              </ResumeAfterLogin>
            </ResumeParkedClaim>
          }
        />
        {stallOwner && (
          <>
            <Route
              path="/sell"
              element={
                <OpenStallOnly merchant={merchant}>
                  <SellingStallOnly merchant={merchant}>
                    <SellPage
                      pubkey={pubkey}
                      merchant={merchant}
                      actor={terminal.actor ?? undefined}
                      session={terminal.session}
                    />
                  </SellingStallOnly>
                </OpenStallOnly>
              }
            />
            {/* Under /sell because it is the other half of the same job —
                and guarded by the same `trading` check, since issuing
                cashback needs `merchant.issuanceCurrency` exactly as Sell does. */}
            <Route
              path="/sell/cashback"
              element={
                <OpenStallOnly merchant={merchant}>
                  <SellingStallOnly merchant={merchant}>
                    <CashbackIssuePage
                      merchant={merchant}
                      actor={terminal.actor ?? undefined}
                      session={terminal.session}
                    />
                  </SellingStallOnly>
                </OpenStallOnly>
              }
            />
            <Route
              path="/redeem"
              element={
                <OpenStallOnly merchant={merchant}>
                  <RedeemPage
                    pubkey={pubkey}
                    merchant={merchant}
                    actor={terminal.actor ?? undefined}
                    fulfilment={OWNER_FULFILMENT}
                    register={OWNER_REGISTER}
                  />
                </OpenStallOnly>
              }
            />
            {/*
              The stall's own business, owner-only.

              "A redemption-only terminal has no Sell button and no dashboard,
              and not as a matter of hiding." Hiding the menu entries is the
              courtesy; this is the control — a terminal that types the URL
              lands on the till instead, because a device in staff hands must
              not show the stall's turnover, its issued coupons or its
              reconciliation gaps.

              Guarded on `actor === null`, which is the owner's own device, and
              NOT on the role: a full till may sell, and still has no business
              reading the stall's books.
            */}
            {terminal.actor === null && (
              <>
                <Route path="/merchant/transactions" element={<MerchantTransactionsPage />} />
                <Route path="/merchant/coupons" element={<IssuedCouponsPage stallPubkey={pubkey} />} />
                {/* The full list behind the dashboard's capped "Expiring soon". */}
                <Route path="/merchant/expiring" element={<ExpiringVouchersPage />} />
                {/* `pubkey` is the STALL's own key, which the detail screen
                    needs to re-check each sale's warrant against. Warrants are
                    signed by the stall and `issuerId` names it, so any other
                    key would report every honest sale as a mismatch — the same
                    trap `/settings/ledger` notes below. */}
                <Route
                  path="/merchant/coupon/:voucherId"
                  element={<IssuedCouponPage pubkey={pubkey} />}
                />
                <Route
                  path="/merchant/dashboard"
                  element={<MerchantDashboardPage pubkey={pubkey} merchant={merchant} />}
                />
              </>
            )}
          </>
        )}
        <Route path="/scan" element={<ScanPage />} />
        {/* A terminal setup code scanned, or a setup link opened, on a device that holds a
            personal wallet (#160 owner report). A terminal is a fresh identity on its own
            device, so this explains rather than sets anything up. */}
        <Route path="/terminal/setup" element={<WalletHolderIsNotATerminal />} />
        <Route path="/pay" element={<PayPage pubkey={pubkey} />} />
        {/* #402: checkout codes, dark until VITE_CHECKOUT_CODES=on. */}
        {checkoutCodesEnabled() && <Route path="/online" element={<UseOnlinePage pubkey={pubkey} />} />}
        {checkoutCodesEnabled() && <Route path="/online/code/:id" element={<UseOnlinePage pubkey={pubkey} />} />}
        <Route path="/send" element={<SendPage pubkey={pubkey} />} />
        <Route path="/send/link" element={<SendLinkPage pubkey={pubkey} />} />
        <Route path="/receive" element={<ReceivePage profile={profile} />} />
        <Route path="/receive/cashback" element={<CashbackCodeRetiredPage />} />
        {/* A claim link handed over by the hosted page. Present in BOTH trees:
            here it redeems, and in `PublicRoutes` it parks the claim and sends
            the customer to onboarding first. */}
        <Route path="/c/:ref" element={<ClaimLandingPage authed pubkey={pubkey} onSwitchAccount={onLogout} />} />
        {/* Where a parked claim is picked up after onboarding. `Entry` sends a
            new wallet here rather than to the home screen when one is waiting,
            so the last step of "install the app to get your voucher" is not
            left to the customer to work out. */}
        <Route path="/c" element={<ClaimLandingPage authed pubkey={pubkey} onSwitchAccount={onLogout} />} />
        {/* A gift link (claim links phase 4): in BOTH trees, as `/c`. */}
        <Route path="/g" element={<GiftLandingPage authed pubkey={pubkey} onSwitchAccount={onLogout} />} />
        <Route path="/gift-return" element={<GiftReturnPage authed />} />
        {/* Buying a stall's coupon by card. In BOTH trees: a shopper who
            already holds coupons is topping up, and a stranger who scanned a
            QR is the reason the hosted page exists. */}
        {/* Stripe's return pages for a buyer (#267). Static paths, declared
            beside /buy/:pubkey; React Router ranks them above the param. */}
        <Route path="/buy/done" element={<BuyDonePage />} />
        <Route path="/buy/cancelled" element={<BuyCancelledPage />} />
        <Route path="/buy/:pubkey" element={<BuyPage buyerPubkey={pubkey} />} />
        <Route path="/merchants/:pubkey" element={<MerchantPage viewerPubkey={pubkey} />} />
        <Route path="/merchants/:pubkey/vouchers" element={<CouponsPage />} />
        {/* The list's old address. A voucher is what this page holds; "coupon" now names the
            checkout code (#402). Kept so a saved link or an older build's notification lands. */}
        <Route path="/merchants/:pubkey/coupons" element={<VouchersRedirect />} />
        <Route path="/coupons/expiring" element={<ExpiringCouponsPage pubkey={pubkey} />} />
        <Route path="/merchants/:pubkey/transactions" element={<TransactionsPage />} />
        <Route path="/coupon/:tokenId" element={<CouponPage />} />
        <Route
          path="/transaction/:id"
          element={<TransactionPage pubkey={pubkey} trading={trading} />}
        />
        <Route
          path="/profile"
          element={
            <ProfilePage
              profile={profile}
              merchant={merchant}
              // #332: the logged-in key finishes its own profile. The same
              // idempotent claim as login's Finish your profile (#327), signed
              // by the session's signer; the card updates from state, no reload.
              onFinishProfile={async (handle, terms) =>
                setProfile(await claimProfileWith(getSigner(), handle, profile, terms))
              }
            />
          }
        />
        {/* Somebody ELSE's profile. `/profile` with no key is still your own —
            the two are one route family on purpose, because "whose profile am I
            looking at" is the only difference between them.

            NOT the same page as `/merchants/:pubkey`, which is my relationship
            with a stall: the coupons I hold, the transactions we have had. This
            is who they are and how to buy from them, and it renders the same
            for a stranger as for their best customer.

            `viewerPubkey` is what lets the page notice it is showing YOU: a
            stall owner must not be offered a card purchase of their own voucher.
            The signed-out route below passes nothing, because there is nobody. */}
        <Route path="/profile/:pubkey" element={<PublicProfilePage viewerPubkey={pubkey} />} />
        {/* `merchant !== null`, NOT `trading`: a CLOSED stall must stay reachable
            or the Open-for-business switch could never be turned back on. It is
            also what hides the Merchant section from customers entirely — they
            have no stall record, and selling is chosen at registration. Only the
            trading SCREENS are gated on `active` (see `canTrade`). */}
        <Route path="/settings" element={<SettingsPage merchant={merchant !== null} stallPubkey={pubkey} />} />
        {/* Every role: what is running, the legal pages, support (no predicate). */}
        <Route path="/settings/about" element={<AboutPage />} />
        {/* #589: only reachable with a support snapshot code; the page hides itself when unconfigured. */}
        <Route path="/settings/help/snapshot" element={<SupportSnapshotPage pubkey={pubkey} stall={merchant !== null} />} />
        <Route path="/settings/help/improve" element={<FleetSnapshotPage pubkey={pubkey} stall={merchant !== null} />} />
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
        {/* Every account, customer or merchant: a customer receives coupons
            and is exactly who wants telling when one arrives. No predicate. */}
        <Route
          path="/settings/notifications"
          element={<NotificationSettingsPage pubkey={pubkey} />}
        />
        <Route
          path="/settings/payments"
          element={
            // Same predicate as the stall editor. A customer typing this URL
            // has no stall to take payments for, so they land where the link
            // would have taken them.
            merchant !== null ? (
              <PaymentsSettingsPage merchant={merchant} onSaved={setMerchant} />
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
            // The STALL's key, not the ledger's. The ledger key is
            // pseudonymous by design and warrants are signed by the stall, so
            // reconciliation checked against the ledger key would report every
            // sale as a mismatch.
            merchant !== null ? (
              <LedgerPage stallPubkey={merchant.pubkey} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/profile"
          element={<ProfileEditPage profile={profile} onSaved={setProfile} />}
        />
        <Route
          path="/settings/subscription"
          element={
            // NOT gated by a route guard, deliberately. The screen renders its
            // own refusal from the real licence check, which is the thing being
            // proven — a `Navigate` here would gate on merchant-ness and leave
            // the licence gate itself never exercised. Merchant-only for
            // REACHABILITY (a customer has no stall to run terminals for), same
            // predicate as the row that leads here.
            merchant !== null ? (
              <SubscriptionPage pubkey={pubkey} currency={merchant.issuanceCurrency} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/terminals"
          element={
            // Merchant-only for reachability: a customer has no stall for a
            // terminal to trade on behalf of. NOT licence-gated — an owner
            // whose subscription lapsed must still be able to revoke a stolen
            // device, and a paywall in front of revocation would turn a billing
            // problem into a security one.
            merchant !== null ? (
              <TerminalsPage stallPubkey={pubkey} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/terminals/add"
          element={
            // Licence-gated only through `checkEnrolment`, which the screen
            // renders as a sentence. A route guard here would hide the reason,
            // and "refused at enrolment rather than by hiding a button" is
            // subscriptions ticket 07's first criterion.
            merchant !== null ? (
              <TerminalEnrolPage stallPubkey={pubkey} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/online-shop"
          element={
            // Merchant-only, and NOT plan-gated here: the screen shows its own lock below Pro, and a
            // merchant whose plan lapsed must still reach their connected shop to disconnect it.
            merchant !== null ? (
              <OnlineShopPage stallPubkey={pubkey} />
            ) : (
              <Navigate to="/settings" replace />
            )
          }
        />
        <Route
          path="/settings/security"
          element={
            <SecurityPage
              onLogout={onLogout}
              pubkey={pubkey}
              terminal={terminal.actor !== null}
            />
          }
        />
        {/* #558: reached only from Security's Danger zone. Never on a terminal. */}
        <Route
          path="/settings/security/delete"
          element={
            terminal.actor !== null ? (
              <Navigate to="/settings/security" replace />
            ) : (
              <DeleteAccountPage
                pubkey={pubkey}
                nip05={profile.nip05}
                merchant={merchant}
                onMerchantSaved={setMerchant}
                onDeleted={onLoggedOut}
                historyReady={historyRestored}
              />
            )
          }
        />
        <Route
          path="/settings/backup"
          element={<BackupPage profile={profile} terminal={terminal.actor !== null} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {logoutFlow.blocked && (
        <LogoutBlockedDialog
          outcome={logoutFlow.blocked}
          busy={logoutFlow.checking}
          onRetry={logoutFlow.logout}
          onClose={logoutFlow.dismiss}
        />
      )}
    </>
  )
}

/**
 * The authenticated tree, plus the dialog that keeps it reachable.
 *
 * Two different things can make the session unusable, and the difference is
 * invisible from here once it has happened:
 *
 *   - the cookie's lifetime ran out, which `watchSessionExpiry` sees coming
 *     because the server told us the deadline at login, and
 *   - the cookie was rejected or dropped, which surfaces as `isAuthenticated`
 *     going false when something makes a request.
 *
 * Both end in the same place: a session object that is still held but no longer
 * authenticates anything. This used to render `Signing in…` indefinitely — a
 * dead screen with no affordance on it, escapable only by a page refresh the
 * user had to think of themselves. Now either one opens the passphrase dialog
 * over whatever was on screen, and unlocking puts them back where they were with
 * no navigation and no reload.
 */
function Gate({ session, onLoggedOut }: { session: NapSession; onLoggedOut: () => void }) {
  const { isAuthenticated } = useNapSession()
  // When to ask, and when to stop asking. See lib/useSessionReauth.ts — the
  // three cases it separates are the ones that are invisible in a screenshot.
  const { expired, dismiss } = useSessionReauth(session, isAuthenticated)

  // The pubkey, captured while the session still has one.
  //
  // It has to be carried at all because `getSession()` returns null the moment
  // the session lapses, and that is exactly when the dialog needs it: to greet
  // the user by name, and to tell logout whose data to erase.
  //
  // A render-phase state update rather than an effect, which is React's own
  // pattern for deriving state from changing input. It re-runs this component
  // before anything commits, so the dialog never renders against a stale pubkey,
  // and there is no second pass — which is what both `set-state-in-effect` and
  // `refs` are pointing at when they refuse the two obvious alternatives.
  const pubkey = session.getSession()?.pubkey
  const [known, setKnown] = useState(pubkey)
  if (pubkey && pubkey !== known) setKnown(pubkey)

  // A real name or nothing. `profileName` falls back through the handle to a
  // truncated npub so the header always has something to render, but "Welcome
  // back, npub1abc…" is not reassurance — it reads like a machine that does not
  // know who you are, on the one dialog where trust is the point. So the
  // fallback is unwound here: only a name a person chose is worth greeting with.
  const knownProfile = known ? loadProfile(known) : null
  const greeting =
    knownProfile?.displayName ??
    (knownProfile?.nip05 ? handleLabel(knownProfile.nip05) : undefined)
  // The same refusal as the header's logout. Here the key is LOCKED, so a
  // wallet holding vouchers is refused until it is unlocked: no backup can be
  // read back or made without the key (review of #326).
  const dialogLogout = useLogout(known, onLoggedOut)

  const dialog = expired ? (
    <>
      <ReauthDialog
        name={greeting}
        onSubmit={async (passphrase) => {
          await reauthenticate(passphrase)
          dismiss()
        }}
        // `attemptLogout` checks the backups, then confirms; it erases the key
        // and every trace of the account, and reloads the document on success.
        onLogout={dialogLogout.logout}
      />
      {dialogLogout.blocked && (
        <LogoutBlockedDialog
          outcome={dialogLogout.blocked}
          busy={dialogLogout.checking}
          onRetry={dialogLogout.logout}
          onClose={dialogLogout.dismiss}
        />
      )}
    </>
  ) : null

  // The dialog renders OVER the app rather than instead of it. That is the whole
  // point of doing this in place: the screen behind it is still the one the user
  // was on, so unlocking returns them to it mid-task instead of to a home screen
  // that has forgotten what they were doing.
  if (!isAuthenticated) {
    return (
      <>
        <Centered>{expired ? 'Session expired' : 'Signing in…'}</Centered>
        {dialog}
      </>
    )
  }

  if (!pubkey) return <Centered>Reading identity…</Centered>
  // `key` so an identity change REMOUNTS everything below rather than
  // re-rendering it. Screens subscribe to the wallet in effects, and several
  // (MerchantsPage) do so with `[]` deps — on a re-render those keep the previous
  // user's subscription and never reload. Remounting tears them down, and it is
  // one attribute against auditing every screen's dependency array.
  return (
    <>
      <AuthedApp key={pubkey} pubkey={pubkey} onLoggedOut={onLoggedOut} />
      {dialog}
    </>
  )
}

/**
 * The screens reachable without a session.
 *
 * Registration lives here rather than in bottin now: the gateway's
 * `POST /api/v1/nip05` claims a handle for a raw pubkey, so the wallet no longer
 * has to send people elsewhere to get an identity.
 */
/**
 * Back to the purchase a visitor left for login (#280).
 *
 * Login lands on `/` (every public path falls through to it once a session
 * exists), so this is where the detour ends. Read once per mount and removed
 * as it is read: a stale entry must not hijack a later visit to home.
 */
function ResumeAfterLogin({ children }: { children: React.ReactNode }) {
  const [next] = useState(() => takeAfterLogin())
  return next ? <Navigate to={next} replace /> : <>{children}</>
}

function PublicRoutes({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage onUnlock={onUnlock} />} />
      <Route path="/onboarding" element={<OnboardingPage onUnlock={onUnlock} />} />
      {/* #160 phase 2: a fresh device becomes a terminal. Public, because the
          device has no key and no session yet. `completeEnrolment` refuses on a
          device that already holds one, so this cannot overwrite a wallet. */}
      <Route path="/terminal/setup" element={<TerminalSetupGate />} />
      {/* Restoring IS logging in now (#325): the onboarding "Log in" step opens
          a Google Drive backup or a backup file. Old links, bookmarks and the
          advice people were given still say /restore, so it lands there. */}
      <Route path="/restore" element={<RestoreRedirect />} />
      {/* A bearer claim link, which is opened by people who have no wallet yet
          BY DESIGN. It cannot fall through to `Entry` with everything else:
          losing the ref and the key here used to mean losing the voucher. The
          page parks the claim and resumes it after onboarding, and nothing is
          spent until a wallet exists to hold it. */}
      <Route path="/c/:ref" element={<ClaimLandingPage authed={false} />} />
      <Route path="/g" element={<GiftLandingPage authed={false} />} />
      <Route path="/gift-return" element={<GiftReturnPage authed={false} />} />
      {/* A stall's profile, which is a PUBLIC thing: the kind-30078 record and
          the kind-0 profile are both plaintext and readable over an
          unauthenticated relay query, and the whole point of a QR on a stall
          sign is that a stranger can scan it.

          Caveat worth knowing before trusting this: `newestAddressable` reads
          the relay AND the gateway, and its own comment records that a
          deployment which does not publish strfry's port loses the merchant
          record entirely. An unauthenticated visitor has only the relay leg, so
          on such a deployment this page degrades to a bare address. It fails
          closed — no record means no Buy button — but it is a deployment
          prerequisite rather than a detail. */}
      <Route path="/merchants/:pubkey" element={<MerchantPage />} />
      {/* Public, so it belongs on the signed-out side too: a stall's profile is
          a shop sign, and someone who scanned a QR at a market has no wallet
          yet. Every field comes from the relay, so this needs no session. */}
      <Route path="/profile/:pubkey" element={<PublicProfilePage />} />
      {/* Buying with no wallet, which is the hosted purchase case: delivery
          falls back to a claim link, so nothing here needs a key.

          This route was briefly declared inside the AUTHED tree by mistake,
          where React Router never reached it and a stranger tapping Buy landed
          on /onboarding. A duplicate path in the wrong <Routes> is dead code
          that looks live. */}
      <Route path="/buy/done" element={<BuyDonePage />} />
      <Route path="/buy/cancelled" element={<BuyCancelledPage />} />
      <Route path="/buy/:pubkey" element={<BuyPage />} />
      {/* Anything else, including deep links into the authed app, lands on the
          entry screen; the deep link is not preserved because every authed route
          needs a wallet that does not exist yet. */}
      <Route path="*" element={<Entry />} />
    </Routes>
  )
}

/**
 * `/terminal/setup`, only on a device with no key (spec 2.2 step 2).
 *
 * One account per device. A device holding a key is sent to log in, where the person can log
 * out (and see the backup warning) before setting it up as a terminal.
 */
function TerminalSetupGate() {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  useEffect(() => {
    import('./lib/nap').then(({ hasStoredKey }) =>
      hasStoredKey().then(setHasKey, () => setHasKey(false)),
    )
  }, [])
  if (hasKey === null) return <Centered>Checking…</Centered>
  if (hasKey) return <WalletHolderIsNotATerminal />
  return <TerminalSetupPage />
}

/** What the owner's operator meant to do, and why this device cannot (#160 owner report). */
const PERSONAL_WALLET_NOT_A_TERMINAL =
  'This device already has a personal wallet. A terminal needs its own device with no account, ' +
  'or log out here first (keep your backup).'

function WalletHolderIsNotATerminal() {
  return (
    <Centered>
      <div className="max-w-sm space-y-3 text-center" role="alert">
        <p className="text-lg font-semibold text-mono-900 dark:text-mono-50">This is a personal wallet</p>
        <p>{PERSONAL_WALLET_NOT_A_TERMINAL}</p>
        <p className="text-sm">
          On the terminal&apos;s own device, choose &quot;Set this device up as a terminal&quot; and
          scan the owner&apos;s setup code from that screen.
        </p>
      </div>
    </Centered>
  )
}

/** Entry's answer for a device enrolled as a terminal (#160). Not a route. */
const TERMINAL_TARGET = 'terminal'

/** Unlock if this browser holds a key, otherwise sign up. */
function Entry() {
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    // hasStoredKey is async (IndexedDB), so this cannot be decided in a render.
    import('./lib/nap').then(({ hasStoredKey }) =>
      hasStoredKey().then(
        // Any terminal record, token or not (#160 review, LOW): a terminal key must never reach
        // /login, where it would open a NAP session as a customer (spec 2.3).
        (has) => setTarget(has ? (isTerminalDevice() ? TERMINAL_TARGET : '/login') : '/onboarding'),
        () => setTarget('/onboarding'),
      ),
    )
  }, [])

  if (!target) return <Centered>Checking…</Centered>
  // #160: a terminal is not a customer, so it must not reach /login, where its
  // key would open a NAP session as one (spec 2.3). It unlocks its till instead.
  if (target === TERMINAL_TARGET) return <Navigate to="/terminal/unlock" replace />
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
      // A merchant whose login beat the gateway's ingest of their stall record would
      // otherwise render a customer home until the next reload (#114). A no-op unless
      // the local record is active and the login answer lacks coupon:issue.
      await catchUpMerchantGrant(next)
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

  // Read once per page load. Enrolment, removal and decommissioning all reload the document.
  const [terminalDevice] = useState(() => isTerminalDevice())

  if (resuming && !session) {
    return (
      <Shell>
        <Centered>Restoring your session…</Centered>
      </Shell>
    )
  }

  return (
    <Shell>
      {!session && terminalDevice ? (
        // #160 phase 3: an enrolled terminal runs the till, never the customer app. No NAP
        // session is opened for it (spec 2.3), so this sits beside the session branch rather
        // than inside it, and owns every route while the device is a terminal.
        <TerminalApp />
      ) : session ? (
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
          // Supplied because `unstyled: true` drops sonner's own loader with
          // the rest of its CSS. Neutral rather than amber: a queued coupon is
          // STATUS, not a warning, and colouring it as a caution would train
          // people to read an ordinary pause as a fault.
          //
          // `motion-safe:` so the rotation stops under prefers-reduced-motion.
          // A ring with no animation still reads as in-progress next to
          // "Still receiving", so nothing is lost by holding it still.
          loading: (
            <Loader2 className="h-5 w-5 motion-safe:animate-spin text-mono-500 dark:text-mono-400" />
          ),
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
