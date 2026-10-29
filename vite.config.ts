// `vitest/config`, not `vite`: this file now carries a `test` block, and vite's
// own defineConfig does not type it.
import { createRequire } from 'node:module'

import { defineConfig } from 'vitest/config'
import type { Connect, Plugin, ViteDevServer, PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = createRequire(import.meta.url)('./package.json') as { version: string }
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { ClientRequest } from 'node:http'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Consume the @imani/* wallet packages straight from source: no build step, no
// npm link. Every one of them is plain framework-agnostic TS, so there is
// nothing React-specific to compile first.
//
// Because aliasing bypasses each package's own node_modules, their runtime deps
// (nostr-tools, qr-scanner, @gandlaf21/bc-ur, buffer) are installed here.
//
// `imani` now points INSIDE this repo. The 11 wallet packages were copied out of
// imani-apps and this repo owns them, which is what makes a Docker build
// possible at all: a build context rooted here could never see ../imani-apps.
//
// The five @imani/nap-* packages are NOT aliased. nap is a separate product with
// other consumers, and it is an ordinary versioned npm dependency: published as
// @398ja/nap-* (compiled ESM + .d.ts) and installed under its @imani/nap-* import
// names through npm aliases in package.json (#212). No ../nap sibling, no second
// Docker build context.
const imani = (name: string) => r(`./packages/${name}/src/index.ts`)

/**
 * The shared secret every edge-gated service trusts its edge proxy with.
 *
 * ONE value for all of them, which is not a shortcut: `nap_auth.lua` injects a
 * single `X-Edge-Auth` for every upstream it gates, so gateway-portal,
 * customer-wallet and merchant-service are all configured with the same secret
 * in every environment. A second constant here would be a way to drift out of
 * step with a deployment that cannot drift.
 *
 * Read here, in the Vite config, NOT through `import.meta.env` — anything with a
 * `VITE_` prefix is inlined into the client bundle, and this must never be. See
 * the `/api/v1/portal` proxy rule below for why the browser cannot hold it.
 *
 * Matches GATEWAY_PORTAL_EDGE_SHARED_SECRET in deploy/compose.override.yml and
 * MERCHANT_EDGE_SHARED_SECRET in imani-deploy's test stack.
 */
const EDGE_SHARED_SECRET = process.env.PORTAL_EDGE_SECRET ?? 'dev-edge-secret-local-only'

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
/**
 * Every prefix this dev server must authenticate the way a real edge does.
 *
 * Exported so `devProxy.test.ts` can hold this list against the proxy table.
 * That pairing IS the invariant that broke: a rule with the right target and no
 * edge hop looks complete and answers 401 with a valid session.
 *
 * TWO of them, and the second was added after `Connect to Stripe` answered 401
 * with a perfectly good session. The 401 was correct and the proxy was wrong:
 * `/api/v1/merchant/stripe` went STRAIGHT to merchant-service, skipping the
 * step that turns a session cookie into an identity. Every service behind this
 * proxy learns who you are from `X-Auth-Pubkey`, injected by the edge after it
 * validates the cookie; bypass the edge and you arrive anonymous, however valid
 * your session.
 *
 * That is why this is a list rather than a second copy of the middleware. The
 * portal rule had the whole mechanism and the merchant rule had none of it, and
 * nothing about the shape of the file said one was missing — the merchant rule
 * looked complete because it had a correct target. Adding a prefix here is now
 * the only thing an author has to remember.
 *
 * `/api/v1/merchant` covers both `/merchant/` and `/merchants/`? NO — and that
 * is deliberate. nginx routes `^/api/v1/merchants?(/|$)`, but the wallet only
 * ever calls the singular, and matching the plural here without a proxy rule
 * for it would authenticate a request that then falls into the `/api`
 * catch-all and reaches customer-wallet WITH edge headers attached. The list
 * stays exactly as wide as the routes it protects.
 */
export const EDGE_AUTH_PREFIXES = ['/api/v1/portal', '/api/v1/merchant/stripe'] as const

/**
 * The exact test Vite's proxy uses to pick a rule: a bare `startsWith` on the
 * RAW url.
 *
 * This is not a stylistic choice. Mounting the middleware with
 * `server.middlewares.use(prefix, …)` looks equivalent and is not:
 * Connect matches on the PARSED, case-insensitive pathname and demands a `/` or
 * `.` boundary, while the proxy matches the raw url with no boundary at all. Every
 * path where those two disagree is a request that reaches the proxy WITHOUT being
 * stripped — `/api/v1/portalfoo` is proxied but was never mounted — and the proxy
 * then attaches the shared secret to whatever `X-Auth-Pubkey` and
 * `X-Auth-Permissions` the page sent. No such route exists on the portal today, so
 * this was latent rather than live; it stops being latent the day someone adds one.
 * Sharing one predicate makes the two impossible to drift apart.
 */
const needsEdgeAuth = (url: string | undefined): boolean =>
  EDGE_AUTH_PREFIXES.some((prefix) => (url ?? '').startsWith(prefix))

const edgeAuth: Connect.NextHandleFunction = (req, _res, next) => {
  if (!needsEdgeAuth(req.url)) {
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
  // #160 phase 3: a terminal's Redeem asks gateway-core whether its payment request was paid
  // (`GET /api/v1/atomic/fulfilment/{id}`, NIP-98). Only that path, so atomic-purchase and voucher
  // inspect keep their existing dev routing. changeOrigin false for the same NIP-98 reason.
  '/api/v1/atomic/fulfilment': { target: 'http://localhost:28081', changeOrigin: false },
  // Account registration and runtime config also live on account-app. Without
  // these two they fall into the '/api' rule below and hit customer-wallet,
  // which 404s them — and a 404 on /api/v1/nip05 reads as "the endpoint does not
  // exist" rather than "it is on the other gateway".
  //
  // changeOrigin: false for /api/v1/nip05 for the atomic-send reason above: the
  // claim is NIP-98 authenticated, and the signed `u` tag is the browser origin.
  '/api/v1/nip05': { target: 'http://localhost:28081', changeOrigin: false },
  '/api/v1/config': { target: 'http://localhost:28081', changeOrigin: true },
  /*
   * Starting a card purchase, which lives on payment-adapter — a THIRD service,
   * neither gateway. Without this rule it falls into the '/api' catch-all, hits
   * customer-wallet, and 404s, which reads as "purchases are not implemented"
   * rather than "the proxy does not know where they live".
   *
   * Port 28087 is the LOCAL TEST stack, matching every other rule in this
   * table. It said 8087, which is what imani-deploy publishes payment-adapter
   * on in STAGING — a port with nothing behind it on a developer's machine, so
   * every checkout would fail with ECONNREFUSED against a service that was
   * running the whole time, two digits away.
   *
   * changeOrigin true: the endpoint is unauthenticated, so no signature depends
   * on the origin surviving.
   */
  '/api/v1/checkout': { target: 'http://localhost:28087', changeOrigin: true },
  /*
   * #410 G14: the Purchase Issuer's public seal key (`GET /api/v1/gifting/issuer-key`), on
   * payment-adapter. The wallet reads it to accept a bought gift's `imani_gift_sent` DM only from
   * that key. Without this rule it falls into the '/api' catch-all and the gift DMs wait forever.
   * Unauthenticated, public data.
   */
  '/api/v1/gifting': { target: 'http://localhost:28087', changeOrigin: true },
  /*
   * Card-sales enrolment and readiness (imani-wallet#298), on purchase-issuer. NOT in the local
   * compose stack: run it from this repo (`npx tsx services/purchase-issuer/server.ts`, default
   * port 8791, with PURCHASE_PUBLIC_ORIGIN=http://localhost:5173). With it down, readiness reads
   * as "not ready" and Buy is disabled, which is the fail-safe answer.
   *
   * changeOrigin false: the stall signs NIP-98 for the browser origin, and purchase-issuer
   * checks it against PURCHASE_PUBLIC_ORIGIN.
   */
  '/api/v1/card-sales': { target: 'http://localhost:8791', changeOrigin: false },
  /*
   * A stall's own Stripe account, on merchant-service.
   *
   * Without a rule this falls into the '/api' catch-all and reaches
   * gateway-portal, which answers 403 with an empty body for
   * `/api/v1/merchant/*` — a refusal that reads like a permissions problem
   * rather than a misrouted request. See the note in `src/lib/merchant.ts`.
   *
   * 28088, and getting here took two wrong answers. It said 8086, the staging
   * publish port, which is nothing locally. The obvious correction — 28086, the
   * same number in the local range — is WORSE than the original: on the test
   * stack that port is BOTTIN-API, so the wallet would have reached a live,
   * healthy, completely unrelated service. A connection refused is a bad
   * afternoon; a 404 from the wrong service is a bug hunt in the wrong repo.
   *
   * A THIRD wrong answer followed, and it is the reason for the `configure`
   * block below: with the port finally right, `Connect to Stripe` answered 401.
   * Correct, and nothing to do with Stripe. merchant-service identifies a
   * merchant from `X-Auth-Pubkey`, which only the edge sets, and this rule went
   * straight to the service — so a valid session arrived anonymous. Pointing at
   * the right service is not the same as arriving there authenticated, and the
   * shape of the rule made it look finished.
   *
   * The `edgeAuth` middleware above has already validated the session cookie
   * against account-app and set the headers; this attaches the secret that
   * vouches for them, exactly as the portal rule does. merchant-service now
   * demands it — it used to trust `X-Auth-Pubkey` from anyone, which is how a
   * missing edge hop stayed invisible for so long.
   *
   * changeOrigin false: these are session-authenticated, and the cookie is
   * scoped to the browser origin.
   */
  '/api/v1/merchant/stripe': {
    target: 'http://localhost:28088',
    changeOrigin: false,
    configure: (proxy: {
      on(event: 'proxyReq', cb: (req: ClientRequest) => void): void
    }) => {
      proxy.on('proxyReq', (proxyReq) => {
        // Same fail-closed shape as the portal rule: vouch only for a pubkey
        // the middleware actually validated, and strip a permissions header
        // that could only have come from the page otherwise.
        if (proxyReq.getHeader('x-auth-pubkey')) {
          proxyReq.setHeader('X-Edge-Auth', EDGE_SHARED_SECRET)
        } else {
          proxyReq.removeHeader('x-auth-permissions')
        }
      })
    },
  },
  // Receipt notifications live on account-app as well: IncomingNotificationController
  // is in gateway-core-rest, not customer-wallet. Without this rule the drain and
  // ack calls fall into the '/api' catch-all, hit customer-wallet, and 404 every
  // few seconds forever — the polling loop retries, so the console fills with
  // "drain: request failed status=404" while nothing is actually wrong with the
  // endpoint. account-app answers 401 for the same request, which is the endpoint
  // existing and wanting a session.
  //
  // changeOrigin: false for the NIP-98 reason above.
  '/api/v1/incoming-notifications': { target: 'http://localhost:28081', changeOrigin: false },
  // Payment receipts are on account-app too, for the third time in this file:
  // PaymentReceiptController is gateway-core-rest, not customer-wallet.
  //
  // The failure is the same one the comment above describes and is worth
  // restating because it has now cost three separate debugging sessions: the
  // drain loop polls every ten seconds, so a missing rule does not fail once,
  // it 404s forever while the endpoint itself is perfectly healthy. The
  // observed symptom was a settlement notification that never arrived, three
  // tiers away from the line that was missing.
  //
  // changeOrigin: false for the NIP-98 reason above — the signed `u` tag is
  // the browser origin, and rewriting the Host invalidates every signature.
  '/api/v1/payment-receipts': { target: 'http://localhost:28081', changeOrigin: false },
  /*
   * Web Push subscription management, on gateway-core.
   *
   * Same trap as the line above, found the same way: without a rule this falls
   * into the '/api' catch-all, reaches customer-wallet, and 404s. That 404 is
   * indistinguishable from "this deployment has no push support", so the wallet
   * reads it as "no VAPID key" and the settings screen reports that
   * notifications are not switched on for this server — with the server sitting
   * right there, correctly configured, answering 200 on 28081.
   *
   * changeOrigin: false for the NIP-98 reason above: the subscribe, preferences
   * and delete calls are signed over the URL, and rewriting the Host makes the
   * signature cover an origin the server never saw.
   */
  '/api/v1/push': { target: 'http://localhost:28081', changeOrigin: false },
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
          proxyReq.setHeader('X-Edge-Auth', EDGE_SHARED_SECRET)
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
  // The version, reachable at runtime.
  //
  // Without this the number in package.json is a number in a file: the wallet
  // deploys as `:latest`, so a container in staging could not be traced back to
  // the code inside it. Baked in at build time so a support conversation can
  // start from what is actually running rather than what someone believes was
  // deployed.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    // Per-environment settings are fixed for the suite rather than read from this machine's
    // `.env.local` (a developer's local-stack values would change what the tests see). The gifting
    // site reads its handle domain and wallet origin at module load, so they are set here rather
    // than with `vi.stubEnv`.
    env: {
      VITE_GIFTING_HANDLE_DOMAIN: 'imani.casa',
      VITE_WALLET_ORIGIN: 'https://wallet.example.test',
    },
    // Each package under packages/ ships its OWN vitest.config.ts, and eleven
    // of them were never run by `npm test`. The include globs below only reach
    // `packages/**/src/`, while most of those suites live in `tests/` or
    // `test/` — 106 files and ~1900 tests, invisible here. dm-poll is the
    // sharpest case: DmPollService.test.ts sits beside the service it covers
    // and never executed, so a test added there would have read as passing
    // while running nothing at all. That is how this was found.
    //
    // They are wired in as PROJECTS rather than by widening the globs because
    // the globs alone are not enough: these suites declare their own
    // environment and setupFiles (fake-indexeddb for the IDB-backed ones), and
    // pulling the files into this config without them fails 70 tests on
    // "indexedDB is not defined" — a config problem wearing the costume of a
    // broken test. As projects, each package keeps the config it was written
    // against, and this file keeps owning the app's own suite.
    projects: [
      // The app itself: this config's own include list, below.
      './vite.config.ts',
      // `.mts` as well as `.ts`: blossom-upload and wallet-storage ship dual
      // CJS/ESM builds and so cannot carry `"type": "module"` without breaking
      // their `require` consumers, which made node load their config as
      // CommonJS and abort the whole run with ERR_REQUIRE_ESM. Renaming just
      // those two configs to `.mts` forces ESM for the config alone and leaves
      // each package's published shape untouched.
      './packages/*/vitest.config.{ts,mts}',
    ],
    include: [
      'src/**/*.test.{ts,tsx}',
      'services/**/*.test.{ts,tsx}',
      // The gifting site (#410), and the subscription site (#407) once it lands: their own pages and
      // libraries, tested against the wallet's real modules.
      'apps/**/src/**/*.test.{ts,tsx}',
      'perf/**/*.test.{ts,tsx}',
      // `deploy/` ships the container's nginx.conf, and its CSP is application
      // behaviour, not decoration: `worker-src 'self'` there silently disabled
      // every QR scan in the app. Tested here so a header change is a failing
      // test rather than a camera that runs and decodes nothing.
      'deploy/**/*.test.{ts,tsx}',
      // `packages/` was ABSENT, and five test files across wallet-core,
      // dm-poll and money had never run in this suite — 171 tests, green when
      // invoked directly and invisible to `npm test`. Found while adding
      // @imani/licence, whose whole design argument is that a package boundary
      // makes it testable; a boundary whose tests nobody runs is worse than no
      // boundary, because it reads as covered.
      //
      // wallet-core is the sharpest case: it exists so the app and the wallet
      // API cannot disagree about money, and its own tests were outside the
      // run that would have caught them disagreeing.
      'packages/**/src/**/*.test.{ts,tsx}',
    ],
  },
  resolve: {
    // ONE React, or the production build renders a blank page.
    //
    // `@imani/nap-react` declares react as a peer dependency, so npm resolves its
    // `import 'react'` to this app's copy and there is only one. This used to be
    // load-bearing: while nap-react was aliased to source in ../nap, its react
    // resolved against THAT repo's node_modules (19.2.4 against 19.2.3 here). Two
    // instances means two hook dispatchers, and the one nap-react calls is null
    // while the other renders: the whole app dies on `Cannot read properties of
    // null (reading 'useState')` with an empty body and a single console line.
    //
    // Dev never showed it — the dep optimizer collapses the duplicate — so this
    // only appears once the app is built. Kept as a guard: it costs nothing, and
    // a future dependency that bundles its own react would bring the blank page
    // straight back.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': r('./src'),
      // How apps/* import the wallet's modules (apps/gifting/vite.config.ts aliases it the same).
      '@wallet': r('./src'),

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
      '@imani/licence': imani('licence'),
      '@imani/merchant-record': imani('merchant-record'),
      '@imani/redemption': imani('redemption'),
      '@imani/reports': imani('reports'),
      '@imani/payment-requests': imani('payment-requests'),
      'imani-qr': imani('imani-qr'),
    },
  },
  server: { proxy },
  // `vite preview` serves the production bundle from dist/. It does not inherit
  // server.proxy, so without this a locally deployed build answers every /api
  // call with its own index.html.
  preview: { proxy },
})
