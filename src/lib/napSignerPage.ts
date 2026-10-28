/**
 * The wallet's NAP signer POPUP, `/nap/signer` (#411, #410 G10, NAP extension 0002).
 *
 * There are two ways a sister site gets its login signed by this wallet, and this is the second:
 *
 * 1. The wallet OPENS the site (Settings › Subscription › Upgrade): the tab that is already
 *    unlocked answers it directly (`sisterSiteSigner.ts`). No popup, no passphrase.
 * 2. The SITE opens the wallet: a buyer on gifting.imani.casa taps "Sign in with Imani wallet", and
 *    `connectCrossOrigin` opens this page in a popup on the wallet's origin. This page holds no key
 *    when it opens (the wallet's unlocked key lives in another tab's memory, and nothing shares
 *    it), so it unlocks the stored key HERE, with the passphrase, on the wallet's own origin and
 *    address bar, asks once whether the site may sign the person in, and then signs only what the
 *    policy allows that site (`napSignerPolicy.ts`): kind 27235 addressed to the site itself.
 *
 * This module is the page's logic, with the UI's questions (passphrase, consent) as promises the
 * page answers. Everything nap enforces stays in nap's `mountCrossOriginSigner`: opener-only,
 * browser-reported origin, policy kinds and audiences, the expected-pubkey guard, step-up, the
 * BroadcastChannel revocation on lock and logout in any tab.
 *
 * What the wallet adds:
 * - the key is decrypted only after a policy site asked (never on page load), held only in this
 *   popup's memory, and zeroed when the popup goes away, on logout in another tab, or on `close()`;
 * - a terminal (a till) never signs for anyone: its key is not a person's identity;
 * - a device with no stored key says so instead of asking for a passphrase nothing can check;
 * - remembered consents live under `imani-wallet:` so logout's sweep forgets them.
 */
import {
  createStorageConsentStore,
  mountCrossOriginSigner,
  type ConsentRequest,
  type ConsentStore,
  type CrossOriginPolicy,
  type CrossOriginSignerHandle,
  type CrossOriginSignerOptions,
  type LiveGrant,
  type SessionSigner,
} from '@imani/nap-client-web'

type WindowLike = NonNullable<CrossOriginSignerOptions['opener']>
type MessageTarget = NonNullable<CrossOriginSignerOptions['target']>

/** Where the "yes" answers are kept. The `imani-wallet:` prefix is what logout sweeps. */
export const CONSENT_STORAGE_KEY = 'imani-wallet:nap-consent'

/** The consent store, shared by this page and Settings › Security › Connected sites. */
export function walletConsentStore(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): ConsentStore {
  return createStorageConsentStore(storage, CONSENT_STORAGE_KEY)
}

/** What the page shows. */
export type SignerView =
  /** Mounted, waiting for the site that opened it to ask. */
  | { state: 'waiting' }
  /** This window cannot sign for anyone. The page says why and offers nothing to do. */
  | { state: 'unavailable'; reason: 'no-opener' | 'framed' | 'no-key' | 'terminal' }
  /** A policy site asked; the stored key has to be unlocked first. */
  | { state: 'unlock'; origin: string; error?: string }
  /** Unlocked; may this site sign the person in? */
  | { state: 'consent'; request: ConsentRequest }
  /** The site is signed in. It may still ask for proofs inside the grant while this stays open. */
  | { state: 'connected'; grants: LiveGrant[] }
  /** The person said no, or cancelled the unlock. */
  | { state: 'declined'; origin: string }
  /** Logged out or locked elsewhere, or the grant ended: nothing more will be signed here. */
  | { state: 'ended' }

/** A signer whose key the page can put in and take out. `createWalletSigner` is one. */
export interface UnlockableSigner extends SessionSigner {
  clearKey(): void
}

export interface SignerPageDeps {
  policy: CrossOriginPolicy
  keyStore: { hasKey(): Promise<boolean>; loadKey(passphrase: string): Promise<string> }
  /** Builds the signer from the decrypted key. */
  makeSigner(privkeyHex: string): UnlockableSigner
  /** True on a till: it never signs a person in anywhere. */
  isTerminal(): boolean
  consentStore: ConsentStore
  onView(view: SignerView): void
  // Injectable for tests; the browser's own by default.
  opener?: WindowLike | null
  target?: MessageTarget
  isFramed?: boolean
  mount?: typeof mountCrossOriginSigner
  /** The session BroadcastChannel name the wallet's own tabs publish lock/logout on. */
  sessionChannel?: string | false
  /** Aborted before the page finished starting (React unmounted it): mount nothing, announce nothing. */
  signal?: AbortSignal
}

export interface SignerPage {
  /** The passphrase the unlock view collected. Resolves when it opened the key, rejects when wrong. */
  submitPassphrase(passphrase: string): Promise<void>
  /** "Not now" on the unlock view. */
  cancelUnlock(): void
  /** The consent view's answer. */
  answerConsent(allow: boolean): void
  /** Stop answering and zero the key. */
  close(): void
}

/** The thrown error a failed unlock shows, written for the person reading it. */
const WRONG_PASSPHRASE = 'That passphrase is not right. Try again.'

/**
 * Start the signer page. Call once, after the page has rendered (the site waits up to 15 s for
 * "ready", which nap's mount sends).
 */
export async function startSignerPage(deps: SignerPageDeps): Promise<SignerPage> {
  const view = deps.onView
  const opener = deps.opener !== undefined ? deps.opener : ((window.opener as WindowLike | null) ?? null)
  const isFramed = deps.isFramed ?? window.top !== window.self

  const inert: SignerPage = {
    submitPassphrase: async () => {},
    cancelUnlock: () => {},
    answerConsent: () => {},
    close: () => {},
  }
  // The same refusals nap makes, made first so the page can say something: a framed page shows no
  // unlock UI at all (clickjacking), and a page opened by hand has nobody to answer.
  if (isFramed) {
    view({ state: 'unavailable', reason: 'framed' })
    return inert
  }
  if (!opener) {
    view({ state: 'unavailable', reason: 'no-opener' })
    return inert
  }
  if (deps.isTerminal()) {
    view({ state: 'unavailable', reason: 'terminal' })
    return inert
  }
  if (!(await deps.keyStore.hasKey())) {
    view({ state: 'unavailable', reason: 'no-key' })
    return inert
  }
  if (deps.signal?.aborted) return inert

  let inner: UnlockableSigner | null = null
  let ended = false
  let pendingUnlock: { resolve: () => void; reject: (e: Error) => void; origin: string } | null = null
  let pendingConsent: ((allow: boolean) => void) | null = null
  let lastGrants: LiveGrant[] = []
  // Which site is asking, for the unlock view. nap calls ensureUnlocked inside its connect handler,
  // after its policy check, so the origin is known by then only through the message itself; the
  // listener below records it first.
  let askingOrigin = ''

  const dropKey = () => {
    inner?.clearKey()
    inner = null
  }

  // The signer nap is mounted with. It forwards to the key once unlocked; before that (and after
  // the key is dropped) it refuses, which nap reports to the site as SIGNER_ERROR.
  const signer: SessionSigner = {
    getNpub: () => {
      if (!inner) throw new Error('locked')
      return inner.getNpub()
    },
    signEvent: (template) => {
      if (!inner) return Promise.reject(new Error('locked'))
      return inner.signEvent(template)
    },
  }

  const target = deps.target ?? (window as unknown as MessageTarget)
  // Notes which policy origin is asking to connect, so the unlock view can name it. Registered
  // before nap's own listener, so it runs first for the same message. Only a policy origin from
  // the opener counts; nothing here answers anyone.
  const noteAsker = (event: { origin: string; source?: unknown; data: unknown }) => {
    const data = event.data as { type?: unknown } | null
    if (event.source === opener && deps.policy[event.origin] && data?.type === 'connect') askingOrigin = event.origin
  }
  target.addEventListener('message', noteAsker)

  const mount = deps.mount ?? mountCrossOriginSigner
  const handle: CrossOriginSignerHandle = mount({
    policy: deps.policy,
    signer,
    opener,
    target,
    isFramed: false,
    consentStore: deps.consentStore,
    sessionChannel: deps.sessionChannel,
    ensureUnlocked: () => {
      if (ended) return Promise.reject(new Error('ended'))
      if (inner) return Promise.resolve()
      // One unlock at a time: a second connect while the first is being answered waits on it.
      return new Promise<void>((resolve, reject) => {
        pendingUnlock?.reject(new Error('superseded'))
        pendingUnlock = { resolve, reject, origin: askingOrigin }
        view({ state: 'unlock', origin: askingOrigin })
      })
    },
    onConsent: (request) =>
      new Promise<boolean>((resolve) => {
        if (ended) return resolve(false)
        pendingConsent?.(false)
        pendingConsent = resolve
        view({ state: 'consent', request })
      }).then((allow) => {
        if (!allow) view({ state: 'declined', origin: request.origin })
        return allow
      }),
    onGrantsChanged: (grants) => {
      const had = lastGrants.length > 0
      lastGrants = [...grants]
      if (ended) return
      if (grants.length > 0) view({ state: 'connected', grants: lastGrants })
      else if (had) {
        // Every grant ended (expired, the site disconnected, lock or logout elsewhere): nothing in
        // this popup needs the key any more.
        dropKey()
        view({ state: 'ended' })
      }
    },
  })

  // Logout in another wallet tab: nap revokes the grants on the same channel; this also drops a key
  // unlocked for a connect that has not finished.
  let bus: BroadcastChannel | undefined
  const channel = deps.sessionChannel ?? 'nap-session'
  if (channel !== false && typeof BroadcastChannel !== 'undefined') {
    bus = new BroadcastChannel(channel)
    bus.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data as unknown
      const type = typeof data === 'string' ? data : (data as { type?: unknown } | null)?.type
      if (type === 'lock' || type === 'logout' || type === 'shutdown' || type === 'identity-changed') {
        dropKey()
        pendingUnlock?.reject(new Error(String(type)))
        pendingUnlock = null
        pendingConsent?.(false)
        pendingConsent = null
        if (!ended) view({ state: 'ended' })
      }
    })
  }

  view({ state: 'waiting' })

  const close = () => {
    if (ended) return
    ended = true
    pendingUnlock?.reject(new Error('closed'))
    pendingUnlock = null
    pendingConsent?.(false)
    pendingConsent = null
    handle.close()
    target.removeEventListener('message', noteAsker)
    bus?.close()
    dropKey()
  }

  return {
    async submitPassphrase(passphrase: string) {
      const asked = pendingUnlock
      if (!asked || ended) return
      let hex: string
      try {
        hex = await deps.keyStore.loadKey(passphrase)
      } catch {
        // Wrong passphrase: stay on the unlock view, say so, keep the site waiting.
        view({ state: 'unlock', origin: asked.origin, error: WRONG_PASSPHRASE })
        throw new Error(WRONG_PASSPHRASE)
      }
      if (pendingUnlock !== asked || ended) return
      inner = deps.makeSigner(hex)
      pendingUnlock = null
      asked.resolve()
    },
    cancelUnlock() {
      const asked = pendingUnlock
      if (!asked) return
      pendingUnlock = null
      view({ state: 'declined', origin: asked.origin })
      asked.reject(new Error('cancelled'))
    },
    answerConsent(allow: boolean) {
      const answer = pendingConsent
      pendingConsent = null
      answer?.(allow)
    },
    close,
  }
}
