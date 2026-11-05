import { Navigate, Route, Routes } from 'react-router-dom'

import { Screen } from '@wallet/components/ui/layout'
import { ShopPage } from './pages/ShopPage'
import { ReturnPage } from './pages/ReturnPage'

/**
 * gifting.imani.casa (#410): a stall's vouchers, or a code for its online shop, by card, sent to
 * an email address.
 *
 * PUBLIC (owner, 2026-11-05): nobody signs in. Every buyer is a guest: the gift's refund key is a
 * fresh key made in this browser and comes back to the buyer as the return link in their email,
 * the same for everyone. payment-adapter still refuses a stall at draft time.
 */
export function App() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-md items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 font-semibold">
          <img src={`${import.meta.env.BASE_URL}imani.svg`} alt="" className="h-6 w-6" /> Imani gifts
        </span>
      </header>
      <main>
        <Routes>
          <Route path="/shop/:handle" element={<ShopPage step="form" />} />
          <Route path="/shop/:handle/review" element={<ShopPage step="review" />} />
          <Route path="/return" element={<ReturnPage />} />
          <Route
            path="/"
            element={
              <Screen>
                <h1 className="mb-2 text-title font-semibold">Send a gift</h1>
                <p className="text-callout text-mono-500">
                  Open a stall&apos;s gifting link, like <span className="font-medium">{window.location.host}/shop/name</span>, to buy a voucher, or a
                  code for its online shop, by card. There is no list of stalls here.
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
