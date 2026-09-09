# 12: The service still cannot spend

**What to build:** A test that fails if the wallet API ever gains a code path
capable of signing or spending, run over the whole service rather than any one
endpoint.

ADR 0002 records this as the property that makes a public spending API
defensible at all: "the service has no code path capable of spending". Eleven
tickets above add endpoints that talk to gateways, forward signatures, and handle
tokens. Any one of them could quietly import a signer for a good local reason,
and no endpoint's own tests would fail.

The Dockerfile already asserts a narrower version of this — it fails the build if
`@imani/wallet-core` gains a runtime import of `@imani/voucher-send` — so the
approach is established and this generalises it.

This ticket is last to write and first to matter. It is the one that stays true
after everyone has forgotten why it was there.

**Blocked by:** None, and better landed EARLY so later tickets are constrained by it

**Status:** done

- [x] The service INVOKES nothing that signs or spends. *(Reworded: see below. The original said "imports nothing", which is unsatisfiable.)*
- [x] The check runs with the suite and in the image build.
- [x] It names the offending file and call when it fails, rather than reporting a diff.
- [x] Adding a signing call fails it — verified by planting one, in both the test and the image build.
- [x] The README states the property and points at the checks that enforce it.

## What it took

**The ticket as written was unsatisfiable, and finding that out was the point of
doing it first.** "The service imports nothing that can sign" cannot hold:
`nip98.ts` imports `schnorr` to VERIFY the caller's signature, and the same
object exposes `.sign`. The service cannot authenticate anyone without it.

So the boundary is the OPERATION, not the module. `schnorr.verify` is the whole
job; `schnorr.sign` would end ADR 0002's argument. The criterion is reworded and
the reasoning is in the test, because the next person will reach for the import
check too.

A second thing the ticket assumed wrongly: it treated this as new work. **The
image build already enforced it**, more thoroughly than the ticket asked —
across every executable extension, plus a separate guard for the SEALING path,
because a NIP-17 send can be wrapped without ever calling `finalizeEvent`. Its
comments record two real escapes it has already caught, including `sign.mjs`
walking past a `*.ts`-only scan. The genuinely missing pieces were the suite-level
check and the README.

"Runs in CI" was dropped rather than faked: there is no general CI workflow in
this repo, only `perf.yml`. The test runs under `npm test` and the guard runs in
the image build, which is what actually exists.

## Evidence

6 tests. Two are controls rather than assertions about the service: one plants a
`finalizeEvent(...)` string and requires exactly one pattern to fire, so a typo
in every regex cannot look like a pass; the other feeds prose mentioning
`finalizeEvent` and `schnorr.sign(` and requires NO match, because this file and
the README both discuss those names and a check that flagged them would be
switched off within a week.

One asserts the service still VERIFIES signatures — without it, the suite would
also pass if the API stopped authenticating callers altogether.

Mutation controls, both run rather than argued:
- planting `finalizeEvent(template, sk)` in `prepare.ts` fails the test, naming
  `prepare.ts: finalizeEvent — signs and seals a Nostr event`
- planting the same in `holding.ts` fails the IMAGE BUILD with
  `FAIL: signing capability reachable in wallet-api image`

Both files restored byte-identical.

A third finding, from the test failing on its first run: `stallLookup.ts`
value-imports `nostr-tools/pool`. Checked rather than assumed — that subpath
exports `SimplePool`, `AbstractSimplePool` and `useWebSocketImplementation` and
nothing that signs. The assertion now allows relay plumbing by name and still
refuses a value import of the nostr-tools root, which does export
`finalizeEvent` and `generateSecretKey`.
