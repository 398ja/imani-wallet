// `vitest/config`, not `vite`: this file now carries a `test` block, and vite's
// own defineConfig does not type it.
import { defineConfig } from 'vitest/config'
import type { Connect, Plugin, ViteDevServer, PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { ClientRequest } from 'node:http'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Consume @imani/* and @imani/nap-* straight from source — no build step, no
// npm link. This is nap's own convention (its packages point `exports` at
// ./src/index.ts and ship no dist/), and every one of these packages is plain
// framework-agnostic TS, so there is nothing React-specific to compile first.
//
// Because aliasing bypasses each package's own node_modules, their runtime deps
// (nostr-tools, qr-scanner, @gandlaf21/bc-ur, buffer) are installed here.
//
// `imani` now points INSIDE this repo. The 11 wallet packages were copied out of
// imani-apps and this repo owns them, which is what makes a Docker build
// possible at all: a build context rooted here could never see ../imani-apps.
// nap is deliberately still a sibling — it is a separate product with other
// consumers — so the image reproduces the ../nap layout via a second build
// context. See Dockerfile.
const imani = (name: string) => r(`./packages/${name}/src/index.ts`)
const nap = (name: string) => r(`../nap/packages/${name}/src/index.ts`)

/**
 * The shared secret gateway-portal trusts its edge proxy with.
 *
 * Read here, in the Vite config, NOT through `import.meta.env` — anything with a
 * `VITE_` prefix is inlined into the client bundle, and this must never be. See
 * the `/api/v1/portal` proxy rule below for why the browser cannot hold it.
 *
 * Matches GATEWAY_PORTAL_EDGE_SHARED_SECRET in deploy/compose.override.yml.
 */
const PORTAL_EDGE_SECRET = process.env.PORTAL_EDGE_SECRET ?? 'dev-edge-secret-local-only'

/** account-app — the only service that can read the NAP session store. */
const ACCOUNT_APP = 'http://localhost:28081'

/**
 * The auth_request step a real edge proxy performs, played here by Vite.
 *
 * gateway-portal runs against a different database than account-app, so it cannot
 * validate a NAP session itself. It learns both identity and capability from the
 * edge: `GET /api/v1/auth/validate` answers 200 with `X-Auth-Pubkey` and
 * `X-Auth-Permissions`, and those two headers are what the portal trusts (paired
 * with the shared secret added in the proxy rule below).
 *
 * Two properties this MUST hold, both of them the whole point:
 *
 * 1. **Inbound copies are dropped first.** Both headers are caller-supplied over the
 *    wire, so a page could otherwise send `X-Auth-Permissions: coupon:issue` and
 *    issue as itself. Stripping before validating is the OPS requirement written
 *    into NapProxyAuthFilter's javadoc, and this is where it is honoured in dev.
 * 2. **It fails closed.** A failed or unreachable validate leaves the request with
 *    no pubkey, so the proxy rule below does not attach the secret and the portal
 *    answers 401 — rather than silently downgrading to whatever the page claimed.
 *
 * This also retires the older shim, which forwarded the pubkey the page asserted.
 * The pubkey now comes from the session cookie, checked server-side, which is what
 * a deployment's nginx does.
 */
const PORTAL_PREFIX = '/api/v1/portal'

/**
 * The exact test Vite's proxy uses to pick the `/api/v1/portal` rule: a bare
 * `startsWith` on the RAW url.
 *
 * This is not a stylistic choice. Mounting the middleware with
 * `server.middlewares.use(PORTAL_PREFIX, …)` looks equivalent and is not:
 * Connect matches on the PARSED, case-insensitive pathname and demands a `/` or
 * `.` boundary, while the proxy matches the raw url with no boundary at all. Every
 * path where those two disagree is a request that reaches the proxy WITHOUT being
 * stripped — `/api/v1/portalfoo` is proxied but was never mounted — and the proxy
 * then attaches the shared secret to whatever `X-Auth-Pubkey` and
 * `X-Auth-Permissions` the page sent. No such route exists on the portal today, so
 * this was latent rather than live; it stops being latent the day someone adds one.
 * Sharing one predicate makes the two impossible to drift apart.
 */
const isPortalRequest = (url: string | undefined): boolean =>
  (url ?? '').startsWith(PORTAL_PREFIX)

const edgeAuth: Connect.NextHandleFunction = (req, _res, next) => {
  if (!isPortalRequest(req.url)) {
    next()
    return
  }

  // All three, in the same order nap_auth.lua clears them. X-Edge-Auth is on the
  // list because a page that guessed the dev secret could otherwise present it
  // itself; stripping the pubkey alone leaves that turning on the portal's
  // fail-closed branch rather than on this one.
  delete req.headers['x-auth-pubkey']
  delete req.headers['x-auth-permissions']
  delete req.headers['x-edge-auth']

  fetch(`${ACCOUNT_APP}/api/v1/auth/validate`, {
    headers: { cookie: req.headers.cookie ?? '' },
    // Without a deadline, an account-app that accepts the connection and never
    // answers hangs this request forever, and with it every Sell — the wallet
    // would show a spinner rather than a failure.
    signal: AbortSignal.timeout(5000),
  })
    .then((response) => {
      const pubkey = response.ok ? response.headers.get('x-auth-pubkey') : null
      if (pubkey) {
        req.headers['x-auth-pubkey'] = pubkey
        req.headers['x-auth-permissions'] = response.headers.get('x-auth-permissions') ?? ''
      }
    })
    .catch(() => {
      // Unreachable or too-slow account-app: stay unauthenticated. Logged rather
      // than swallowed, because "every Sell is suddenly 401" and "the auth service
      // is down" look identical from the browser.
      console.warn('[edge-auth] /api/v1/auth/validate unreachable — request stays unauthenticated')
    })
    .finally(next)
}

const portalEdgeAuth = (): Plugin => ({
  name: 'portal-edge-auth',
  // Mounted at the root and filtered inside, so the middleware sees every request
  // the proxy could possibly claim. Added in the hook body rather than a returned
  // callback: that installs it BEFORE Vite's internal middlewares, and the proxy
  // is an internal one.
  configureServer: (server: ViteDevServer) => {
    server.middlewares.use(edgeAuth)
  },
  configurePreviewServer: (server: PreviewServer) => {
    server.middlewares.use(edgeAuth)
  },
})

/**
 * Same-origin proxying so the NAP session cookie just works — no CORS config,
 * no SameSite=None, no credentials plumbing in the prototype.
 *
 * Shared by `server` and `preview` deliberately. `vite preview` serves the
 * production bundle but does NOT inherit `server.proxy`, so a locally built app
 * would answer every `/api` call with its own index.html — which surfaces as
 * "Unexpected token '<'" while parsing JSON, not as a routing error.
 *
 * Order matters — Vite matches these prefixes in declaration order, and `/api`
 * would otherwise swallow `/api/v1/auth`.
 *
 * The two gateways share the `/api/v1` namespace but are different services:
 * NAP auth lives on account-app, while wallet/nostr/dm live on customer-wallet.
 * shared/api.js issues relative paths like `/api/v1/wallet/receive`, so the
 * split has to happen here rather than in a baseUrl.
 */
/**
 * Exported so the performance recorder serves the built bundle through the
 * same routing table the dev server uses. A second copy would drift, and the
 * `changeOrigin` choices below are exactly the kind of detail that gets
 * silently wrong in a copy: a NIP-98 route proxied with `changeOrigin: true`
 * fails signature verification for reasons nothing in the error explains.
 */
export const proxy = {
  '/api/v1/auth': { target: 'http://localhost:28081', changeOrigin: true },
  // The escrowed send saga lives on account-app, NOT customer-wallet, which
  // 404s it. This mirrors imani-apps' own nginx.conf.template, where
  // `location /api/` proxies to account-app:8081 — the vanilla send screen has
  // always talked to that tier. Must be listed BEFORE '/api' to win the prefix
  // match. changeOrigin stays false for the same NIP-98 reason.
  '/api/v1/atomic-send': { target: 'http://localhost:28081', changeOrigin: false },
  // Account registration and runtime config also live on account-app. Without
  // these two they fall into the '/api' rule below and hit customer-wallet,
  // which 404s them — and a 404 on /api/v1/nip05 reads as "the endpoint does not
  // exist" rather than "it is on the other gateway".
  //
  // changeOrigin: false for /api/v1/nip05 for the atomic-send reason above: the
  // claim is NIP-98 authenticated, and the signed `u` tag is the browser origin.
  '/api/v1/nip05': { target: 'http://localhost:28081', changeOrigin: false },
  '/api/v1/config': { target: 'http://localhost:28081', changeOrigin: true },
  // Voucher ISSUANCE is a merchant action and lives on gateway-portal, a third
  // tier this file did not know about. customer-wallet refuses it outright
  // ("Voucher creation not supported on JdbcWalletPort — customer-wallet is
  // self-custodial"), so without this rule every Sell lands on 28082 and reads
  // as a permissions problem rather than a routing one.
  //
  // Also serves the merchant dashboard (`/portal/dashboard/composite`) and the
  // issued-coupon list (`/portal/vouchers`). Probed on the live stack: these
  // answer 401 "NIP-98 authentication required", whereas a path this gateway
  // does not route answers 403 with an EMPTY body — which is how we know
  // `/api/v1/merchant/*` (possa-merchant's bootstrap/onboarding surface) does
  // not exist here at all.
  //
  // changeOrigin: false for the same NIP-98 reason as /api/v1/nip05 above —
  // issuance is signed, and the `u` tag carries the browser origin.
  //
  // THE EDGE HEADER IS NOT OPTIONAL, and it is not belt-and-braces. Verified
  // against this image: a correctly-formed NIP-98 header whose `u` matches
  // exactly, sent DIRECTLY to :28084 with no proxy in the way, still comes back
  // 401 `NIP-98 authentication required`. The portal's Nip98AuthFilter does not
  // authenticate on this build; only NapProxyAuthFilter's edge path does. That
  // is why scripts/seed-merchant.mjs sends both and says "whichever the deployed
  // portal build honours wins" — on this stack it is always the edge one.
  //
  // So Vite plays the edge proxy, which is what a real deployment puts here. The
  // `portal-edge-auth` middleware above has already validated the session cookie
  // against account-app and set X-Auth-Pubkey and X-Auth-Permissions from the
  // answer; this rule adds the shared secret that vouches for both. The secret
  // stays in this file and never reaches the bundle — shipping it would let anyone
  // issue vouchers as any pubkey, and now with any permissions, since both headers
  // are caller-supplied and the secret is the only thing vouching for them.
  '/api/v1/portal': {
    target: 'http://localhost:28084',
    changeOrigin: false,
    configure: (proxy: {
      on(event: 'proxyReq', cb: (req: ClientRequest) => void): void
    }) => {
      proxy.on('proxyReq', (proxyReq) => {
        // Only for a request the middleware authenticated. One that failed
        // validation must stay unauthenticated rather than be silently upgraded.
        if (proxyReq.getHeader('x-auth-pubkey')) {
          proxyReq.setHeader('X-Edge-Auth', PORTAL_EDGE_SECRET)
        } else {
          // No validated pubkey means the middleware refused or never ran, so a
          // permissions header here could only have come from the page. It cannot
          // authorize anything without the secret, but forwarding it at all would
          // leave the portal's fail-closed branch as the only thing standing
          // between a page and its own claimed authorities.
          proxyReq.removeHeader('x-auth-permissions')
        }
      })
    },
  },
  // changeOrigin MUST stay false here. shared/api.js signs the NIP-98 `u` tag
  // with the browser origin, and the gateway compares it against the URL it
  // reconstructs from the Host header. Rewriting Host to localhost:28082 makes
  // every authenticated wallet call fail with 401 AUTH_002 "URL mismatch" —
  // which reads as a credential problem, not a proxy one.
  '/api': { target: 'http://localhost:28082', changeOrigin: false },
}

/**
 * Emit the shared modules that api.js reaches by DYNAMIC import.
 *
 * legacyBridge.ts loads the shared/*.js bridge with `?url`, which copies each
 * file but does not follow what it imports at runtime. api.js does
 * `await import('./profileService.js')` — a literal, sibling-relative path
 * Vite never sees, so nothing emits it and the request 404s.
 *
 * The failure is silent until the app first asks for a profile, and it
 * surfaces as a caught "Profile service failed, falling back to legacy" — with
 * an unhandled rejection that killed the coupon loop mid-run. The fixture
 * recorder stored 1 of 5 coupons because of it, which read as a delivery bug
 * in the gateway rather than a missing asset.
 *
 * Emitted with its exact name, next to api.js, because the specifier is
 * literal: a content-hashed name would not be found.
 */
function sharedDynamicImports(): Plugin {
  return {
    name: 'imani-shared-dynamic-imports',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/profileService.js',
        source: readFileSync(r('./shared/profileService.js'), 'utf8'),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), portalEdgeAuth(), sharedDynamicImports()],
  // Scoped to src/, because `packages/` now lives in this repo and ships its own
  // suites — dm-poll's and wallet-storage's among them, the latter wanting
  // `fake-indexeddb`, which is not a dependency here. Without this, `npm test`
  // goes red on tests this app does not own and did not break.
  //
  // Run a package's own suite from its own directory, as imani-apps did.
  //
  // `services/` is OURS, unlike `packages/`, so it is collected: the audit API
  // is code this repo authors and its suite is the only thing standing between
  // an auditor and a forged record auditing clean. It is listed explicitly
  // rather than by widening the glob, so a future vendored directory does not
  // get pulled in by accident.
  // `perf/` is ours too, and its helpers decide whether a performance run
  // fails. Untested, a bug there reports green while measuring nothing, which
  // is the one failure mode a performance suite cannot afford. Listed
  // explicitly for the same reason as `services/`.
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'services/**/*.test.{ts,tsx}',
      'perf/**/*.test.{ts,tsx}',
    ],
  },
  resolve: {
    // ONE React, or the production build renders a blank page.
    //
    // `@imani/nap-react` is aliased to source in ../nap, so its `import 'react'`
    // resolves against THAT repo's node_modules — react 19.2.4 there against
    // 19.2.3 here. Two instances means two hook dispatchers, and the one
    // nap-react calls is null while the other renders: the whole app dies on
    // `Cannot read properties of null (reading 'useState')` with an empty body
    // and a single console line.
    //
    // Dev never showed it — the dep optimizer collapses the duplicate — so this
    // only appears once the app is built, which is exactly when nobody is
    // looking for a resolution bug.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': r('./src'),

      // nap — auth
      '@imani/nap-core': nap('nap-core'),
      '@imani/nap-client-http': nap('nap-client-http'),
      '@imani/nap-client-web': nap('nap-client-web'),
      '@imani/nap-client-nip46': nap('nap-client-nip46'),
      '@imani/nap-react': nap('nap-react'),

      // imani-apps — wallet core. Order matters: nostr-vouchers must precede
      // any shorter prefix that could shadow it.
      '@imani/wallet-storage': imani('wallet-storage'),
      '@imani/nostr-vouchers': imani('nostr-vouchers'),
      '@imani/nostr-transactions': imani('nostr-transactions'),
      '@imani/wallet-balance': imani('wallet-balance'),
      '@imani/voucher-send': imani('voucher-send'),
      '@imani/profile-service': imani('profile-service'),
      // Avatar and banner uploads (BUD-01/02/05/11). Its only runtime dep is
      // @noble/hashes, already here via nap.
      '@imani/blossom-upload': imani('blossom-upload'),
      '@imani/gateway-client': imani('gateway-client'),
      '@imani/dm-poll': imani('dm-poll'),
      '@imani/money': imani('money'),
      // The money decisions the app and the future wallet API share (#4).
      '@imani/wallet-core': imani('wallet-core'),
      'imani-qr': imani('imani-qr'),
    },
  },
  server: { proxy },
  // `vite preview` serves the production bundle from dist/. It does not inherit
  // server.proxy, so without this a locally deployed build answers every /api
  // call with its own index.html.
  preview: { proxy },
})
