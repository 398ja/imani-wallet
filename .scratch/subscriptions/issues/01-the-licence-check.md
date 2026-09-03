# 01: Verify a licence, offline

**What to build:** The check itself, as a pure function in `packages/licence/`: given
a voucher, the key that presented it, and a clock, say which features it confers
or why it confers none.

Four things and nothing else. The request is signed by the key the voucher is
locked to; our issuer signature verifies; the expiry is in the future; the grant
names the features. No network, no store, no DOM — which is why it is a package
rather than another module in `src/lib`.

This ticket ships no screen and gates nothing. It exists because every later
ticket depends on the answer being trustworthy, and a verifier is far easier to
test adversarially on its own than through a feature that happens to use it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A voucher signed by anyone but us grants nothing, however well-formed it is
      and however generous the grant inside it claims to be.
- [ ] A voucher presented by a key other than the one it is locked to grants
      nothing. Tested adversarially: a valid voucher plus a wrong key must fail.
- [ ] An expired voucher grants nothing, decided from the signed expiry and a
      local clock alone.
- [ ] The module reads a clock it is given rather than the wall clock, so expiry
      boundaries are testable without waiting.
- [ ] Nothing in the package imports from `src/lib`, and the package builds and
      tests on its own.
