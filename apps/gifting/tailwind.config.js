/**
 * The wallet's theme (palette, type scale, tracking), with this app's sources and the wallet UI
 * components it renders added to `content`.
 */
import { fileURLToPath } from 'node:url'
import wallet from '../../tailwind.config.js'

const r = (p) => fileURLToPath(new URL(p, import.meta.url))

export default {
  ...wallet,
  content: [r('./index.html'), r('./src/**/*.{ts,tsx}'), r('../../src/components/ui/**/*.{ts,tsx}')],
}
