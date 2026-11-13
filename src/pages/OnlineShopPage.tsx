import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Check, Clock, Lock, Store, TriangleAlert } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Alert } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { formatDate } from '../lib/format'
import { licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { reportLicence } from '../lib/licenceReport'
import { ONLINE_SHOP_PLATFORMS, type OnlineShopPlatform } from '../lib/onlineShop'
import {
  ONLINE_SHOP_NOT_IN_PLAN_MESSAGE,
  ONLINE_SHOP_PLAN_NAME,
  connectedShop,
  onlineShopAccess,
  type OnlineShopAccess,
} from '../lib/onlineShopAccess'
import { onlineShopUnconfirmed, syncOnlineShop, type ProfilePublisher } from '../lib/onlineShopProfile'
import { SHOP_ENROL_MESSAGES, readShopEnrolCode, shopHost, type ShopEnrolment } from '../lib/shopEnrol'
import { exposureLine, fetchShopExposure, type ExposureFetch, type ShopExposure } from '../lib/shopExposure'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import type { StallSigner } from '../lib/ownerAttestation'
import { getSigner } from '../lib/nap'
import { confirmEnrolled, stallConfirm, type ConfirmCall } from '../lib/terminalConfirm'
import { DEFAULT_IDLE_LOCK_MINUTES, type WrapPublisher } from '../lib/terminalDelivery'
import { collectEnrolled, ownerPublisher } from '../lib/terminalDeliveryNet'
import { EnrolNotStartedError, enrolTerminal, ownerMessageFor, type Enrolled } from '../lib/terminalEnrolFlow'
import { checkEnrolment, prepareEnrolment } from '../lib/terminalIssue'
import { CredentialMintError, ownerTransport, type MintTransport } from '../lib/terminalMint'
import { ownerProfilePublisher, ownerRenew, ownerSpendApi, stallSeal } from '../lib/terminalOwnerPorts'
import { currentExpiry, isRenewable } from '../lib/terminalRenewOwner'
import { expiryBand } from '../lib/terminalRenewal'
import { cancelExpiredWaiting, resumeMinting, revokeTerminalAtMint } from '../lib/terminalRevoke'
import { REVOCATION_DELAY_NOTE, allTerminals, isRevocable, enrolledCount, holdsLiveCredential, waitingTerminals, type TerminalRecord } from '../lib/terminalRoster'
import { TERMINAL_ROLES } from '../lib/terminalRole'
import { useOnline } from '../lib/useOnline'
import { userMessage } from '../lib/userMessage'

/** What each platform calls the place its Imani code is shown. The code says which it is. */
const PLATFORM_LABELS: Record<OnlineShopPlatform, { name: string; steps: string[] }> = {
  woocommerce: {
    name: 'WooCommerce',
    steps: ['In WordPress, install the Imani plugin for WooCommerce.', "Open the plugin's Imani settings and choose Connect to Imani."],
  },
  wordpress: {
    name: 'WordPress',
    steps: ['In WordPress, install the Imani plugin.', "Open the plugin's Imani settings and choose Connect to Imani."],
  },
  magento: {
    name: 'Magento',
    steps: ['In your Magento admin, install the Imani extension.', "Open the extension's Imani settings and choose Connect to Imani."],
  },
  shopify: {
    name: 'Shopify',
    steps: ['In your Shopify admin, add the Imani checkout app.', "Open the app's Imani settings and choose Connect to Imani."],
  },
}

/** How often the screen looks for the shop's "I have it" while its connection waits. */
const ENROLLED_POLL_MS = 5_000
/** The `online_shop` republish retries this often, this many times, while the screen is open. */
const PROFILE_RETRY_MS = 5_000
const PROFILE_RETRIES = 24

const systemNow = () => Date.now()
/** Stable, so the effect that reads it runs once per stall and not on every render. */
const ownerLicenceStatus = (pubkey: string) => licenceStatus({ pubkey })

/**
 * Settings › Online shop (#402): connect a website so customers can pay there with this stall's
 * coupons, see it, renew it, and disconnect it.
 *
 * Before this screen, a shop was connected from Add a terminal by pasting its code into the box
 * under the camera, past a name and a role picker that do not apply to a shop. Here the order is
 * the owner's: what it is, which platform, the shop's code, a confirmation naming the address.
 *
 * ## The plan decides, and the screen says so
 *
 * Listed for every merchant and locked below the plan that includes `ecommerce`
 * (`onlineShopAccess.ts`). The gateway is the authority: it refuses a new shop's credential and a
 * new code's lock with `422 FEATURE_NOT_IN_PLAN`. A lapsed plan keeps the shop finishing the codes it
 * holds and takes no new ones, so a connected shop is shown, not hidden, with what to do about it.
 *
 * Underneath, a shop is still a redeem-only terminal (ADR 0005): the same mint, the same roster row,
 * the same revocation, through `terminalEnrolFlow.ts`.
 */
export function OnlineShopPage({
  stallPubkey,
  status = ownerLicenceStatus,
  transport = ownerTransport,
  spendApi = ownerSpendApi,
  publisher = ownerPublisher,
  seal = stallSeal,
  stallSigner = getSigner,
  collect = collectEnrolled,
  confirm = stallConfirm,
  renew = ownerRenew,
  profile = ownerProfilePublisher,
  exposure = fetchShopExposure,
  now = systemNow,
}: {
  stallPubkey: string
  /** Injected by tests. The licence check otherwise. */
  status?: (pubkey: string) => Promise<LicenceStatus>
  transport?: MintTransport
  spendApi?: () => Promise<CredentialMintApi>
  publisher?: WrapPublisher
  seal?: <T>(borrow: (key: Uint8Array) => T) => T
  stallSigner?: () => StallSigner
  collect?: (stallPubkey: string) => Promise<number>
  confirm?: ConfirmCall
  renew?: (stallPubkey: string, terminalPubkey: string, api: CredentialMintApi) => Promise<{ started: boolean; message?: string }>
  profile?: ProfilePublisher
  exposure?: ExposureFetch
  now?: () => number
}) {
  const online = useOnline()
  const location = useLocation()
  const navigate = useNavigate()
  // A shop's code handed over from Add a terminal, read once: cleared from the history entry so a
  // later visit (after a disconnect, say) does not offer the same code again.
  const [handedCode] = useState(() => (location.state as { shopCode?: string } | null)?.shopCode)
  useEffect(() => {
    if (handedCode) navigate(location.pathname, { replace: true, state: null })
  }, [handedCode, navigate, location.pathname])
  const [rows, setRows] = useState<TerminalRecord[]>(() => allTerminals(stallPubkey))
  const refresh = useCallback(() => setRows(allTerminals(stallPubkey)), [stallPubkey])
  const [licence, setLicence] = useState<LicenceStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void status(stallPubkey).then(
      (s) => {
        if (cancelled) return
        setLicence(s)
        // The gateway gates on the licence it was told about, so tell it (#197), as Terminals does.
        if (s.decision.granted) void reportLicence({ pubkey: stallPubkey }).catch(() => undefined)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [stallPubkey, status])

  const shop = connectedShop(rows)
  const access: OnlineShopAccess | null = licence ? onlineShopAccess(licence, rows) : null

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Online shop" subtitle="Let customers pay with your coupons on your website" />
      {access === null ? (
        <p className="text-sm text-mono-500" data-testid="online-shop-loading">
          Checking your plan…
        </p>
      ) : shop ? (
        <ConnectedShop
          stallPubkey={stallPubkey}
          shop={shop}
          lapsed={access === 'lapsed'}
          refresh={refresh}
          deps={{ transport, spendApi, collect, confirm, renew, profile, exposure, now }}
        />
      ) : access === 'locked' ? (
        <LockedShop />
      ) : (
        <ConnectShop
          stallPubkey={stallPubkey}
          licence={licence!}
          online={online}
          initialCode={handedCode}
          onConnected={refresh}
          deps={{ transport, spendApi, publisher, seal, stallSigner }}
        />
      )}
    </Screen>
  )
}

/** What an online shop is, in two sentences. Shown above the connect flow and the lock alike. */
function Explainer() {
  return (
    <Panel className="mb-6 p-4">
      <div className="flex items-start gap-3">
        <Store className="mt-0.5 h-5 w-5 shrink-0 text-mono-400" aria-hidden />
        <div className="text-sm text-mono-500">
          <p>Customers turn your coupons into a checkout code in their wallet and type it in at your shop's checkout.</p>
          <p className="mt-2">Your shop can take your coupons. It can never issue them.</p>
        </div>
      </div>
    </Panel>
  )
}

function LockedShop() {
  return (
    <div data-testid="online-shop-locked">
      <Explainer />
      <Panel className="mb-6 p-4">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-mono-400" aria-hidden />
          <p className="text-sm text-mono-500">
            Online shops are part of the {ONLINE_SHOP_PLAN_NAME} plan. Upgrade to connect your website.
          </p>
        </div>
      </Panel>
      <Link to="/settings/subscription" className="block">
        <Button className="w-full">See plans</Button>
      </Link>
    </div>
  )
}

function ConnectShop({
  stallPubkey,
  licence,
  online,
  initialCode,
  onConnected,
  deps,
}: {
  stallPubkey: string
  licence: LicenceStatus
  online: boolean
  initialCode?: string
  onConnected: () => void
  deps: Parameters<typeof enrolTerminal>[3]
}) {
  const [platform, setPlatform] = useState<OnlineShopPlatform | null>(null)
  const [code, setCode] = useState<ShopEnrolment | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [issued, setIssued] = useState<Enrolled | null>(null)

  /** Read a scanned or pasted code. Fail-closed, with the reason in the owner's words. */
  const onText = useCallback(
    (text: string): boolean => {
      setRefusal(null)
      const read = readShopEnrolCode(text)
      if (typeof read === 'string') {
        setRefusal(SHOP_ENROL_MESSAGES[read])
        return true
      }
      if (read.redeemKey === stallPubkey.toLowerCase()) {
        setRefusal('That is your own stall. Copy the code from the shop.')
        return true
      }
      setCode(read)
      setPlatform(read.platform)
      return true
    },
    [stallPubkey],
  )

  // Arrived from Add a terminal with a shop's code: read it, so the owner does not scan it twice.
  useEffect(() => {
    if (initialCode) onText(initialCode)
  }, [initialCode, onText])

  const connect = async () => {
    if (!code || busy) return
    // The till rules apply to the shop too (a key already live here, two waiting, offline), with
    // the name and role a shop always has.
    const request = { name: shopHost(code.url), role: TERMINAL_ROLES.REDEEM_ONLY, terminalPubkey: code.redeemKey }
    const context = {
      stallPubkey,
      licence,
      enrolledCount: enrolledCount(stallPubkey),
      waitingCount: waitingTerminals(stallPubkey).length,
      alreadyLive: holdsLiveCredential(stallPubkey, code.redeemKey),
      online,
    }
    const check = checkEnrolment(request, context)
    if (!check.ready) {
      setFailure(check.message)
      return
    }
    const prepared = {
      ...prepareEnrolment(request, context),
      idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES,
      enrolmentProof: code.enrolmentProof,
      onlineShop: true,
    }
    setBusy(true)
    setFailure(null)
    try {
      setIssued(
        await enrolTerminal(stallPubkey, prepared, { idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES, shop: { url: code.url, platform: code.platform } }, deps),
      )
      onConnected()
    } catch (e) {
      if (e instanceof EnrolNotStartedError) setFailure(userMessage(e.cause, 'Could not connect the shop.'))
      else if (e instanceof CredentialMintError && e.code === 'FEATURE_NOT_IN_PLAN') setFailure(ONLINE_SHOP_NOT_IN_PLAN_MESSAGE)
      else setFailure(ownerMessageFor(e).replace('Could not set up the terminal', 'Could not connect the shop'))
      onConnected()
    } finally {
      setBusy(false)
    }
  }

  if (issued) {
    // Normally replaced at once by the connected view (the row now exists); kept for the moment the
    // roster is re-read, so the owner never sees the empty form again.
    return (
      <p className="text-sm text-mono-500" data-testid="online-shop-issued">
        Connecting… check code {issued.code}.
      </p>
    )
  }

  return (
    <div>
      <Explainer />
      {!online ? (
        <p className="mb-6 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          Connecting a shop needs a connection.
        </p>
      ) : null}

      {code ? (
        <div data-testid="online-shop-confirm">
        <Panel className="mb-6 p-4">
          <p className="font-medium text-mono-900 dark:text-mono-50">Connect {shopHost(code.url)}?</p>
          <p className="mt-1 text-sm text-mono-500">Platform: {PLATFORM_LABELS[code.platform].name}</p>
          <p className="mt-2 text-sm text-mono-500">
            It will be able to take your coupons at checkout. It can never issue them. Check this is your shop's
            address: customers' wallets will send their checkout codes there.
          </p>
          {failure ? (
            <div className="mt-3">
              <Alert>{failure}</Alert>
            </div>
          ) : null}
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setCode(null)
                setFailure(null)
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void connect()} disabled={busy || !online}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </Panel>
        </div>
      ) : (
        <>
          <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">1. Your shop's platform</span>
          <div className="mb-6 grid grid-cols-2 gap-2">
            {ONLINE_SHOP_PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={platform === p}
                onClick={() => setPlatform(p)}
                className={`pressable rounded-xl border p-3 text-left font-medium ${
                  platform === p
                    ? 'border-mono-900 bg-mono-100 text-mono-900 dark:border-mono-50 dark:bg-mono-900 dark:text-mono-50'
                    : 'border-mono-200 text-mono-900 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-50 dark:hover:bg-mono-900'
                }`}
              >
                {PLATFORM_LABELS[p].name}
              </button>
            ))}
          </div>
          {platform ? (
            <ol className="mb-6 list-decimal space-y-1 pl-5 text-sm text-mono-500" data-testid="platform-steps">
              {PLATFORM_LABELS[platform].steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
              <li>Copy the code it shows, or keep it on screen to scan.</li>
            </ol>
          ) : null}
          <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">2. Your shop's code</span>
          <ScanRecipient onFound={() => {}} onText={onText} selfPubkey={stallPubkey} manualLabel="Or paste the code from your shop" />
          {refusal ? (
            <div className="mt-3">
              <Alert>{refusal}</Alert>
            </div>
          ) : null}
          {failure ? (
            <div className="mt-3">
              <Alert>{failure}</Alert>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function ConnectedShop({
  stallPubkey,
  shop,
  lapsed,
  refresh,
  deps,
}: {
  stallPubkey: string
  shop: TerminalRecord
  lapsed: boolean
  refresh: () => void
  deps: {
    transport: MintTransport
    spendApi: () => Promise<CredentialMintApi>
    collect: (stallPubkey: string) => Promise<number>
    confirm: ConfirmCall
    renew: (stallPubkey: string, terminalPubkey: string, api: CredentialMintApi) => Promise<{ started: boolean; message?: string }>
    profile: ProfilePublisher
    exposure: ExposureFetch
    now: () => number
  }
}) {
  const { transport, spendApi, collect, confirm, renew, profile, exposure, now } = deps
  const url = shop.shop!.url
  const host = shopHost(url)
  const minting = shop.status === 'minting'
  const waiting = shop.status === 'waiting' || minting || shop.gatewayState === 'unconfirmed'
  const inService = (shop.status === undefined || shop.status === 'in-service') && shop.gatewayState !== 'unconfirmed'

  // A mint whose answer was lost is finished (or cleared), and a shop that never confirmed in 24
  // hours is cancelled, as the Terminals list does when it opens (#160 review, decision 4).
  // Best effort: offline or locked leaves the row as it is for the next visit.
  const needsUpkeep = minting || shop.status === 'waiting'
  useEffect(() => {
    if (!needsUpkeep) return
    let cancelled = false
    void (async () => {
      try {
        const api = await spendApi()
        await resumeMinting(stallPubkey, api, transport)
        await cancelExpiredWaiting(stallPubkey, api)
      } catch {
        // Tried again on the next visit.
      }
      if (!cancelled) refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [needsUpkeep, stallPubkey, spendApi, transport, refresh])

  // While it waits for the shop's "I have it", look for it, and confirm it at the gateway, as the
  // Terminals list does for a till (#160 phase 2, round 2).
  useEffect(() => {
    if (!waiting) return
    let stopped = false
    const tick = async () => {
      await collect(stallPubkey).catch(() => 0)
      await confirmEnrolled(stallPubkey, confirm).catch(() => undefined)
      if (!stopped) refresh()
    }
    void tick()
    const timer = setInterval(() => void tick(), ENROLLED_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waiting, stallPubkey, collect, confirm, refresh])

  // The profile's `online_shop` follows the roster (#402 §0): published once the shop is in
  // service, retried while this screen is open, and its state shown.
  const [published, setPublished] = useState<boolean | null>(null)
  useEffect(() => {
    if (!inService) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = async (left: number) => {
      const out = await syncOnlineShop(stallPubkey, allTerminals(stallPubkey), profile).catch(() => ({ changed: true, published: false }))
      const failed = !out.published && (out.changed || onlineShopUnconfirmed(stallPubkey))
      if (stopped) return
      setPublished(!failed)
      if (failed && left > 0) timer = setTimeout(() => void attempt(left - 1), PROFILE_RETRY_MS)
    }
    void attempt(PROFILE_RETRIES)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [inService, stallPubkey, profile])

  // R5: what the shop could redirect, from the code store. No figure when it cannot say.
  const [outstanding, setOutstanding] = useState<ShopExposure | null>(null)
  useEffect(() => {
    let cancelled = false
    void exposure(stallPubkey, shop.terminalPubkey)
      .catch(() => null)
      .then((e) => !cancelled && setOutstanding(e))
    return () => {
      cancelled = true
    }
  }, [stallPubkey, shop.terminalPubkey, exposure])

  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'revoke' | 'renew' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const disconnect = async () => {
    setBusy('revoke')
    setNotice(null)
    try {
      const out = await revokeTerminalAtMint(stallPubkey, shop.terminalPubkey, await spendApi())
      if (!out.revoked) setNotice(out.message)
      else {
        // Withdraw `online_shop` at once (R5): a revoked key must stop receiving locks.
        await syncOnlineShop(stallPubkey, allTerminals(stallPubkey), profile).catch(() => undefined)
      }
    } catch {
      setNotice('The disconnection did not reach the mint, so the shop is still connected.')
    } finally {
      setBusy(null)
      setConfirming(false)
      refresh()
    }
  }

  const renewNow = async () => {
    setBusy('renew')
    setNotice(null)
    try {
      const out = await renew(stallPubkey, shop.terminalPubkey, await spendApi())
      if (!out.started && out.message) setNotice(out.message)
    } catch {
      setNotice('The renewal did not reach the gateway. Try again.')
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const expiresAt = currentExpiry(shop)
  const band = inService ? expiryBand(expiresAt, now()) : 'ok'
  const renewable = isRenewable(shop) && !shop.renewal

  return (
    <div data-testid="online-shop-connected">
      {lapsed ? (
        <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" data-testid="online-shop-lapsed">
          <p>
            Your plan no longer includes online shops. {host} takes no new checkout codes; the ones customers already
            made still work until they are used or expire.
          </p>
          <Link to="/settings/subscription" className="mt-2 inline-block font-medium underline">
            Renew {ONLINE_SHOP_PLAN_NAME}
          </Link>
        </div>
      ) : null}

      <Panel className="mb-6 p-4">
        <div className="flex items-start gap-3">
          {waiting ? (
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
          ) : (
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-mono-900 dark:text-mono-50">{waiting ? `Connecting ${host}` : `Connected: ${host}`}</p>
            <p className="text-sm text-mono-500">
              {PLATFORM_LABELS[shop.shop!.platform].name} · since {formatDate(shop.enrolledAt)}
            </p>
            {minting ? (
              <p className="mt-2 text-sm text-mono-500" data-testid="online-shop-minting">
                The gateway has not confirmed it yet. It is finished, or cleared, the next time you open this screen
                with a connection.
              </p>
            ) : waiting ? (
              <p className="mt-2 text-sm text-mono-500" data-testid="online-shop-waiting">
                Waiting for {host} to confirm. Keep its Imani settings open; this finishes on its own, and is cancelled
                after 24 hours if the shop never confirms.
              </p>
            ) : (
              <>
                <p className="mt-2 text-sm text-mono-500" data-testid="online-shop-published">
                  {published === null ? 'Publishing…' : published ? 'Customers can see it.' : 'Not published yet. Trying again.'}
                </p>
                {outstanding ? (
                  <p className="mt-1 text-sm text-mono-500" data-testid="online-shop-exposure">
                    {exposureLine(outstanding, url)}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </Panel>

      {band !== 'ok' && expiresAt !== undefined ? (
        <p className={`mb-4 text-sm ${band === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`} data-testid="online-shop-expiry">
          {band === 'expired'
            ? `${host} stopped taking coupons on ${formatDate(expiresAt * 1000)}. Renew it.`
            : `${host} stops taking coupons on ${formatDate(expiresAt * 1000)}. Renew it.`}
        </p>
      ) : null}
      {shop.renewal ? (
        <p className="mb-4 text-sm text-mono-500">Renewal sent. {host} picks it up the next time it checks in.</p>
      ) : null}
      {notice ? (
        <div className="mb-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}

      {confirming ? (
        <div className="expand-row mb-4 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" data-testid="online-shop-disconnect-confirm">
          <div className="flex gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="text-sm">
              {outstanding && outstanding.codes > 0 ? (
                <p className="mb-2">
                  {exposureLine(outstanding, url)}. Customers get those back when the codes expire, not at checkout.
                </p>
              ) : null}
              <p>{REVOCATION_DELAY_NOTE}</p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button size="sm" onClick={() => void disconnect()} disabled={busy !== null} className="!bg-red-600 !text-white hover:!bg-red-700">
              {busy === 'revoke' ? 'Disconnecting…' : `Disconnect ${host}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {renewable && band !== 'ok' ? (
            <Button onClick={() => void renewNow()} disabled={busy !== null}>
              {busy === 'renew' ? 'Renewing…' : 'Renew'}
            </Button>
          ) : null}
          {isRevocable(shop) && shop.status !== 'minting' ? (
            <Button variant="outline" onClick={() => setConfirming(true)} disabled={busy !== null} className="!text-red-600 dark:!text-red-400">
              {waiting ? 'Cancel' : 'Disconnect'}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
