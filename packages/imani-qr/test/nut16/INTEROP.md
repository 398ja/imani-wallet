# NUT-16 Interop Hand-Test Procedure

This is a manual procedure for verifying that Imani's NUT-16 encode and decode interop with third-party Cashu wallets that implement [NUT-16](https://github.com/cashubtc/nuts/blob/main/16.md). The Playwright + vitest test suites cover round-trip correctness within our own implementation; this document captures the cross-wallet verification that proves the bytes-on-the-wire match the published spec.

Both interop directions should be tested before declaring spec 028 SC-003 and SC-004 satisfied.

## Pre-flight

- Two Android phones (or one Android + one iOS for the Cashu.me Safari fallback). The launch-market baseline is a low-end Android — ideally test on a Tecno or Itel-class device for SC-002 confidence too, but a recent Android is enough for SC-003/SC-004.
- Minibits installed on the Android (https://minibits.cash — Google Play or sideload).
- Optional: Cashu.me open in a desktop browser as a second reference wallet (https://cashu.me).
- The Imani wallet built and deployed somewhere both phones can reach (staging is fine).
- A small balance in both Minibits and Imani — a few hundred sats / launch-currency-equivalent is enough.

## Direction 1 — Minibits → Imani (SC-003)

**Goal**: Confirm an Imani user can be paid in person by a Minibits user, even when only Minibits has connectivity at the moment of handoff.

1. On the **Minibits phone**: Send → Cashu Token → choose an amount with enough proofs to force animation (try 200+ sats with mixed denominations).
2. Choose "Show as QR." Minibits will show an animated multi-frame UR sequence.
3. On the **Imani phone**: open the wallet and navigate to the scanner.
4. Hold the Imani phone steady ~15 cm from the Minibits screen. Watch the scan-progress indicator on the Imani UI tick up frame-by-frame.
5. **Expected**: the voucher is received into the Imani wallet within a few seconds (the BC-UR fountain decoder usually completes in 1–2x the natural frame count). Balance reflects the inbound voucher; transaction history shows the receipt.
6. **Document** in `interop-screenshots/`: a screenshot of the Minibits QR sequence and the Imani receive confirmation.

If the Imani scanner never completes:
- Try larger QR size on Minibits (some Minibits versions let you adjust frame density).
- Try slower frame rate.
- Check `scanner.onNut16Event` console output for `fragment-ignored` or `reconstruction-error` events — those identify whether fragments are arriving at all and whether CRC is failing.

## Direction 2 — Imani → Minibits (SC-004)

**Goal**: Confirm a Minibits user can be paid by an Imani user — exercises Imani's encoder against a reference scanner.

This requires a host page that drives Imani's encoder. The simplest version: a temporary `voucher/dev/nut16-encode.html` test page that calls `encode(cashuBToken, { forceAnimated: true })` and renders the iterator's frames into a canvas via `lib/qrcode.min.js`. (Not yet shipped — opportunity for a quick PR.)

1. On the **Imani phone**: open the encoder test page; paste a cashuB token (use one from your own wallet via `Send → Copy token to clipboard` or similar).
2. Confirm an animated QR sequence appears on screen.
3. On the **Minibits phone**: open the scanner.
4. Scan the Imani-encoded animated QR.
5. **Expected**: Minibits identifies the QR as a Cashu token and either (a) directly credits the wallet, or (b) presents a "Claim token" confirmation that succeeds when tapped.
6. **Document** in `interop-screenshots/`: the Imani encoded sequence and Minibits's receipt confirmation.

If Minibits doesn't reconstruct:
- Check Minibits's NUT-16 version — older releases may not implement it.
- Try smaller `maxFragmentLength` (50–80 bytes) on Imani's encoder for older Minibits builds that prefer denser per-frame data.
- As a fallback, also test against Cashu.me on a desktop browser — its `cashu.me` web app implements NUT-16 too.

## Recording the result

After running both directions, append to this file:

```markdown
## Run log

### YYYY-MM-DD — Tested by <name>

- **Direction 1 (Minibits → Imani)**: <PASS|FAIL> — <notes>
- **Direction 2 (Imani → Minibits)**: <PASS|FAIL> — <notes>
- **Minibits version**: <x.y.z>
- **Imani branch / image**: <branch-name or docker tag>
- **Screenshots**: `interop-screenshots/<date>-direction1.png`, `interop-screenshots/<date>-direction2.png`
```

A PASS in both directions satisfies spec 028 SC-003 and SC-004.

## Known interop notes

- **Minibits before v0.x.x** (TBD — fill in once we test) emitted NUT-16 sequences with `maxFragmentLength` ~ 200, which produces larger but fewer-fragment QRs. The Imani decoder handles either density correctly.
- **Cashu.me** uses the same `@gandlaf21/bc-ur` library on its end, so encode/decode interop with it is effectively a self-test of the underlying BC-UR layer; nonetheless worth running because the higher-layer wallet code differs.
- **Camera quality matters** for the frame rate the receiver can sustain. Low-end Android cameras typically cap out around 10–15 fps usable for QR scanning, so the encoder's default 200 ms (5 fps) gives 2–3 chances per frame for a reliable lock. Faster cadence on the encoder side can speed up successful scans on better cameras, but breaks low-end ones.
