import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { LogOut } from 'lucide-react'

import { IdentityInline } from '@wallet/components/ui/IdentityInline'
import { Screen } from '@wallet/components/ui/layout'
import { currentAccount, signIn as signInWithWallet, signOut, SignInError, type Account } from './lib/session'
import { ShopPage } from './pages/ShopPage'
import { ReturnPage } from './pages/ReturnPage'

/**
 * gifting.imani.casa (#410): a stall's vouchers, by card, for a handle or an email.
 *
 * For customers and guests only (owner, 2026-10-28). A stall's wallet is refused sign-in by the
 * wallet itself (napSignerPolicy `siteAudience`), and payment-adapter refuses a stall at login and
 * at draft time.
 *
 * Signing in is one NAP login signed through the wallet's window (G10); the session then lives in an
 * HttpOnly cookie from payment-adapter, so it survives the trip to Stripe and back (`session.ts`).
 */
export function App() {
  const [account, setAccount] = useState<Account | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)

  // The cookie may already carry a session (back from Stripe, a reload, a second tab).
  useEffect(() => {
    let live = true
    void currentAccount().then((a) => live && a && setAccount(a))
    return () => {
      live = false
    }
  }, [])

  /** Synchronous in the click: the popup opens inside `signIn` (NAP 0002). */
  const signIn = () => {
    setSignInError(null)
    signInWithWallet().then(setAccount, (e: unknown) => {
      const reason = e instanceof SignInError ? e.reason : 'error'
      setSignInError(
        // DECLINED covers "not now" and a stall account (this site is for customers and guests): the
        // wallet window already said which. Here, only what the buyer can do next.
        reason === 'declined' || reason === 'not-customer'
          ? 'Not signed in. You can still buy as a guest.'
          : reason === 'cancelled'
            ? 'Sign-in was cancelled.'
            : 'Could not sign in with your wallet. Try again.',
      )
    })
  }
  const live = account

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-md items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 font-semibold">
          <img src={`${import.meta.env.BASE_URL}imani.svg`} alt="" className="h-6 w-6" /> Imani gifts
        </span>
        {live ? (
          <div className="flex items-center gap-3 text-sm text-mono-500">
            <span className="min-w-0 max-w-[14rem]">
              <IdentityInline pubkey={live.pubkey} size="sm" linkToProfile={false} />
            </span>
            <button
              type="button"
              aria-label="Sign out"
              className="pressable"
              onClick={() => {
                setAccount(null)
                void signOut()
              }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button type="button" className="pressable text-sm font-medium" onClick={() => signIn()}>
            Sign in with your wallet
          </button>
        )}
      </header>
      {signInError && (
        <p role="alert" className="mx-auto mt-2 max-w-md px-5 text-sm text-red-600">
          {signInError}
        </p>
      )}
      <main>
        <Routes>
          <Route path="/shop/:handle" element={<ShopPage session={live} step="form" />} />
          <Route path="/shop/:handle/review" element={<ShopPage session={live} step="review" />} />
          <Route path="/return" element={<ReturnPage />} />
          <Route
            path="/"
            element={
              <Screen>
                <h1 className="mb-2 text-title font-semibold">Send a voucher</h1>
                <p className="text-callout text-mono-500">
                  Open a stall&apos;s gifting link, like <span className="font-medium">{window.location.host}/shop/name</span>, to buy one of
                  its vouchers by card. There is no list of stalls here.
                </p>
              </Screen>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
