import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import './index.css'
import { App } from './App'

// Follow the device, as the wallet does (`darkMode: 'class'`).
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const apply = () => document.documentElement.classList.toggle('dark', dark.matches)
apply()
dark.addEventListener('change', apply)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
