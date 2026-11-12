/**
 * Words shared by every surface that tells a multi-coupon payment as one (#94):
 * the recipient's arrival and advance notices and the sender's claim row.
 *
 * Kept in one dependency-free place so the three say the same thing, and so
 * the notification loops that use them do not have to import the bundle
 * tracker (and the aggregation package behind it) to get a plural right.
 */

/**
 * "1 voucher", "2 vouchers".
 *
 * "Voucher", CONTEXT.md's own word for what the customer holds (#94 chose it first, and the
 * glossary now agrees; "coupon" names the checkout code). One payment described in two
 * vocabularies would read as two things. Callers pass a count of VOUCHERS, not of stored rows
 * or proofs (voucherCount.ts).
 */
export const vouchers = (n: number) => `${n} voucher${n === 1 ? '' : 's'}`

/**
 * Appended when parts of one payment disagreed: another total or count,
 * another sender or currency, or a second delivery for a part already counted.
 * The figure shown is still only what actually arrived; this says the
 * declaration behind it cannot be taken at face value.
 */
export const MISMATCH_NOTE = 'Some parts of this payment did not match the others.'
