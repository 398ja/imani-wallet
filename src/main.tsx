import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Side-effect import: NUT-18V voucher payment request parsing (vreqA…) has not
// been extracted into a package yet. shared/nut18v.js is a vanilla IIFE that
// ends with `window.NUT18V = NUT18V`, and imani-qr's PaymentRequestHandler looks
// the parser up as globalThis.NUT18V — so importing the file wires both sides.
// Cheaper and safer than reimplementing its CBOR codec.
import '../shared/nut18v.js'

import App from './App.tsx'
import { NapSignerPage } from './pages/NapSignerPage'
import { initNative, hideSplash } from './lib/native'
import { loadTrustedMints } from './lib/trustedMint'
import { installStaleBuildReload } from './lib/staleBuild'
import './index.css'

const queryClient = new QueryClient()

// The NAP signer popup (#411, #410 G10) is its own page, not a route in the app: it must not start
// a session, a relay connection or the DM poller, and it answers only the site that opened it.
const SIGNER_PAGE = window.location.pathname.replace(/\/+$/, '') === '/nap/signer'

// A tab left open across a deploy runs the old bundle; a missing lazy chunk proves it. Reload
// before stale code can move money (staging 2026-11-02: corda's licence 4de7f5b0).
installStaleBuildReload({
  addEventListener: (type, fn) => window.addEventListener(type, fn),
  reload: () => window.location.reload(),
  storage: window.sessionStorage,
  buildId: __APP_VERSION__,
})

// Android back button, status bar. No-op in a browser.
initNative()

// Ask the gateway which mint is ours before anything can receive a coupon (#133).
// Started here so it is usually done by the time login finishes; `startDmPoll`
// awaits the same promise before the poller's first catch-up. Never rejects.
if (!SIGNER_PAGE) void loadTrustedMints()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {SIGNER_PAGE ? (
      <NapSignerPage />
    ) : (
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    )}
  </StrictMode>,
)

// One frame after React has committed, so the splash lifts onto real content
// rather than onto an empty root. No-op in a browser.
requestAnimationFrame(() => {
  void hideSplash()
})
