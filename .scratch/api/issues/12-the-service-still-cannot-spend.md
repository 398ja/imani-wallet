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

**Status:** todo

- [ ] The service imports nothing that can sign a Nostr event or spend a proof.
- [ ] The check runs in CI and in the image build, not only locally.
- [ ] It names the offending import when it fails, rather than reporting a diff.
- [ ] Adding a signing import to any endpoint fails it — verified by doing so, not by assuming.
- [ ] The README states the property and points at the check that enforces it.
