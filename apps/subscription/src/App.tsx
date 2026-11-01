import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { LogOut } from 'lucide-react'

import { Button } from '@wallet/components/ui/Button'
import { IdentityInline } from '@wallet/components/ui/IdentityInline'
import { Centered, Screen } from '@wallet/components/ui/layout'
import { api, SessionEnded, type Me } from './lib/api'
import { currentAccount, expectedStall, signInThroughWallet, signOut, SignInError, stallLabel, type Account, type SignInFailure } from './lib/session'
import { PlansPage } from './pages/PlansPage'
import { AccountPage } from './pages/AccountPage'
import { DonePage } from './pages/DonePage'
import { AdminPage } from './pages/AdminPage'

type Gate =
  | { state: 'checking' }
  | { state: 'signing-in' }
  | { state: 'refused'; reason: SignInFailure }
  | { state: 'signed-out' }
  | { state: 'in'; account: Account }

/**
 * subscription.imani.casa: pick a plan, pay by card, and the licence arrives in the wallet.
 *
 * **Every page needs a session, and there is no login page (#411).** The stall comes here from its
 * wallet (Settings › Subscription › Upgrade), which opened this tab and signs the NAP login for it.
 * The session is an HttpOnly cookie, for merchants only. Leaving for Stripe and coming back keeps
 * it; a reload keeps it. When there is none, the only way in is the wallet, and the page says so.
 */
export function App() {
  const [gate, setGate] = useState<Gate>({ state: 'checking' })
  const [me, setMe] = useState<Me | null>(null)
  const expected = expectedStall()
  const [label] = useState(() => stallLabel())

  // Who this stall is on the service, and its plans: loaded once the gate opens, and again on demand.
  const loadMe = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch (e) {
      if (e instanceof SessionEnded) setGate({ state: 'signed-out' })
      else setMe(null)
    }
  }, [])

  const signIn = useCallback(async () => {
    setGate({ state: 'signing-in' })
    try {
      const account = await signInThroughWallet({ expectedPubkey: expected })
      setGate({ state: 'in', account })
      void loadMe()
    } catch (e) {
      setGate({ state: 'refused', reason: e instanceof SignInError ? e.reason : 'error' })
    }
  }, [expected, loadMe])

  // On load: an existing session (back from Stripe, a reload) is used as it is; otherwise sign in
  // through the wallet that opened this tab.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const account = await currentAccount()
        if (!live) return
        // A session for a different stall than the wallet asked for is not this stall's session.
        if (account && (!expected || account.pubkey === expected)) {
          setGate({ state: 'in', account })
          void loadMe()
          return
        }
        if (account) await signOut()
        if (live) await signIn()
      } catch {
        if (live) setGate({ state: 'refused', reason: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [expected, signIn, loadMe])

  const refresh = loadMe

  const leave = async () => {
    await signOut()
    setMe(null)
    setGate({ state: 'signed-out' })
  }

  if (gate.state !== 'in') return <Shell>{gateScreen(gate, signIn)}</Shell>
  const { account } = gate

  return (
    <Shell
      header={
        <div className="flex items-center gap-3 text-sm text-mono-500">
          <Link to="/account" className="pressable min-w-0 max-w-[14rem]" aria-label="My plan">
            <IdentityInline
              pubkey={account.pubkey}
              size="sm"
              linkToProfile={false}
              fallbackName={label?.pubkey === account.pubkey ? label.name : undefined}
              fallbackHandle={label?.pubkey === account.pubkey ? label.nip05 : undefined}
              fallbackPicture={label?.pubkey === account.pubkey ? label.picture : undefined}
            />
          </Link>
          {me?.admin ? (
            <Link to="/admin" className="pressable">
              Admin
            </Link>
          ) : null}
          <button type="button" aria-label="Sign out" className="pressable" onClick={() => void leave()}>
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<Navigate to="/plans" replace />} />
        <Route path="/plans" element={<PlansPage me={me} onSessionEnded={() => setGate({ state: 'signed-out' })} />} />
        <Route path="/done" element={<DonePage onRefresh={refresh} />} />
        <Route path="/account" element={<AccountPage me={me} onRefresh={refresh} />} />
        <Route
          path="/admin"
          element={me === null ? <Centered>Checking…</Centered> : me.admin ? <AdminPage /> : <Navigate to="/plans" replace />}
        />
        <Route path="*" element={<Navigate to="/plans" replace />} />
      </Routes>
    </Shell>
  )
}

function Shell({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 font-semibold">
          <img src={`${import.meta.env.BASE_URL}imani.svg`} alt="" className="h-6 w-6" /> Imani plans
        </span>
        {header}
      </header>
      <main>{children}</main>
    </div>
  )
}

/** What a stall sees before it is in: always a sentence and, when there is one, the way forward. */
function gateScreen(gate: Exclude<Gate, { state: 'in' }>, retry: () => void) {
  if (gate.state === 'checking' || gate.state === 'signing-in') {
    return <Centered>{gate.state === 'checking' ? 'Checking…' : 'Signing in with your wallet…'}</Centered>
  }
  const reason: SignInFailure = gate.state === 'signed-out' ? 'from-wallet' : gate.reason
  const copy = REFUSALS[reason]
  return (
    <Screen>
      <div className="mt-10 text-center" role="alert">
        <h1 className="text-title font-semibold">{copy.title}</h1>
        <p className="mt-2 text-callout text-mono-500">{copy.body}</p>
        {copy.retry && window.opener ? (
          <Button className="mt-6" onClick={retry}>
            Try again
          </Button>
        ) : null}
      </div>
    </Screen>
  )
}

const OPEN_FROM_WALLET = 'Open your Imani wallet, go to Settings › Subscription, and tap Upgrade my plan.'

const REFUSALS: Record<SignInFailure, { title: string; body: string; retry: boolean }> = {
  'from-wallet': { title: 'Open this from your wallet', body: `Plans are managed from your stall’s wallet. ${OPEN_FROM_WALLET}`, retry: true },
  locked: { title: 'Your wallet is locked', body: 'Unlock your wallet in the other tab, then try again here.', retry: true },
  'not-merchant': {
    title: 'Plans are for stalls',
    body: 'This wallet does not have a stall. Set one up in your wallet first, then come back from Settings › Subscription.',
    retry: false,
  },
  'wrong-account': {
    title: 'A different stall is signed in',
    body: `Your wallet is signed in as another stall than the one this page was opened for. ${OPEN_FROM_WALLET}`,
    retry: false,
  },
  error: { title: 'We could not sign you in', body: 'Something went wrong on our side. Please try again in a moment.', retry: true },
}
