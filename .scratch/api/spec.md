# Spec: The rest of the API

**Source:** [the coverage assessment](../api-coverage/ASSESSMENT.md),
[ADR 0001](../../docs/adr/0001-caller-holds-the-key.md),
[ADR 0002](../../docs/adr/0002-the-api-plans-the-caller-signs.md)

## Problem Statement

The wallet API is five endpoints and they serve one journey: a customer spending
coupons. That is the README's own story — "a script that pays a supplier every
Friday" — and it is complete for it.

The app is twenty-nine screens. Everything a *stall* does is missing: issuing a
coupon, redeeming one, asking for payment, cashback, terminals, subscriptions.
So is receiving, which means a program can spend a holding but cannot notice
money arriving. A bookkeeping tool, named in the README's opening line as a
thing this API is for, can currently read a balance and nothing else.

The consequence is not that integrators are inconvenienced. It is that the only
way to automate a stall is to drive the browser, and a merchant who wants their
till talking to their EPOS has no supported path at all.

## Solution

Extend the API to cover every operation the UI can perform, except the ones that
are device-local by nature.

Nothing here weakens the property that makes a public spending API defensible:
the service holds no key, holds no coupons between requests, and has no code
path capable of spending. Every endpoint below is one of four shapes, three of
which the service already runs:

- **Plan** — compute and return a decision. Nothing moves.
- **Prepare** — return an *unsigned* event the caller signs and publishes.
- **Courier** — return the exact bytes to sign for a third party, then forward
  the caller's signature verbatim. The service cannot forge it.
- **Attest** — the caller supplies state it already holds, and the service
  computes a verdict over it. New, and needed because several rules are
  enforced against local device history the service cannot see.

## User Stories

1. As an integrator, I want to redeem a coupon a customer presents, so that a till system can take payment without driving a browser.
2. As an integrator, I want to be told a coupon is already spent before I hand over goods, so that I do not give value away for nothing.
3. As an integrator, I want the double-redemption ceiling enforced, so that the same coupon cannot be presented until it exceeds what was issued.
4. As an integrator, I want to issue a coupon, so that a stall can sell programmatically.
5. As an integrator, I want to know a coupon was issued but not delivered, so that I can retry delivery rather than lose it.
6. As an integrator, I want to ask a customer for a payment, so that an EPOS can display a request.
7. As an integrator, I want to match an arriving payment to the request that asked for it, so that I can reconcile without guessing.
8. As an integrator, I want to notice money arriving, so that a bookkeeping tool can do the job its name implies.
9. As an integrator, I want to read my own transactions and totals, so that I can produce accounts.
10. As an integrator, I want to generate and claim cashback, so that a loyalty flow is not browser-only.
11. As an integrator, I want to enrol and revoke terminals, so that a fleet of tills can be managed from a management system.
12. As an integrator, I want to check my subscription, so that my automation can tell whether a feature is available before it tries.
13. As an integrator, I want every endpoint to work with a key and nothing else, so that no browser session, cookie, or shared secret is required.
14. As an integrator, I want to be told which coupons a plan would spend before anything moves, so that I can refuse and keep the holding whole.
15. As a stall owner, I want an API caller to be bounded by the same rules as my own device, so that automating my till does not weaken it.
16. As a security reviewer, I want the API to remain incapable of spending, so that a breach of it is a denial of service and not a theft.

## Implementation Decisions

**Issuance couriers through `/api/v1/wallet/vouchers`, not the portal.** Proven,
not assumed: an unregistered keypair signing NIP-98 for itself mints a verified
token through the wallet path (HTTP 201), and the same signer gets **500** on
`/api/v1/portal/vouchers`, which the UI uses. The portal path is authorised by a
session cookie validated against account-app, with a shared secret the browser
never sees, so no headless caller can satisfy it. An implementer following
`src/lib/issue.ts` would walk straight into that.

**The caller owns the issuance poll.** Minting returns `PENDING` behind a bolt11
top-up and only later carries a token — about two seconds observed, but it is a
payment. The API returns a `voucher_id` rather than holding a connection open.
A held connection is a timeout waiting to happen, and the caller has to persist
the id anyway to be crash-safe.

**The redemption ceiling is computed over caller-supplied rows.** It is the only
check that sees *across* redemptions, and today it sums local transaction rows
deliberately, so a merchant with no signal can still enforce their own ceiling.
A stateless service has none. The caller sends what it holds and the service
returns the verdict — with the README stating plainly that the ceiling is only
as good as what was sent.

**The bound itself is never caller-supplied.** `signedFaceValue` comes from the
verified voucher. A ceiling the caller chose is not a ceiling.

**The ceiling arithmetic must be extracted, and pinned.** `checkRedemption`
calls `listTransactions()` itself and reaches IndexedDB through `wallet.ts`, so
it cannot be called from a stateless service at all. Extracting it creates the
risk that matters: a copy that drifts leaves a till and an API enforcing
different ceilings on the same voucher, each internally consistent, neither
failing a test. A parity test against the app's own implementation is therefore
part of the ticket rather than a follow-up.

**Redemption and receipt cannot be separated.** `refuseIfOverRedeemed` enforces
the same ceiling on the receive path in `dmPoll`. An API covering one and not
the other would enforce it in one place only.

**Reads are POST.** The holding *is* the request, and coupons in a URL land in
access logs and proxy caches. A logged bearer coupon is a spendable one. This
follows `/v1/holding/value`, which already made this trade.

**Four operations are on services this stack does not run.** Signed requests to
`/api/v1/portal/cashback/generate`, `/api/v1/register`, and the incoming
notification drain and ack all answer **404** on gateway-customer; they belong
to the portal (28084, not running) and account-app (28081). Their tickets are
sequenced last and start by locating the service, because a ticket that assumes
an endpoint exists is a ticket that stalls on its first day.

**Every endpoint is exercised by a probe against live services.** The two
riskiest shapes were validated this way before being written down, and one of
them was corrected by it. A ticket that ships only unit tests has not
established that its endpoint works.

## Testing Decisions

The prior art is `services/wallet-api/__tests__/server.test.ts` and the probes
in `e2e/`. The division between them is the point: unit tests assert the
decision, probes assert that the real service, reached over HTTP with a real
signature, actually does it.

Every ticket carries both. Specifically:

- **A signed-request probe** against the running service, since auth precedes
  routing and a 401 cannot distinguish a real route from an imaginary one. This
  is how the current inventory was verified, and it is the only check that
  proves an endpoint exists.
- **A negative that is adversarial rather than confirmatory**, because the
  failures here are security holes and not defects. Two deserve naming: the
  service must not become able to spend, and a caller must not be able to widen
  its own authority by what it sends.

Mutation controls where a check could pass vacuously. The redemption parity test
is the clearest case: it must fail when the app's `direction === 'in'` filter is
removed, or it is only asserting that two functions agree about nothing.

## Out of Scope

- **Backup, restore, and security.** They handle key material. An endpoint that
  emits or ingests it undoes ADR 0001 outright.
- **Settings, profile editing, onboarding, welcome, scan.** Presentation and
  device state; `scan` is a camera.
- **Login and logout.** There is no session to create. Identity *is* the key.
- **Owner-side terminal revocation reaching the mint.** A real gap, proven, and
  a product decision rather than an API one — see the assessment. Ticket 11
  exposes what revocation does today and says so, rather than pretending.
- **A second implementation of any rule.** Where logic exists in `src/lib`, the
  endpoint calls it or the logic moves to a package both share.

## Further Notes

**The stall is the unit of authority, not the terminal.** Every endpoint here
authenticates a key, and a stall's key is what the gateway recognises. Whether a
terminal's own credential should authorise API calls — so an integrator can act
as a till rather than as the stall — is a real question and deliberately not
answered here. It would need the terminal work finished first.

**The receive path is the one gap that changes what the API is for.** Spending
without receiving is half a wallet. It is sequenced third rather than first only
because its server side has to be found before it can be wrapped.
