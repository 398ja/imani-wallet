import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { LogOut } from 'lucide-react'

import { Centered } from '@wallet/components/ui/layout'
import { api, type Me } from './lib/api'
import { npubOf, type Signer } from './lib/signer'
import { PlansPage } from './pages/PlansPage'
import { SignInPage } from './pages/SignInPage'
import { AccountPage } from './pages/AccountPage'
import { DonePage } from './pages/DonePage'
import { AdminPage } from './pages/AdminPage'

/**
 * subscription.imani.casa: pick a plan, pay by card, and the licence arrives in the wallet.
 *
 * The signer lives in memory only, so leaving for Stripe's checkout (a full page load) signs the
 * stall out. That is deliberate: a secret key is never written to storage. The Done page therefore
 * works signed out (the licence is minted from Stripe's webhook, not from this tab), and offers to
 * sign in again to see the plan.
 */
export function App() {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const navigate = useNavigate()

  const refresh = useCallback(async () => {
    if (!signer) return
    try {
      setMe(await api.me(signer))
    } catch {
      setMe(null)
    }
  }, [signer])

  useEffect(() => {
    if (!signer) return
    let live = true
    api.me(signer).then(
      (m) => live && setMe(m),
      () => live && setMe(null),
    )
    return () => {
      live = false
    }
  }, [signer])

  const signIn = (s: Signer, next: string) => {
    setSigner(s)
    navigate(next, { replace: true })
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 pt-5">
        <Link to="/" className="pressable flex items-center gap-2 font-semibold">
          <img src={`${import.meta.env.BASE_URL}imani.svg`} alt="" className="h-6 w-6" /> Imani plans
        </Link>
        {signer ? (
          <div className="flex items-center gap-3 text-sm text-mono-500">
            <Link to="/account" className="pressable max-w-[10rem] truncate" title={npubOf(signer.pubkey)}>
              {npubOf(signer.pubkey).slice(0, 12)}…
            </Link>
            {me?.admin ? (
              <Link to="/admin" className="pressable">
                Admin
              </Link>
            ) : null}
            <button
              type="button"
              aria-label="Sign out"
              className="pressable"
              onClick={() => {
                setSigner(null)
                setMe(null)
                navigate('/')
              }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <Link to="/sign-in" className="pressable text-sm font-medium">
            Sign in
          </Link>
        )}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/plans" replace />} />
          <Route path="/plans" element={<PlansPage signer={signer} me={me} />} />
          <Route path="/sign-in" element={<SignInPage onSignedIn={signIn} />} />
          <Route path="/done" element={<DonePage signer={signer} onRefresh={refresh} />} />
          <Route
            path="/account"
            element={
              signer ? (
                <AccountPage signer={signer} me={me} onRefresh={refresh} />
              ) : (
                <Navigate to="/sign-in?next=/account" replace />
              )
            }
          />
          <Route
            path="/admin"
            element={
              !signer ? (
                <Navigate to="/sign-in?next=/admin" replace />
              ) : me === null ? (
                <Centered>Checking…</Centered>
              ) : me.admin ? (
                <AdminPage signer={signer} />
              ) : (
                <Navigate to="/plans" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/plans" replace />} />
        </Routes>
      </main>
    </div>
  )
}
