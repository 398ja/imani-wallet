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
- **No VAT is charged when a coupon is sold.** Card sales send no tax rate and do not turn on
  Stripe Tax (only Imani's own subscription checkout does, in `services/subscription/stripe.ts`).
  Till sales record an amount, with no VAT line. The coupon's price is its face value.
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

**The bigger gap, if any coupon is an SPV.** An SPV's VAT is due when the coupon is **sold**, and
as §2 says, nothing charges or records VAT at that point today. So for an SPV-issuing stall, the
error is upstream of checkout: VAT is missing at the sale, and no checkout setting can put it
back. Fixing that would mean recording a VAT rate when a coupon is sold, at the till and in the
card checkout. That is a larger change than the plugin setting, and the main reason the
classification matters.

**Note for the adviser:** #402's own text gives a different reason for the default. It says
treating an SPV as a discount would "lower the taxable base a second time". By the table above,
that looks backwards: for an SPV, the discount treatment seems to be the right one. Please confirm
which is right, because it decides what the store setting should say.

Our working assumption is that most Imani coupons are **MPVs**: their value can be spent on goods
at different VAT rates, and the rate isn't known when the coupon is sold. A stall that sells only
one VAT rate *might* issue SPVs, but one rate is not enough on its own: the SPV test also needs
the **place of supply** to be known at issue. A stall that ships cross-border, or whose coupon can
be used both in person and in its online shop, may fail that test even at one rate.

## 4a. Facts that decide the classification

These are the facts the adviser will need for a given stall. Most are per stall, not per Imani:

| Fact | Why it matters (SPV test: both known at issue) | What Imani knows today |
|---|---|---|
| VAT rates of what the coupon can buy | the VAT due | Nothing. The stall decides what it sells. |
| Where the stall supplies from and to (cross-border shipping, EU customers) | the place of supply | Nothing. |
| Used in person, online, or both | place of supply can differ between the two | Both, for any stall with an online shop. |
| Sold, or given away (promotions, cashback) | whether there is consideration at issue | Both happen. |
| Passed on to someone else (gift links), free or for money | SPVs are taxed on each transfer **for consideration** | Gift links are free; Imani sees no resale. |
| Whether the stall is VAT-registered | whether any of this applies | Nothing. |

## 4b. What public sources say (search "mpv vs spv VAT", 2026-10-30)

Gathered for the adviser to check, not relied on. The sources broadly agree with section 4, and
add four points that bear on Imani:

- **A double charge is a known failure.** One summary warns that "double taxation can occur if
  an SPV is mis-identified as an MPV" and taxed again at redemption (vatupdate.com, May 2026).
  That is exactly the risk in the default for an SPV-issuing stall (section 4 table).
- **Partial use differs by type.** For a partly used SPV, the remaining value stays VAT-inclusive.
  For an MPV, the taxable amount is the relevant share of what the voucher's buyer paid
  (Mitchell Charlesworth). This bears on Q5 (change): the change coupon is the unused part of a
  voucher, and its VAT treatment follows from the type.
- **Expiry differs by type.** VAT on an SPV is paid at issue and not reversed if it expires; an MPV
  that expires never gives rise to VAT (Moore Belgium; NaviPartner). This is Q8.
- **Free vouchers, in one country.** The Dutch tax authority's view, as reported, is that free
  SPVs and MPVs also fall under the voucher rules in some cases (input VAT recovered on the goods,
  and a value over EUR 15) (MPR accountants). That is one EU state's view only, but it shows Q4
  is a real question. National rules on free vouchers may differ.
- **Cross-border use makes an MPV.** A chain whose gift card works in stores in several EU
  countries issues MPVs, because the place of supply is not known at issue (MPR accountants).
  Same logic as the place-of-supply point in section 4.
- **Case law on transfers.** The ECJ (Finanzamt, C-68/23) confirmed that an SPV transferred
  between several parties before use is taxed on each transfer (Crowe UK). For Imani, transfers
  are free gift links, so this matters only if coupons are ever resold.

Useful decision rule from the same summary, for the adviser to confirm: if every possible use has
the same VAT outcome in one jurisdiction, it is an SPV; otherwise an MPV.

## 4c. Initial analysis received (2026-10-30, unverified)

The owner obtained a written analysis answering section 5, citing VATA 1994 Sch 10B, HMRC VAT
information sheet 09/18, Directive 2016/1065 (Art 30a/30b), the French BOFiP, Irish Revenue TDM
Part 05 and the CJEU in C-68/23. **It is not from a qualified adviser and is not relied on.** It is
recorded here because it sharpens the questions, and three of its points change our plan. The
adviser should confirm or correct each line.

| Q | What it says |
|---|---|
| 1 | It turns on the stall's **VAT-liability mix**, not its range of goods. One category (all standard, all zero, or all exempt) **and** a fixed place of supply means SPV; mixed rates mean MPV. IE, DE and FR apply the same test. |
| 2 | One rate is necessary, not sufficient. A coupon usable in person and online, or at a shop that ships abroad, is normally an MPV. **But** under C-68/23 classification follows the **conditions of use**: if the terms restrict use to one country, customers getting round it do not undo SPV status. Nothing has to say "SPV", but the terms must identify the supplier (the stall), and for an MPV state the face value. |
| 3 | Both treatments are right in effect. **MPV:** the coupon is a VAT-inclusive payment (a £50 coupon plus £20 cash on £70 of goods means VAT on £70). **SPV:** redemption is **not a supply**, so the coupon is left out at checkout, not because it is a discount. |
| 4 | No VAT when given away. **Issued free by the stall itself:** HMRC treats it as a discount, so nil value if nothing else is paid. **Bought by someone else and given away** (employer, Imani, a promoter): face value still applies on use. The statute's fallback (face value) and HMRC's guidance (discount) disagree, and it has not been tested in court. |
| 4b | An SPV sale needs VAT captured at the till, and a VAT invoice for VAT-registered business buyers. A consumer receipt with a VAT line is not strictly required. Ordinary gift-card accounting (VAT on redemption) gets SPVs wrong. |
| 5 | Change issued as a new coupon is a new voucher worth the unused value. **If it is narrower in scope than the original** it could become an SPV and trigger VAT when issued. |
| 6 | Free transfers change nothing for MPVs, and carry no VAT for SPVs. A *business* giving coupons away may hit business-gift rules. |
| 7 | Imani's fee is a separate supply to the stall (Sch 10B para 10). Caveat: **if Imani ever took the customer's money and paid the stall**, it would be in the voucher chain itself. |
| 8 | An unused MPV owes nothing; an SPV's VAT is not reversed. |
| 9 | Partial use is valued proportionally. Refund cash as cash and the coupon part as a coupon, or the records stop matching. |

**What this changes for Imani:**

- **UK scope: transferability.** In the UK a voucher must be **transferable by gift** to be inside
  the voucher rules at all; the Directive has no such condition. Imani coupons **are** transferable
  (gift links), so they are vouchers in the UK and the EU alike. Keep it that way: a
  "non-transferable" coupon would fall outside Sch 10B in the UK only, and need different logic.
- **Change must mirror the original (Q5).** The checkout's change coupon is issued by the same
  stall, redeemable on anything that stall sells, like the original. Today it is the same scope by
  construction. A rule for the code: never issue change narrower than what it replaces.
- **Free coupons split by who funds them (Q4).** Stall cashback and stall gifts are the stall's own
  free coupons (the "discount" case). A coupon **bought by someone else** and given away (a gift
  bought by card, a business buying coupons for staff) is the face-value case. The wallet can tell
  these apart, and the merchant guide should explain the difference.
- **Imani never holds the money (Q7).** The card checkout is a direct charge to the stall's own
  Stripe account plus a separate fee (section 2), which is the structure this analysis says keeps
  Imani out of the voucher chain. Keep it so, and keep the fee separate from any coupon flow.
- **The SPV sale gap stands (section 4).** The analysis agrees that an SPV's VAT is due at sale,
  and that ordinary gift-card accounting gets it wrong. That is exactly what Imani does today.

**Questions this narrows for the adviser:** (1) confirm the liability-mix test and the C-68/23
reading, so a stall can pin its coupons to one country in its terms; (2) how to treat a stall with
mixed rates that wants SPVs (it can't, on this reading); (3) the free-coupon gap, and whether to
seek a non-statutory clearance from HMRC; (4) whether a coupon bought by a gift-giver and used by
someone else is the face-value case.

## 5. Questions for the adviser

1. **Classification:** for a stall-issued, fixed-value coupon redeemable on anything that stall
   sells, is it an SPV or an MPV in the **UK**? In the **EU** (Ireland, Germany, France as
   examples)? Does it depend on the stall's product mix?
2. **One rate only:** if a stall sells only one VAT rate, does that make its coupons SPVs? How
   does the place-of-supply limb apply to a coupon usable both in person and online, or at a
   shop that ships to other countries? Must the coupon itself say what it is for?
3. **Default:** is "after VAT, as a payment" correct for MPVs? For SPVs, is "before VAT, as a
   discount" the right treatment, so VAT on the coupon's part is not charged twice?
4. **Free coupons:** for promotional coupons given for nothing (cashback, gifts), is there any VAT
   at issue? When one is used, is the value of the supply nil, or the coupon's face value? HMRC's
   guidance takes the MPV value as "the amount last paid for the voucher or, in the absence of
   this information, its face value", which does not clearly cover a coupon nobody paid for.
4b. **The sale itself:** if some stalls issue SPVs, what must be recorded when the coupon is sold
   (at the till and by card), and is a receipt with a VAT line required?
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
  SPVs, two things change. First, the sale: record a VAT rate when such a coupon is sold, at the
  till and in the card checkout, which nothing does today. Second, the checkout: the shop setting
  gets a clearer name and help text, or the stall chooses a VAT type when it sets up its coupons.
  The setting already exists in the WooCommerce and Magento plugins.
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
- **Card sales:** payment-adapter `StripeSdkCheckoutClient`: direct charge plus application fee,
  no tax rate and no Stripe Tax.
- **Sources checked:** HMRC, "VAT: treatment of vouchers from 1 January 2019" (GOV.UK);
  Directive (EU) 2016/1065 (EUR-Lex); a public web search, summarised in section 4b, with each
  source named there. Our summary of them is a starting point, not advice.

## 8. Not covered here

- Whether Imani itself must register for VAT, or how it charges VAT on its own fee.
- Non-EU, non-UK regimes (e.g. XAF/XOF markets).
- Accounting entries in a stall's books.
