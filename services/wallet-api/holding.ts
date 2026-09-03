/**
 * Reading a holding off the wire.
 *
 * Coupons arrive as JSON in a request body, from a program the service has
 * never met. Everything here exists to turn that into either a holding the
 * money logic can be trusted with, or a refusal that names the field at fault.
 *
 * ## Why the errors name a field
 *
 * A caller assembling a request for the first time gets it wrong in a specific
 * way: a face value as a string, a missing unit, a coupon that is `null`
 * because a map returned nothing. "Invalid request" makes each of those an
 * afternoon of bisecting a payload. `coupons[3].face_value` makes it a minute.
 *
 * ## Why this is not a schema library
 *
 * The service has three runtime dependencies and its whole safety argument
 * rests on a small, readable surface. A validator dependency would be more code
 * than the validation, and the shape being checked is one object with eight
 * fields.
 */

/** A refusal, pointing at exactly what to fix. */
export interface FieldError {
  /** Dotted path to the offending field, e.g. `coupons[2].face_value`. */
  field: string
  /** What is wrong, in the terms of the caller's own request. */
  detail: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: FieldError }

/**
 * The coupon fields this service reads.
 *
 * Deliberately narrower than the wallet's `Voucher`. A caller's coupon carries
 * plenty this endpoint never touches — memos, mint URLs, provenance — and
 * demanding them would refuse valid holdings. Unknown fields are passed through
 * untouched rather than stripped, because the caller owns this state and the
 * service is not entitled to edit it.
 */
const REQUIRED_STRING = ['token'] as const
const REQUIRED_NUMBER = ['face_value'] as const

/**
 * One coupon, checked.
 *
 * `index` is threaded through only to build the field path, which is the
 * difference between an error a caller can act on and one they cannot.
 */
function parseCoupon(raw: unknown, index: number): Parsed<Record<string, unknown>> {
  const at = (field: string) => `coupons[${index}].${field}`

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        field: `coupons[${index}]`,
        detail: `expected an object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}`,
      },
    }
  }

  const coupon = raw as Record<string, unknown>

  for (const field of REQUIRED_STRING) {
    const value = coupon[field]
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        error: {
          field: at(field),
          detail:
            value === undefined
              ? 'is required'
              : `expected a non-empty string, got ${describe(value)}`,
        },
      }
    }
  }

  for (const field of REQUIRED_NUMBER) {
    const value = coupon[field]
    // `typeof NaN === 'number'`, and a NaN face value would flow through every
    // sum and turn a whole group's total into NaN — a balance that is not
    // wrong so much as meaningless. Refused at the door instead.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ok: false,
        error: {
          field: at(field),
          detail:
            value === undefined
              ? 'is required'
              : `expected a finite number, got ${describe(value)}`,
        },
      }
    }
  }

  // Optional, but wrong-typed is still wrong: a string face_unit is expected, a
  // numeric one means the caller built the object from the wrong source and
  // would otherwise get a group called "42".
  for (const field of ['face_unit', 'issuer_id', 'status', 'voucher_id'] as const) {
    const value = coupon[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return {
        ok: false,
        error: { field: at(field), detail: `expected a string, got ${describe(value)}` },
      }
    }
  }

  for (const field of ['face_decimals', 'token_amount'] as const) {
    const value = coupon[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      return {
        ok: false,
        error: { field: at(field), detail: `expected a finite number, got ${describe(value)}` },
      }
    }
  }

  // `expires_at` is deliberately NOT type-checked to string, however it is
  // declared. The redemption path writes it as a number, in seconds or
  // milliseconds, and `toEpochMs` is the wallet's one answer to that mess.
  // Refusing a numeric expiry here would refuse coupons the wallet itself wrote.
  const expiry = coupon.expires_at
  if (expiry !== undefined && expiry !== null && typeof expiry !== 'string' && typeof expiry !== 'number') {
    return {
      ok: false,
      error: {
        field: at('expires_at'),
        detail: `expected a string or a number, got ${describe(expiry)}`,
      },
    }
  }

  return { ok: true, value: coupon }
}

/**
 * The holding in a request body.
 *
 * An empty holding is VALID and answers with an empty result. A caller whose
 * customer has spent everything is in a normal state, not an error one, and a
 * 400 there would make "you have nothing" indistinguishable from "your request
 * was wrong".
 */
export function parseHolding(body: unknown): Parsed<Record<string, unknown>[]> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        field: 'body',
        detail: `expected a JSON object with a "coupons" array, got ${describe(body)}`,
      },
    }
  }

  const coupons = (body as Record<string, unknown>).coupons
  if (coupons === undefined) {
    return { ok: false, error: { field: 'coupons', detail: 'is required' } }
  }
  if (!Array.isArray(coupons)) {
    return {
      ok: false,
      error: { field: 'coupons', detail: `expected an array, got ${describe(coupons)}` },
    }
  }

  const parsed: Record<string, unknown>[] = []
  for (let i = 0; i < coupons.length; i++) {
    const result = parseCoupon(coupons[i], i)
    // The FIRST error, not all of them. A caller fixing a systematic mistake —
    // every face value stringified — would otherwise get one error per coupon,
    // and a 500-coupon holding answers with a wall of the same sentence.
    if (!result.ok) return result
    parsed.push(result.value)
  }

  return { ok: true, value: parsed }
}

/** What a value is, in words a caller can match against their own payload. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`
  return `a ${typeof value}`
}
