# A sale the gateway finishes after a crash

imani-gateway-customer#168, imani-wallet#178, imani-gateway-customer#183.

## The problem

A quote-backed coupon (one sold without enough float, so the gateway mints it behind a Lightning
top-up) is polled for its token by the Sell screen for 60 seconds. If gateway-customer crashes
mid-swap, its recovery job finishes the coupon about 5 minutes later. By then the screen has given
up, and before #168 nothing carried the token to the customer.

## What Sell does now

`issueAndDeliver` in `src/lib/issue.ts`, for each part that came back without a token:

1. `registerRecipient` sends `PUT /api/v1/wallet/vouchers/{id}/recipient` with the customer's hex
   key, before polling. It is abandoned after `REGISTER_TIMEOUT_MS` (5 s), so a gateway that never
   answers cannot stall the sale. It returns whether the gateway accepted the key; a failure is
   logged with `console.warn`, naming only the voucher prefix and the status.
2. `waitForToken` polls as before. When the poll runs out, its message depends on step 1:
   - **accepted:** the gateway knows the customer and sends the coupon by itself within a few
     minutes, so the merchant is told not to sell it again;
   - **not accepted** (an older gateway's 404, a timeout, a network error): the gateway will not
     send it, so the merchant is told to check the voucher in a few minutes and forward it.
3. `deliver` forwards the token with `POST /api/v1/dm/tokens/send`, naming the `voucher_id`. That
   forward is what the gateway records as the delivery. Its read of the token in step 2 is not:
   if the screen read the token and then failed to forward it, the gateway DMs it after a short
   grace.

## Duplicates are safe

The gateway's DM and the merchant's forward can both happen (a forward that lands after the
gateway's grace, or a crash between the gateway's send and its marker). Both carry the **same token
string**. `DmPollService` drops a token whose `sha256` fingerprint it has already received, the
voucher row is keyed by that fingerprint, `/wallet/receive` carries `Idempotency-Key:
rcv_<fingerprint>`, and the mint refuses a spent token. The customer is credited once.

## Reproducing it

`e2e/stack/crash-mid-sale.sh` with `e2e/probe-crash-mid-sale.mts`, on the local imani-test stack:

```sh
IMAGE=imani-gateway-customer:<tag> OUT=/tmp/crash-168 e2e/stack/crash-mid-sale.sh
```

`STACK_UP` defaults to `e2e/stack/up.sh` in this checkout. The script sells to a fresh customer
key, SIGKILLs gateway-customer right after the voucher swap (holding the sale's row locked so the
crash lands with the row still PENDING), restarts it, waits past the recovery grace, and counts the
gift wraps addressed to the customer on the relay.
