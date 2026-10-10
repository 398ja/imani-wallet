/**
 * The signed fields a licence is read from.
 *
 * A structural subset of the app's `SignedVoucherFields`, declared here rather
 * than imported so this package stays free of the app — which is the whole
 * reason it is a package. The app's type is wider and assignable to this, so
 * every existing call site typechecks unchanged.
 */
export interface SignedVoucherFields {
  issuerPublicKey: string
  issuerSignature: string
  expiresAt?: number
  faceValue: number
  unit: string
  merchantMetadata?: string | null
  /** The NUT-11 key in `data`, on a `P2PK_VOUCHER` only. */
  lockKey?: string
  /** The signed `issuer` tag: who sold it. */
  issuerId?: string
}
