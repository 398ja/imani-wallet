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
  planParts,
  splitObstacle,
  toEpochMs,
  type SplitCheck,
  type SendPart,
  type SendPlan,
} from './spend'

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
