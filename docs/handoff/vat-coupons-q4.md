# Handoff: VAT treatment of Imani coupons at online checkout (#402, Q4)

**For:** a UK/EU VAT adviser, or whoever briefs one.
**From:** the Imani team, 2026-10-30.
**Decision needed:** are Imani stall coupons **single-purpose vouchers (SPVs)** or **multi-purpose
vouchers (MPVs)**? And so, when a customer uses one at an online checkout, should it be applied
**after VAT, as a payment**, or **before VAT, as a discount**?

**Current default (shipped):** after VAT, as a payment, with a store setting for "before VAT,
as a discount", off. This is the cautious choice. Nothing is blocked on the answer, but the
merchant guide tells stalls to "ask your accountant" until we have one.

## 1. What an Imani coupon is

- **Issued by one business (a "stall")**, in that stall's name, and redeemable **only at that
  stall**: in person at its till (a phone), or at its online shop. It is refused at any other
  stall, and at any shop in a different currency.
- **A fixed money value in one currency** (GBP on staging; EUR, GBP and others are supported). It
  is not tied to a product. The customer can spend it on anything the stall sells, in part, and
  spend the rest later.
- **The stall decides what it sells.** Imani does not know the stall's VAT rates, its product mix,
  or whether it is VAT-registered. A bakery may sell zero-rated bread and standard-rated hot food
  from the same coupon.
- **Coupons can be passed on.** A customer can gift a coupon to another person (gift links), and
  can combine several coupons from the same stall into one checkout code.
- **Expiry:** each coupon shows its expiry date, or "No expiry" (imani-wallet #419).
- **Technically** a coupon is a signed digital bearer token. That matters for fraud, not for VAT.

## 2. How coupons are sold

- **By the stall, at its till**, for cash or in exchange for something, or
- **By card, online**, through Stripe. These are **direct charges on the stall's own connected
  Stripe account**: the stall is the merchant of record and receives the money. Imani takes an
  **application fee** on each sale. Imani never holds the customer's money
  (payment-adapter `StripeSdkCheckoutClient`).
- **Promotional coupons** (cashback, free gifts) may be issued for no consideration.

So the issuer, and the seller of the coupon, is the **stall**. Imani is a software provider that
charges the stall a fee.

## 3. What happens at an online checkout (#402)

1. The customer makes a **checkout code** in the wallet (e.g. IMANI-XXXX-XXXX-XXXX) from one or
   more of their coupons for that stall, and types it at the stall's own online shop
   (WooCommerce, WordPress, or Magento).
2. The shop plugin deducts the code's value from the order:
   - **default:** as a **payment after VAT**, shown as an "Imani coupon" line, like a gift card;
   - **optional store setting:** as a **discount before VAT**, which lowers the taxable amount.
3. If the code is worth more than the order, the difference goes back to the customer as a new
   coupon.
4. Refunds of the order are recorded, but the coupon value is not automatically re-issued.

## 4. Why it matters (our current understanding, to be confirmed)

Since 1 January 2019 (EU Vouchers Directive 2016/1065, mirrored in UK law):

- An **SPV** is a voucher where, *at issue*, both the place of supply and the VAT due on the
  goods or services it buys are known. VAT is due **when the voucher is sold**. Using it later is
  not a new taxable supply for the part it pays.
- An **MPV** is anything else. **No VAT** when it is sold; VAT is due **when it is used**, on what
  is bought.

What each checkout treatment does, as we understand it:

| | After VAT, as a payment (default) | Before VAT, as a discount (setting) |
|---|---|---|
| **MPV** | VAT on the full order. **Correct.** | VAT on the order minus the coupon. **Under-declares.** |
| **SPV** | VAT on the full order, though VAT on the coupon's part was already paid when it was sold. **Over-declares** (VAT twice). | VAT on the order minus the coupon, already taxed at sale. **Roughly correct.** |

So the default can over-declare but never under-declares, which is why we chose it.

**Note for the adviser:** #402's own text gives a different reason for the default. It says
treating an SPV as a discount would "lower the taxable base a second time". By the table above,
that looks backwards: for an SPV, the discount treatment seems to be the right one. Please confirm
which is right, because it decides what the store setting should say.

Our working assumption is that most Imani coupons are **MPVs**: their value can be spent on goods
at different VAT rates, and the rate isn't known when the coupon is sold. But a stall that sells
only one VAT rate (for example, only standard-rated services) could be issuing **SPVs**, and for
those stalls the default overcharges VAT.

## 5. Questions for the adviser

1. **Classification:** for a stall-issued, fixed-value coupon redeemable on anything that stall
   sells, is it an SPV or an MPV in the **UK**? In the **EU** (Ireland, Germany, France as
   examples)? Does it depend on the stall's product mix?
2. **One rate only:** if a stall sells only one VAT rate, does that make its coupons SPVs? Must
   the coupon itself say so, or is the stall's product mix at issue enough?
3. **Default:** is "after VAT, as a payment" correct for MPVs? For SPVs, is "before VAT, as a
   discount" the right treatment, so VAT on the coupon's part is not charged twice?
4. **Free coupons:** for promotional coupons given for nothing (cashback, gifts), is there any VAT
   at issue, and how should their use at checkout be shown?
5. **Change:** when a code is worth more than the order and the difference comes back as a new
   coupon, is that new coupon a new voucher for VAT, or the unused part of the old one?
6. **Gifting:** does a customer passing a coupon to someone else change anything (an SPV is taxed
   on each transfer *for consideration*; gifts are free)?
7. **Imani's fee:** we assume Imani's application fee to the stall is a separate supply of a
   service by Imani to the stall, unconnected to the voucher's VAT. Is that right?
8. **Unused coupons:** for MPVs never used, is anything due by the stall? (For SPVs, VAT paid at
   sale is not reversed.)
9. **Partial use and refunds:** any rule for an order paid partly by coupon and later refunded?

## 6. What we will do with the answer

- **The code:** if the answer is "MPV, payment after VAT", nothing changes. If some stalls issue
  SPVs, the shop setting gets a clearer name and help text, or the stall chooses a VAT type when
  it sets up its coupons. The setting already exists in the WooCommerce and Magento plugins.
- **The merchant guide:** replace the "VAT: payment, not discount (open question)" section in
  imani-docs `wallet/merchants.md` with the adviser's answer.
- **The issue:** close Q4 on imani-wallet #402.

## 7. Where things are

- **Issue:** 398ja/imani-wallet#402, "Deducting the amount" and Q4. All the PRs are listed in the
  issue comments.
- **Merchant guide text:** imani-docs `wallet/merchants.md`, "VAT: payment, not discount (open
  question)", in PR 398ja/imani-docs#3.
- **WooCommerce:** imani-checkout-woo, the `woocommerce_calculated_total` hook; the "discount
  mode" setting, off by default (PR 398ja/imani-checkout-woo#1).
- **Magento:** imani-checkout-magento, `Model/Total/Quote/ImaniCode`, a total after tax
  (PR 398ja/imani-checkout-magento#1).
- **Card sales:** payment-adapter `StripeSdkCheckoutClient`: direct charge plus application fee.

## 8. Not covered here

- Whether Imani itself must register for VAT, or how it charges VAT on its own fee.
- Non-EU, non-UK regimes (e.g. XAF/XOF markets).
- Accounting entries in a stall's books.
