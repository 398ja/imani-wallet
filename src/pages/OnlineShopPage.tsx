import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { Check, ChevronRight, Globe, Lock } from 'lucide-react'

import { Screen, BackLink, PageHeader, Button, Alert, DetailRow, Notice } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { formatDay } from '../lib/format'
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
import { exposureLine, exposureSummary, fetchShopExposure, type ExposureFetch, type ShopExposure } from '../lib/shopExposure'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import type { StallSigner } from '../lib/ownerAttestation'
import { getSigner } from '../lib/nap'
import { stallConfirm, type ConfirmCall } from '../lib/terminalConfirm'
import { DEFAULT_IDLE_LOCK_MINUTES, setupCode, type WrapPublisher } from '../lib/terminalDelivery'
import { collectEnrolled, ownerPublisher } from '../lib/terminalDeliveryNet'
import { EnrolNotStartedError, enrolTerminal, ownerMessageFor, type Enrolled } from '../lib/terminalEnrolFlow'
import { checkEnrolment, prepareEnrolment } from '../lib/terminalIssue'
import { CredentialMintError, checkCode, formatCheckCode, ownerTransport, type MintTransport } from '../lib/terminalMint'
import { ownerDeliver, ownerProfilePublisher, ownerRenew, ownerRenewals, ownerSpendApi, stallSeal } from '../lib/terminalOwnerPorts'
import { currentExpiry, isRenewable, lapsedRenewalMessage } from '../lib/terminalRenewOwner'
import { syncRosterNow } from '../lib/terminalRosterSyncNet'
import { useTerminalUpkeep } from '../hooks/useTerminalUpkeep'
import { expiryBand } from '../lib/terminalRenewal'
import { revokeTerminalAtMint } from '../lib/terminalRevoke'
import { REVOCATION_DELAY_HOURS, allTerminals, isRevocable, enrolledCount, holdsLiveCredential, waitingTerminals, type TerminalRecord } from '../lib/terminalRoster'
import { TERMINAL_ROLES } from '../lib/terminalRole'
import { useOnline } from '../lib/useOnline'
import { userMessage } from '../lib/userMessage'

/** What each platform calls the place its Imani code is shown. The code says which it is. */
const PLATFORM_LABELS: Record<OnlineShopPlatform, { name: string; steps: string[] }> = {
  woocommerce: {
    name: 'WooCommerce',
    steps: ['In WordPress, install the Imani plugin for WooCommerce.', 'Open Settings → Imani checkout. Your shop\'s code is under "1. Enrol this shop".'],
  },
  wordpress: {
    name: 'WordPress',
    steps: ['In WordPress, install the Imani plugin.', 'Open Settings → Imani checkout. Your shop\'s code is under "1. Enrol this shop".'],
  },
  magento: {
    name: 'Magento',
    steps: ['In your Magento admin, install the Imani extension.', 'Open Stores → Configuration → Imani → Imani checkout codes. Your shop\'s code is under Enrolment.'],
  },
  shopify: {
    name: 'Shopify',
    steps: ['In your Shopify admin, add the Imani checkout app.', 'Open the app. Once your store is connected, it shows your shop\'s code.'],
  },
}

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
  deliver = ownerDeliver,
  sync = syncRosterNow,
  renewals = ownerRenewals,
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
  /** Injected by tests. Re-sends a credential DM that did not land (#160 round 2). */
  deliver?: (stallPubkey: string) => Promise<number>
  /** Injected by tests. Merges the roster the owner's other devices published (#160 phase 6). */
  sync?: (stallPubkey: string) => Promise<boolean>
  /** Injected by tests. Resumes, cancels and adopts renewals (#160 phase 6). */
  renewals?: (stallPubkey: string, api: CredentialMintApi, transport: MintTransport) => Promise<{ changed: number; lapsed: string[] }>
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
  const [licenceFailed, setLicenceFailed] = useState(false)
  // Why the last connect did not finish, carried past the switch to the connected view: a mint
  // with no answer leaves the row `minting`, which replaces the form that held the message.
  const [connectNotice, setConnectNotice] = useState<string | null>(null)
  const [lapsedRenewals, setLapsedRenewals] = useState<string[]>([])

  // The same pass Terminals runs (useTerminalUpkeep.ts): resume a lost mint, re-send a DM that did
  // not land, collect the shop's pickup of its credential or renewal, notice a revoke made on
  // another phone, cancel what waited 24 hours. A shop-only merchant may never open Terminals.
  useTerminalUpkeep(stallPubkey, rows, { spendApi, transport, collect, confirm, deliver, sync, renewals }, refresh, setLapsedRenewals)

  useEffect(() => {
    let cancelled = false
    void status(stallPubkey).then(
      (s) => {
        if (cancelled) return
        setLicence(s)
        // The gateway gates on the licence it was told about, so tell it (#197), as Terminals does.
        if (s.decision.granted) void reportLicence({ pubkey: stallPubkey }).catch(() => undefined)
      },
      () => !cancelled && setLicenceFailed(true),
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
      {lapsedRenewals.map((name) => (
        <div key={name} className="mb-4">
          <Alert>{lapsedRenewalMessage(name)}</Alert>
        </div>
      ))}
      {shop ? (
        // A connected shop needs no plan answer to be shown, renewed or disconnected.
        <ConnectedShop
          stallPubkey={stallPubkey}
          shop={shop}
          lapsed={access === 'lapsed'}
          notice={connectNotice}
          refresh={refresh}
          deps={{ spendApi, renew, profile, exposure, now }}
        />
      ) : access === null ? (
        <p className="text-sm text-mono-500" data-testid="online-shop-loading">
          {licenceFailed ? 'Could not check your plan. Check your connection and open this screen again.' : 'Checking your plan…'}
        </p>
      ) : access === 'locked' ? (
        <LockedShop />
      ) : (
        <ConnectShop
          stallPubkey={stallPubkey}
          licence={licence!}
          online={online}
          initialCode={handedCode}
          onConnected={(notice) => {
            setConnectNotice(notice ?? null)
            refresh()
          }}
          deps={{ transport, spendApi, publisher, seal, stallSigner }}
        />
      )}
    </Screen>
  )
}

/**
 * Presentation follows Apple's Human Interface Guidelines, within the wallet's own tokens: inset
 * grouped lists with short headers and footnote footers (the same frame as `ListSection`), one
 * primary action per step, a single-choice list with a checkmark for the platform, progressive
 * disclosure (the code step appears once a platform is chosen), status as label/value rows, and
 * the destructive action alone in its own group, confirmed in place.
 */

/** An inset grouped list: optional header above, optional footnote below. */
function Group({ title, footer, children, testId }: { title?: string; footer?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mb-6" data-testid={testId}>
      {title ? <h2 className="mb-2 px-4 text-xs font-medium uppercase tracking-wide text-mono-500">{title}</h2> : null}
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
      {footer ? <div className="mt-2 px-4 text-xs leading-relaxed text-mono-500">{footer}</div> : null}
    </section>
  )
}

/** A full-width row that acts, at least 44 pt tall. Destructive rows are red and stand alone. */
function ActionRow({
  children,
  onClick,
  tone = 'default',
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  tone?: 'default' | 'destructive'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`press-row block min-h-11 w-full p-4 text-center font-medium disabled:opacity-50 ${
        tone === 'destructive' ? 'text-red-600 dark:text-red-400' : 'text-mono-900 dark:text-mono-50'
      }`}
    >
      {children}
    </button>
  )
}

/** The page's lead: an icon tile, a title and one line of state. */
function StatusHeader({ title, status, tone }: { title: string; status: string; tone: 'ok' | 'pending' | 'warning' | 'neutral' }) {
  const dot = { ok: 'bg-green-500', pending: 'bg-amber-500', warning: 'bg-amber-500', neutral: 'bg-mono-400' }[tone]
  return (
    <div className="mb-6 flex items-center gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-mono-100 dark:bg-mono-900">
        <Globe className="h-7 w-7 text-mono-700 dark:text-mono-200" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold text-mono-900 dark:text-mono-50">{title}</p>
        <p className="flex items-center gap-1.5 text-sm text-mono-500">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
          {status}
        </p>
      </div>
    </div>
  )
}

/** What an online shop is, in two sentences. */
const EXPLAINER =
  "Customers turn your coupons into a checkout code in their wallet and type it in at your shop's checkout. Your shop can take your coupons. It can never issue them."

function LockedShop() {
  return (
    <div data-testid="online-shop-locked" className="flex flex-col items-center px-2 pt-6 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-mono-100 dark:bg-mono-900">
        <Lock className="h-8 w-8 text-mono-500" aria-hidden />
      </div>
      <p className="text-lg font-semibold text-mono-900 dark:text-mono-50">Sell online with your coupons</p>
      <p className="mt-2 text-sm leading-relaxed text-mono-500">{EXPLAINER}</p>
      <p className="mt-3 text-sm leading-relaxed text-mono-500">
        Online shops are part of the {ONLINE_SHOP_PLAN_NAME} plan. Upgrade to connect your website.
      </p>
      <Link to="/settings/subscription" className="mt-6 block w-full">
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
  /** The roster changed; `notice` is why the connect did not finish, when it did not. */
  onConnected: (notice?: string) => void
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
      const message =
        e instanceof EnrolNotStartedError
          ? userMessage(e.cause, 'Could not connect the shop.')
          : e instanceof CredentialMintError && e.code === 'FEATURE_NOT_IN_PLAN'
            ? ONLINE_SHOP_NOT_IN_PLAN_MESSAGE
            : ownerMessageFor(e).replace('Could not set up the terminal', 'Could not connect the shop')
      setFailure(message)
      // A definitive refusal forgot the row and this form stays; one with no answer kept it
      // `minting`, and the connected view shows the message instead.
      onConnected(message)
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

  if (code) {
    // The confirmation: what will be connected, said plainly, and one primary action.
    return (
      <div data-testid="online-shop-confirm">
        <p className="mb-1 text-lg font-semibold text-mono-900 dark:text-mono-50">Connect {shopHost(code.url)}?</p>
        <p className="mb-6 text-sm text-mono-500">Check this is your shop. Customers' wallets will send their checkout codes there.</p>
        <Group footer="It will be able to take your coupons at checkout. It can never issue them.">
          <DetailRow label="Address" value={code.url} />
          <DetailRow label="Platform" value={PLATFORM_LABELS[code.platform].name} />
        </Group>
        {!online ? (
          <Notice tone="warning">Connecting a shop needs a connection.</Notice>
        ) : null}
        {failure ? (
          <div className="mb-4">
            <Alert>{failure}</Alert>
          </div>
        ) : null}
        <Button className="w-full" onClick={() => void connect()} disabled={busy || !online}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <Button
          variant="ghost"
          className="mt-2 w-full"
          onClick={() => {
            setCode(null)
            setFailure(null)
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-6 text-sm leading-relaxed text-mono-500">{EXPLAINER}</p>
      {!online ? <Notice tone="warning">Connecting a shop needs a connection.</Notice> : null}

      <Group
        title="Platform"
        footer={
          platform ? (
            <ol className="list-decimal space-y-1 pl-4" data-testid="platform-steps">
              {PLATFORM_LABELS[platform].steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
              <li>Copy the code it shows, or keep it on screen to scan.</li>
            </ol>
          ) : (
            'Where your shop runs. Each platform has an Imani add-on that shows a code to connect with.'
          )
        }
      >
        <div role="radiogroup" aria-label="Platform" className="divide-y divide-mono-200 dark:divide-mono-800">
          {ONLINE_SHOP_PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={platform === p}
              onClick={() => setPlatform(p)}
              className="press-row flex min-h-11 w-full items-center justify-between p-4 text-left text-mono-900 dark:text-mono-50"
            >
              {PLATFORM_LABELS[p].name}
              {platform === p ? <Check className="h-5 w-5 text-mono-900 dark:text-mono-50" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </Group>

      {/* Progressive disclosure: the code is asked for once there is a platform to get it from. */}
      {platform ? (
        <section className="mb-6">
          <h2 className="mb-2 px-4 text-xs font-medium uppercase tracking-wide text-mono-500">Your shop's code</h2>
          <ScanRecipient onFound={() => {}} onText={onText} selfPubkey={stallPubkey} manualLabel="Or paste the code from your shop" placeholder="imani-shop-enrol:1:…" />
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
        </section>
      ) : null}
    </div>
  )
}

function ConnectedShop({
  stallPubkey,
  shop,
  lapsed,
  notice: connectNotice,
  refresh,
  deps,
}: {
  stallPubkey: string
  shop: TerminalRecord
  lapsed: boolean
  /** Why the connect that made this row did not finish, if it did not. */
  notice: string | null
  refresh: () => void
  deps: {
    spendApi: () => Promise<CredentialMintApi>
    renew: (stallPubkey: string, terminalPubkey: string, api: CredentialMintApi) => Promise<{ started: boolean; message?: string }>
    profile: ProfilePublisher
    exposure: ExposureFetch
    now: () => number
  }
}) {
  const { spendApi, renew, profile, exposure, now } = deps
  const url = shop.shop!.url
  const host = shopHost(url)
  const minting = shop.status === 'minting'
  const waiting = shop.status === 'waiting' || minting || shop.gatewayState === 'unconfirmed'
  const inService = (shop.status === undefined || shop.status === 'in-service') && shop.gatewayState !== 'unconfirmed'

  // The shop's plugin finishes its side with the setup code, and shows the check code when it has
  // its credential: the same two codes a till's enrol screen shows (terminalDelivery, #160 review).
  const setup = shop.status === 'waiting' && shop.token && shop.voucherId ? setupCode(stallPubkey, shop.voucherId) : null
  const check = shop.voucherId ? formatCheckCode(checkCode(shop.voucherId, stallPubkey, shop.terminalPubkey)) : null
  const [setupQr, setSetupQr] = useState<string | null>(null)
  useEffect(() => {
    if (!setup) return
    let cancelled = false
    void QRCode.toDataURL(setup, { width: 512, margin: 1 }).then(
      (u) => !cancelled && setSetupQr(u),
      () => !cancelled && setSetupQr(null),
    )
    return () => {
      cancelled = true
    }
  }, [setup])

  // The profile's `online_shop` follows the roster (#402 §0): published once the shop is in
  // service, retried while this screen is open, and its state shown.
  const [published, setPublished] = useState<'publishing' | 'yes' | 'retrying' | 'gave-up'>('publishing')
  useEffect(() => {
    if (!inService) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = async (left: number) => {
      const out = await syncOnlineShop(stallPubkey, allTerminals(stallPubkey), profile).catch(() => ({ changed: true, published: false }))
      const failed = !out.published && (out.changed || onlineShopUnconfirmed(stallPubkey))
      if (stopped) return
      setPublished(!failed ? 'yes' : left > 0 ? 'retrying' : 'gave-up')
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

  const publishedText =
    published === 'publishing' ? 'Publishing…' : published === 'yes' ? 'Yes' : published === 'retrying' ? 'Not yet, trying again' : 'Not yet'
  const status = minting
    ? 'Being set up'
    : waiting
      ? shop.delivered === false
        ? 'Not received by the shop yet'
        : 'Waiting for the shop'
      : lapsed
        ? 'Taking no new codes'
        : 'Connected'
  const tone = minting || waiting ? 'pending' : lapsed ? 'warning' : 'ok'
  const shown = notice ?? (minting ? connectNotice : null)

  return (
    <div data-testid="online-shop-connected">
      <StatusHeader title={host} status={status} tone={tone} />

      {lapsed ? (
        <div data-testid="online-shop-lapsed">
          <Notice tone="warning">
            Your plan no longer includes online shops. {host} takes no new checkout codes; the ones customers already
            made still work until they are used or expire.{' '}
            <Link to="/settings/subscription" className="font-medium underline">
              Renew {ONLINE_SHOP_PLAN_NAME}
            </Link>
          </Notice>
        </div>
      ) : null}
      {shown ? (
        <div className="mb-4">
          <Alert>{shown}</Alert>
        </div>
      ) : null}

      {minting ? (
        <Group
          footer={
            <span data-testid="online-shop-minting">
              The gateway has not confirmed it yet. It is finished, or cleared, the next time you open this screen with a
              connection.
            </span>
          }
        >
          <DetailRow label="Platform" value={PLATFORM_LABELS[shop.shop!.platform].name} />
        </Group>
      ) : waiting ? (
        <Group
          title="Finish on your shop"
          footer={
            <span data-testid="online-shop-waiting">
              {shop.delivered === false
                ? `${host} has not received its connection yet. It is sent again each time you open this screen.`
                : `Waiting for ${host} to confirm. Keep its Imani settings open; this finishes on its own, and is cancelled after 24 hours if the shop never confirms.`}
            </span>
          }
        >
          {check ? (
            <div data-testid="online-shop-check-code" className="flex items-baseline justify-between gap-4 p-4">
              <span className="text-sm text-mono-500">Check code</span>
              <span className="font-mono text-lg font-medium tracking-wider text-mono-900 dark:text-mono-50" aria-label={`Check code ${check}`}>
                {check}
              </span>
            </div>
          ) : null}
          {setup ? (
            <details className="group p-4 text-sm">
              <summary className="flex min-h-6 cursor-pointer list-none items-center justify-between text-mono-900 dark:text-mono-50">
                Setup code
                <ChevronRight className="h-4 w-4 text-mono-400 transition-transform group-open:rotate-90" aria-hidden />
              </summary>
              {setupQr ? (
                <img src={setupQr} alt="Shop setup code" className="mx-auto mt-3 w-full max-w-xs rounded-2xl bg-white p-4" />
              ) : null}
              <p className="mt-2 break-all font-mono text-xs text-mono-500" data-testid="online-shop-setup-code">
                {setup}
              </p>
            </details>
          ) : null}
          <DetailRow label="Platform" value={PLATFORM_LABELS[shop.shop!.platform].name} />
        </Group>
      ) : (
        <Group footer={published === 'gave-up' ? 'Your shop is not on your public profile yet. It is tried again the next time you open this screen.' : undefined}>
          <div className="flex items-baseline justify-between gap-4 p-4">
            <span className="shrink-0 text-sm text-mono-500">Visible to customers</span>
            <span className="text-right text-mono-900 dark:text-mono-50" data-testid="online-shop-published">
              {publishedText}
            </span>
          </div>
          {outstanding ? (
            <div className="flex items-baseline justify-between gap-4 p-4">
              <span className="shrink-0 text-sm text-mono-500">Outstanding codes</span>
              <span className="text-right text-mono-900 dark:text-mono-50" data-testid="online-shop-exposure">
                {exposureSummary(outstanding)}
              </span>
            </div>
          ) : null}
          <DetailRow label="Platform" value={PLATFORM_LABELS[shop.shop!.platform].name} />
          <DetailRow label="Connected since" value={formatDay(shop.enrolledAt)} />
          {expiresAt !== undefined ? <DetailRow label="Renews by" value={formatDay(expiresAt * 1000)} /> : null}
        </Group>
      )}

      {band !== 'ok' && expiresAt !== undefined ? (
        <Group
          footer={
            <span
              className={band === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}
              data-testid="online-shop-expiry"
            >
              {band === 'expired'
                ? `${host} stopped taking coupons on ${formatDay(expiresAt * 1000)}. Renew it.`
                : `${host} stops taking coupons on ${formatDay(expiresAt * 1000)}. Renew it.`}
            </span>
          }
        >
          {renewable ? (
            <ActionRow onClick={() => void renewNow()} disabled={busy !== null}>
              {busy === 'renew' ? 'Renewing…' : 'Renew'}
            </ActionRow>
          ) : (
            <p className="p-4 text-sm text-mono-500">Renewal sent. {host} picks it up the next time it checks in.</p>
          )}
        </Group>
      ) : shop.renewal ? (
        <p className="mb-6 px-4 text-xs text-mono-500">Renewal sent. {host} picks it up the next time it checks in.</p>
      ) : null}

      {isRevocable(shop) && !minting ? (
        confirming ? (
          // In place, as an action sheet would: what happens, the destructive choice, then Cancel.
          <Group
            testId="online-shop-disconnect-confirm"
            footer={
              <>
                {outstanding && outstanding.codes > 0 ? (
                  <p className="mb-1">
                    {exposureLine(outstanding, url)}. Customers get those back when the codes expire, not at checkout.
                  </p>
                ) : null}
                <p>{host} stops taking your coupons within {REVOCATION_DELAY_HOURS} hours, when its session next expires.</p>
              </>
            }
          >
            <ActionRow tone="destructive" onClick={() => void disconnect()} disabled={busy !== null}>
              {busy === 'revoke' ? 'Disconnecting…' : `${waiting ? 'Cancel connecting' : 'Disconnect'} ${host}`}
            </ActionRow>
            <ActionRow onClick={() => setConfirming(false)}>Cancel</ActionRow>
          </Group>
        ) : (
          <Group>
            <ActionRow tone="destructive" onClick={() => setConfirming(true)} disabled={busy !== null}>
              {waiting ? 'Cancel connecting' : 'Disconnect'}
            </ActionRow>
          </Group>
        )
      ) : null}
    </div>
  )
}
