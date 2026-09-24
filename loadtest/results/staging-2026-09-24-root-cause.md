# Root cause: a 10% fee floored to zero on small vouchers

Traced 2026-09-24 with host access to staging, following the dashboard review
that filed six issues. **All three payment-path issues have one cause.**

## The answer to "why would we send zero amounts for payment?"

Because nobody decided to. The amount is *computed*, and for small vouchers it
computes to zero:

```
chargedPrice = floor(faceValue * feePercentage / 100)
```

With `feePercentage = 10.0` on staging:

| faceValue | chargedPrice | |
|---|---|---|
| 1 sat | **0** | zero invoice |
| 5 sat | **0** | zero invoice |
| 9 sat | **0** | zero invoice |
| 10 sat | 1 | |
| 6736 sat | 673 | works, and 28 of these succeeded |

**Every voucher under 10 sats is charged nothing.** The threshold is exactly
`100 / feePercentage`.

`VoucherFeeCalculator`'s own Javadoc states the case without flagging it as a
problem:

> `1 sat @ 50% = 0 sats (floor of 0.5)`

Floor rounding is deliberate and correct in intent, described as avoiding
overcharging on fractional amounts. What is missing is a floor of **one**: a
charge of zero is not a discount, it is the absence of a payment.

## The chain, verified end to end

1. **`VoucherMintQuoteTask`** computes `voucherPrice = calculateFee(faceValue, 10.0)`
   and calls `gateway.createMintQuote((int) voucherPrice, null)` with **0**.
   Nothing validates that the price is positive.
2. **`persistVoucherQuote`** stores `charged_amount = 0` in `voucher_quote`.
   It fails closed on a DB error but has no opinion about a zero charge.
3. **`PhoenixdGateway.createMintQuote`** requests a zero-amount invoice.
   Verified directly against the mock: `amountSat=0` in, `amountSat=0` out.
   The mock is behaving correctly; it echoes what it is asked for.
4. The **`quote` row** is stored with `amount = 0`. Confirmed on staging:

   ```
   quote_id                             | amount | state | created_at
   783d7ef5-85ad-41c4-b2dc-9d5b975f5f1d |      0 | PAID  | 2026-09-23 22:05:01
   8e5b7e29-0db6-401e-9fc0-75a2b3f8e5bb |      0 | PAID  | 2026-09-23 22:05:00
   ... 9 rows total, all amount=0, all PAID, none forwarded
   ```

5. The payment **settles anyway** (a zero invoice is trivially payable), so the
   quote goes `PAID` and the adapter tries to tell the mint.
6. **`QuoteStatusUpdater`** refuses it at the first gate:

   ```java
   if (notification.getAmount() == null || notification.getAmount() <= 0) {
       log.warn("webhook_event invalid_amount ... amount={}", ...);
       incrementCounter(Outcome.amount_mismatch);
       return WebhookOutcome.of(Outcome.amount_mismatch);
   }
   ```

   This is right: *"a webhook with a missing or non-positive amount can never
   legitimately match an authorised quote"*. The mint is the only component in
   the chain that notices.

7. **`PaidQuoteForwardReconciler`** retries forever. `MintWebhookForwardRetrier`
   reconstructs the notification from `quote.getAmount()`, which is still 0, so
   every redelivery is refused identically.

That last step is why **2430 rejections at midnight became 9664 by morning**
from only **9 stranded quotes**. The count is retries, not new damage.

## What this explains, and corrects

| Issue | Filed as | Now |
|---|---|---|
| Webhook flood | `cashu-mint#468` | Symptom. The label is also wrong: these are `invalid_amount` (zero), not an amount that disagrees with the quote |
| 9 unforwarded payments | `payment-adapter#246` | The 9 zero-amount quotes, exactly |
| Paid-unissued climbing | `cashu-mint#469` | Partly this; the steps before 09-23 need their own account |

**`#468`'s headline was wrong.** I read `outcome=amount_mismatch` and inferred a
unit or scale disagreement between adapter and mint. The real case is a zero
that never should have been invoiced, filed under the same enum value because
`QuoteStatusUpdater` reuses `amount_mismatch` for "non-positive amount".

That conflation is worth fixing on its own: `WebhookEvent.Outcome` has eleven
values and none of them is `invalid_amount`, so the one condition the mint can
diagnose precisely is recorded as the one it cannot.

## My load runs caused it

Not a coincidence worth hiding: the 9 zero-amount quotes were created at
22:04-22:05 on 09-23, during the `market-day.js` runs, and the probes in
`staging-2026-09-24-swap-latency.md` issued **1-sat** vouchers deliberately to
keep the test cheap.

So the trigger was mine. The defect was not: a 1-sat voucher is a legitimate
request that the system accepted, invoiced for nothing, took payment for, and
then refused to honour. A real customer buying a small coupon would hit exactly
this.

It is also the reason the bug survived until now. Real traffic uses realistic
face values, and 6736 sats charges 673 and works fine.

## Fixes, in the order I would apply them

1. **Floor the charge at 1 sat** in `VoucherFeeCalculator`, or reject the quote
   outright when the computed price is zero. A voucher that cannot be charged
   for should fail at quote creation, where the client can see it, rather than
   three services downstream.
2. **Validate at the boundary.** `VoucherMintQuoteTask` should refuse to call
   `createMintQuote` with a non-positive amount. `PhoenixdGateway` should refuse
   to create a zero-amount invoice. Either check would have stopped this.
3. **Give the reconciler a poison-message path.** A quote whose amount is
   structurally unacceptable will never deliver, and retrying it forever buries
   every other signal. Cap the attempts and mark it `undeliverable`.
4. **Split `invalid_amount` from `amount_mismatch`** in `WebhookEvent.Outcome`,
   so the metric names the condition.
5. **Clean up the 9 stranded quotes** on staging once the fix lands, otherwise
   the retry loop continues against rows that can never succeed.

## Not this cause

`imani-gateway-portal#44` (every portal write 500s) and
`imani-gateway-customer#104` (concurrent issuance races on backing proofs) are
unaffected by the above and remain open on their own evidence.
