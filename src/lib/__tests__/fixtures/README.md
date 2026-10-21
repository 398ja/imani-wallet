# Test fixtures

Most files here are real tokens and payloads captured from a running stack.
Never hand-build a replacement. A test that needs a synthetic token should build
it with a helper (for example `voucherFixtures.ts`), so it is plainly synthetic.

## Captured voucher arms

| File | Kind | Captured by | Read by |
|---|---|---|---|
| `witness-positive.token` | `P2PK_VOUCHER`, issuer signature verifies | `e2e/probe-witness-positive.mts` | receiveToken, receiveSwap, trustedMintGate, canonicalNumericTags |
| `witness-test.token` | `P2PK_VOUCHER` | `e2e/probe-witness.mts` (locked arm) | canonicalNumericTags, trustedMint (unit survey) |
| `control-unlocked.token` | `VOUCHER` (unlocked control) | `e2e/probe-witness.mts` (unlocked arm) | receiveToken, trustedMint |

The `.json` sidecars record the stall, device key, role and name the minting
script sent. `scripts/mint-terminal-credential.mjs` writes them beside the token.

All three were minted on 2026-09-07 against the local dev stack (mint
`http://127.0.0.1.mint:7777`, stall `b1787b2b…`, issuer key `6a02bb64…`, keyset
`00e3372e61d05605`). They are 1-sat dev-mint proofs with no spendable value.
`witness-positive` was swapped by its own probe. `witness-test` is locked to a
throwaway device key whose secret was discarded. `control-unlocked` was swapped
by the probe's control arm.

Until fix/main-test-baseline these files were gitignored, because the probes
overwrote them on every run. The tests still read them, so a fresh clone (and
every worktree, and any CI that ran `npm test`) failed 30 tests in 5 files with
`ENOENT`. Only checkouts that had once run the probes passed. The probes now
write to the gitignored `probe-out/`, and these captures are tracked.

The tests depend on properties of these specific tokens. `trustedMintGate`
needs an issuer signature that verifies under the current verifier, and
`canonicalNumericTags` needs canonical numeric tags. So don't swap in a token
from another stack without re-running the tests.

## Regenerating

Do this only when a test legitimately needs a new token, for example after a
change to the signed canonical bytes. It needs the local stack (gateway, mint,
and wallet-api on `WALLET_URL`, default `http://localhost:28082`) and the
`.seed-keys.json` that `scripts/seed-merchant.mjs` writes.

```sh
npx tsx e2e/probe-witness.mts           # -> probe-out/witness-test.token, probe-out/control-unlocked.token
npx tsx e2e/probe-witness-positive.mts  # -> probe-out/witness-positive.token
```

Both probes must PASS. A token from a failed probe may lack the property the
tests rely on. Then promote the arms and re-run the suite:

```sh
cp src/lib/__tests__/fixtures/probe-out/{witness-positive,witness-test,control-unlocked}.{token,json} \
   src/lib/__tests__/fixtures/
npm test
```

Commit each token together with its `.json` sidecar. The arms are spent by then,
which is fine: the unit tests only parse them and never present them to a mint.
