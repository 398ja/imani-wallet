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
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
