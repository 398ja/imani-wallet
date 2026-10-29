# `@imani/cashlink-sender`

Send Cashlinks from a server: an employer's payroll run, a loyalty job,
anything that gives coupons to people by link without a person at a phone
(#366). It does what the wallet app does when someone taps **Send as a link**,
with the same engine (`src/lib/cashlinkFlow.ts`), and the same rules:

- **Your key stays with you.** The sender key lives in this process. Every
  link's key and its refund key are derived from it and an index, so nothing
  secret is ever written down, and wallet-api never sees a key (ADR 0001/0002).
- **Gifts come back on their own.** A coupon on a link is locked to that link
  with your refund key and the expiry `x`. The take-back is signed ahead and
  left at the gateway's refund relay, which posts it after `x` if nobody
  claimed the gift. Your next run picks the coupon up, re-formed and unlocked.
- **Limits by account type.** 10 open links for an individual. A business
  sender listed by the deployment gets the deployment's limit (default 500).
  Restore scans far enough for the limit.

## Use

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { createCashlinkSender, emptyState, type SenderState } from '@imani/cashlink-sender'

const sender = createCashlinkSender({
  secretKey,                                   // 32 bytes, from your secret store
  gatewayUrl: process.env.IMANI_GATEWAY_URL!,  // the customer gateway
  publicOrigin: process.env.IMANI_GATEWAY_ORIGIN, // the origin it binds NIP-98 to, when different
  mintUrl: process.env.IMANI_MINT_URL!,        // the mint your coupons name
  walletOrigin: process.env.IMANI_WALLET_ORIGIN!, // where recipients open links
  walletApiUrl: process.env.IMANI_WALLET_API_URL, // for your limits; without it, 10
  keep: async (coupon) => saveCoupon(coupon),  // every coupon that comes back: persist before returning
})

const state: SenderState = await readFile('links.json', 'utf8').then(JSON.parse, () => emptyState(sender.pubkey))

const x = Math.floor(Date.now() / 1000) + 14 * 86_400   // claim within 14 days
const { url, link, returnsOnItsOwn } = await sender.send(state, coupon, x, 'employee-0042')
await writeFile('links.json', JSON.stringify(state))     // after EVERY send
await emailTheLink(url)                                    // the url IS the gift: never log it

// A cron, every few minutes:
await sender.reconcile(state)
await writeFile('links.json', JSON.stringify(state))
```

There are no per-environment defaults: every URL comes from your
configuration.

### What you call

| call | does |
|---|---|
| `send(state, coupon, x, ref?)` | Puts one whole coupon on a new link that expires at `x` (unix seconds, 1 hour to 30 days away, and at least a day before the coupon itself expires). Returns the link `url` and the link record. Refuses before anything moves when the coupon is not usable or the limit is reached. |
| `reconcile(state)` | One pass over every open link: finishes an interrupted send, retries a take-back deposit, marks claims, and after `x` brings unclaimed coupons back to `keep`. Safe to run as often as you like. |
| `takeBack(state, i)` | Takes one link back now, before `x`. The coupon goes to `keep`, and whoever opens the link finds nothing. |
| `restore(state)` | Rebuilds a lost state file from the key alone: scans the derived links, adopts every one still holding a gift with its exact `x`, and skips claimed and returned ones. |
| `limits()` / `counts(state)` | Your limits (from wallet-api `GET /v1/links/limits`) and how many links count against them. |

For a batch, ask wallet-api `POST /v1/links/plan` first: it checks every coupon
(whether its link can come back on its own, and why not) and your allowance,
counted from the mint. See the [wallet-api README](../../services/wallet-api/README.md#sending-cashlinks-from-a-server-366).

### The state file

`SenderState` is public data: link indices, expiries, statuses, the coupon on
each link and your `ref`. No link key, no refund key and no URL, so it can sit
in an ordinary database. Two rules:

- **Persist it after every `send`.** The index is reserved before the coupon
  moves, so a crash after the coupon left is still found by `reconcile`.
- **One state per key.** A state from another key is refused (`wrong_state`).

If it is lost, `restore` rebuilds it. A gift sent as a plain bearer coupon
(below) has no recorded `x` on the link, so a restored one is taken back on
the next `reconcile`.

### Link status

| `status` | means |
|---|---|
| `armed` | On its link, locked, and the take-back is waiting at the relay. Comes back on its own after `x`. |
| `not_armed` | On its link and locked, but the relay did not take the take-back. `reconcile` retries before `x`, and takes it back itself after `x`. |
| `unarmed` | On its link as a plain bearer coupon (`why` says why it could not be locked: `no_amount_proof`, `relay_unavailable`, `lock_route_unavailable`, …). `reconcile` takes it back after `x`. |
| `arming` / `returning` | Part way through. `reconcile` finishes it. |
| `claimed` | The recipient has it. |
| `returned` | It came back to `keep`. |

### Errors

`send` throws `CashlinkSenderError` with a `code`, always **before anything
moves**:

`bad_coupon`, `wrong_mint`, `unverified`, `own_stall` (a stall's Cashlinks of
its own coupons lapse and never come back to it), `window`,
`too_many_outstanding`, `too_many_expired`, `limits_unavailable`,
`unreachable`, `no_free_link`, `bad_origin`, `wrong_state`.

## Testing

- `npx vitest run sdk/` runs the unit tests against the rule-based fake mint
  and gateway the app's Cashlink tests use.
- `e2e/cashlink-sender-local.e2e.mts` runs the whole flow against the local
  stack (real gateway, mint and refund relay): send, claim with the app's own
  claim path, take back, restore, and limits. Its header lists what it needs.
