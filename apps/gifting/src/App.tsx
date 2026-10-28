import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { LogOut } from 'lucide-react'

import { IdentityInline } from '@wallet/components/ui/IdentityInline'
import { Screen } from '@wallet/components/ui/layout'
import { connect, isLive, type Session } from './lib/signer'
import { ShopPage } from './pages/ShopPage'
import { ReturnPage } from './pages/ReturnPage'

/**
 * gifting.imani.casa (#410): a stall's vouchers, by card, for yourself, a handle or an email.
 *
 * The session is a cross-origin grant from the wallet (G10) and lives in memory only. Leaving for
 * Stripe drops it, which is fine: delivery runs from Stripe's webhook, and the return page works
 * signed out.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    return session.grant.onEnd(() => setSession(null))
  }, [session])

  /** Synchronous in the click: the popup opens inside `connect` (NAP 0002). */
  const signIn = (expectedPubkey?: string) => {
    setSignInError(null)
    connect({ expectedPubkey }).then(setSession, (e: unknown) =>
      setSignInError(e instanceof Error && /closed|denied|cancel/i.test(e.message) ? 'Sign-in was cancelled.' : 'Could not sign in with your wallet. Try again.'),
    )
  }
  const live = isLive(session) ? session : null

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
                live.grant.disconnect()
                setSession(null)
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
          <Route path="/shop/:handle" element={<ShopPage session={live} onSignIn={signIn} step="form" />} />
          <Route path="/shop/:handle/review" element={<ShopPage session={live} onSignIn={signIn} step="review" />} />
          <Route path="/return" element={<ReturnPage />} />
          <Route
            path="/"
            element={
              <Screen>
                <h1 className="mb-2 text-title font-semibold">Send a voucher</h1>
                <p className="text-callout text-mono-500">
                  Open a stall&apos;s gifting link, like <span className="font-medium">gifting.imani.casa/shop/name</span>, to buy one of
                  its vouchers by card. There is no list of stalls here.
                </p>
                <p className="mt-6 text-sm text-mono-500">
                  <Link className="underline" to="/">
                    imani.casa
                  </Link>
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
