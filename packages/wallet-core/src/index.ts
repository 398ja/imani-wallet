/**
 * The wallet's money decisions, callable from anywhere.
 *
 * The app imports these; the future wallet API will import the same ones. That
 * is the point of the package: two callers that answer "what does this spend
 * cost" differently is a class of bug that cannot be tested away, and the only
 * fix is for there to be one answer.
 *
 * Everything here is a function of the coupons it is handed. No storage, no
 * network, no gateway, no DOM.
 */

export {
  minSplitStep,
  checkSplittable,
  selectVouchers,
  chooseSpend,
  planParts,
  splitObstacle,
  passedOver,
  issuerKey,
  type PassedOver,
  type PassedOverReason,
  type SplitCheck,
  type SendPart,
  type SendPlan,
  type SpendChoice,
} from './spend'

export {
  readExpiry,
  toEpochMs,
  toEpochSeconds,
  canonicalExpiresAt,
  type Expiry,
} from './expiry'

export {
  valueHolding,
  stallKey,
  type HoldingGroup,
  type HoldingValue,
  type UnusableCoupon,
  type UnusableReason,
} from './holding'

export {
  planSpend,
  eligibleCoupons,
  type SpendPlan,
  type PlanRequest,
  type PlanObstacle,
  type PlannedPart,
  type ObstacleKind,
} from './plan'

export {
  checkRecipient,
  needsRecipientLookup,
  type RecipientRole,
  type RecipientCheck,
  type SendVerdict,
  type SendRefusal,
} from './recipient'

export {
  INDIVIDUAL_MAX_OUTSTANDING,
  INDIVIDUAL_MAX_EXPIRED_UNRETURNED,
  BASE_RESTORE_GAP,
  DEFAULT_BUSINESS_MAX_OUTSTANDING,
  ABSOLUTE_MAX_OUTSTANDING,
  INDIVIDUAL_LIMITS,
  LinkLimitsConfigError,
  limitsFor,
  limitsForSender,
  linkAllowance,
  parseBusinessSenders,
  restoreGapFor,
  restoreScanEnd,
  expiredCapFor,
  type AccountType,
  type BusinessSenders,
  type LinkAllowance,
  type LinkCountsInput,
  type LinkLimits,
} from './linkLimits'
