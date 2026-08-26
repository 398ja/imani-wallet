/**
 * SelectionOptimizer
 *
 * Optimizes voucher selection for payments.
 * Implements various selection strategies.
 */

import type {
  SelectableVoucher,
  SelectionRequest,
  SelectionResult,
  ConsolidationCheck,
} from '../types/selection';

/**
 * Check if a voucher is active
 */
function isActive(voucher: SelectableVoucher): boolean {
  return voucher.status === 'active';
}

/**
 * Check if a voucher is expired
 */
function isExpired(voucher: SelectableVoucher): boolean {
  if (!voucher.expiresAt) {
    return false;
  }
  try {
    const expiryDate = new Date(voucher.expiresAt);
    return expiryDate.getTime() < Date.now();
  } catch {
    return false;
  }
}

/**
 * Get days until expiry
 */
function daysUntilExpiry(voucher: SelectableVoucher): number | null {
  if (!voucher.expiresAt) {
    return null;
  }
  try {
    const expiryDate = new Date(voucher.expiresAt);
    const now = Date.now();
    const diffMs = expiryDate.getTime() - now;
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  } catch {
    return null;
  }
}

/**
 * Filter vouchers for a currency
 */
function filterForCurrency(
  vouchers: SelectableVoucher[],
  currency: string,
  excludeIds: string[] = []
): SelectableVoucher[] {
  const excludeSet = new Set(excludeIds);
  return vouchers.filter((v) => {
    if (!isActive(v)) return false;
    if (isExpired(v)) return false;
    if (excludeSet.has(v.id)) return false;
    if (v.faceUnit?.toUpperCase() !== currency.toUpperCase()) return false;
    if ((v.faceValue ?? 0) <= 0) return false;
    return true;
  });
}

/**
 * Check if two vouchers can be consolidated
 */
function canConsolidatePair(a: SelectableVoucher, b: SelectableVoucher): boolean {
  // Must be same issuer
  if (a.issuerId !== b.issuerId) return false;

  // Must be same currency
  if (a.faceUnit?.toUpperCase() !== b.faceUnit?.toUpperCase()) return false;

  // Must have same expiry (or both no expiry)
  if (a.expiresAt !== b.expiresAt) return false;

  return true;
}

/**
 * Selection optimization utilities
 */
export class SelectionOptimizer {
  /**
   * Select vouchers to cover target amount
   */
  static selectForAmount(
    vouchers: SelectableVoucher[],
    request: SelectionRequest
  ): SelectionResult {
    const { amount, currency, preferredIssuerId, excludeVoucherIds = [], strategy = 'prefer-single' } = request;

    // Filter available vouchers
    let available = filterForCurrency(vouchers, currency, excludeVoucherIds);

    // Prefer specific issuer if requested
    if (preferredIssuerId) {
      const preferred = available.filter((v) => v.issuerId === preferredIssuerId);
      const others = available.filter((v) => v.issuerId !== preferredIssuerId);
      available = [...preferred, ...others];
    }

    if (available.length === 0) {
      return {
        vouchers: [],
        totalAmount: 0,
        changeAmount: 0,
        needsConsolidation: false,
        sufficient: false,
        shortfall: amount,
      };
    }

    // Try strategies in order of preference
    let result: SelectionResult;

    switch (strategy) {
      case 'prefer-single':
        result = this.preferSingle(available, amount) ?? this.greedySelect(available, amount);
        break;
      case 'minimize-count':
        result = this.preferSingle(available, amount) ?? this.greedySelect(available, amount);
        break;
      case 'minimize-change':
        result = this.minimizeChange(available, amount);
        break;
      case 'use-expiring-first':
        result = this.preferExpiring(available, amount, request.expiringWithinDays ?? 7);
        break;
      default:
        result = this.preferSingle(available, amount) ?? this.greedySelect(available, amount);
    }

    // Add consolidation groups if needed
    if (result.needsConsolidation) {
      result.consolidationGroups = this.groupForConsolidation(result.vouchers);
    }

    return result;
  }

  /**
   * Find single voucher that covers amount (exact or minimal overage)
   */
  static findExactOrMinimalOverage(
    vouchers: SelectableVoucher[],
    amount: number,
    currency: string
  ): SelectableVoucher | null {
    const available = filterForCurrency(vouchers, currency);

    // Sort by face value ascending
    const sorted = [...available].sort((a, b) => a.faceValue - b.faceValue);

    // Find first voucher that covers the amount
    for (const voucher of sorted) {
      if (voucher.faceValue >= amount) {
        return voucher;
      }
    }

    return null;
  }

  /**
   * Prefer single voucher strategy
   */
  private static preferSingle(
    available: SelectableVoucher[],
    amount: number
  ): SelectionResult | null {
    // Sort by face value ascending to find minimal overage
    const sorted = [...available].sort((a, b) => a.faceValue - b.faceValue);

    // Find first voucher that covers the amount
    for (const voucher of sorted) {
      if (voucher.faceValue >= amount) {
        return {
          vouchers: [voucher],
          totalAmount: voucher.faceValue,
          changeAmount: voucher.faceValue - amount,
          needsConsolidation: false,
          sufficient: true,
          shortfall: 0,
        };
      }
    }

    // No single voucher covers the amount
    return null;
  }

  /**
   * Greedy selection: largest first until covered
   */
  static greedySelect(
    vouchers: SelectableVoucher[],
    amount: number
  ): SelectionResult {
    // Sort by face value descending
    const sorted = [...vouchers].sort((a, b) => b.faceValue - a.faceValue);

    const selected: SelectableVoucher[] = [];
    let totalAmount = 0;

    for (const voucher of sorted) {
      if (totalAmount >= amount) {
        break;
      }
      selected.push(voucher);
      totalAmount += voucher.faceValue;
    }

    const sufficient = totalAmount >= amount;
    const changeAmount = sufficient ? totalAmount - amount : 0;
    const shortfall = sufficient ? 0 : amount - totalAmount;

    return {
      vouchers: selected,
      totalAmount,
      changeAmount,
      needsConsolidation: selected.length > 1,
      sufficient,
      shortfall,
    };
  }

  /**
   * Minimize change strategy (subset sum optimization)
   */
  static minimizeChange(
    vouchers: SelectableVoucher[],
    amount: number
  ): SelectionResult {
    // For small numbers of vouchers, try all combinations
    if (vouchers.length <= 15) {
      return this.exhaustiveMinimizeChange(vouchers, amount);
    }

    // For larger sets, use greedy with some optimization
    return this.heuristicMinimizeChange(vouchers, amount);
  }

  /**
   * Exhaustive search for minimal change (small sets)
   */
  private static exhaustiveMinimizeChange(
    vouchers: SelectableVoucher[],
    amount: number
  ): SelectionResult {
    let bestSelection: SelectableVoucher[] = [];
    let bestTotal = 0;
    let bestChange = Infinity;
    let bestCount = Infinity;

    // Generate all subsets
    const n = vouchers.length;
    const maxSubsets = Math.pow(2, n);

    for (let mask = 1; mask < maxSubsets; mask++) {
      const subset: SelectableVoucher[] = [];
      let total = 0;

      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          subset.push(vouchers[i]);
          total += vouchers[i].faceValue;
        }
      }

      // Check if this subset covers the amount
      if (total >= amount) {
        const change = total - amount;
        // Prefer less change, then fewer vouchers
        if (change < bestChange || (change === bestChange && subset.length < bestCount)) {
          bestSelection = subset;
          bestTotal = total;
          bestChange = change;
          bestCount = subset.length;
        }
      }
    }

    if (bestSelection.length === 0) {
      // No subset covers the amount, use greedy
      return this.greedySelect(vouchers, amount);
    }

    return {
      vouchers: bestSelection,
      totalAmount: bestTotal,
      changeAmount: bestChange,
      needsConsolidation: bestSelection.length > 1,
      sufficient: true,
      shortfall: 0,
    };
  }

  /**
   * Heuristic for larger sets
   */
  private static heuristicMinimizeChange(
    vouchers: SelectableVoucher[],
    amount: number
  ): SelectionResult {
    // Sort by face value descending
    const sorted = [...vouchers].sort((a, b) => b.faceValue - a.faceValue);

    // Try different starting points
    let bestResult = this.greedySelect(sorted, amount);

    // Try starting from smaller vouchers
    const reversed = [...sorted].reverse();
    const reversedResult = this.greedySelect(reversed, amount);
    if (reversedResult.sufficient && reversedResult.changeAmount < bestResult.changeAmount) {
      bestResult = reversedResult;
    }

    // Try removing one voucher at a time from greedy result
    if (bestResult.vouchers.length > 1) {
      for (let i = 0; i < bestResult.vouchers.length; i++) {
        const without = [
          ...bestResult.vouchers.slice(0, i),
          ...bestResult.vouchers.slice(i + 1),
        ];
        const total = without.reduce((sum, v) => sum + v.faceValue, 0);
        if (total >= amount && total - amount < bestResult.changeAmount) {
          bestResult = {
            vouchers: without,
            totalAmount: total,
            changeAmount: total - amount,
            needsConsolidation: without.length > 1,
            sufficient: true,
            shortfall: 0,
          };
        }
      }
    }

    return bestResult;
  }

  /**
   * Prefer expiring vouchers strategy
   */
  static preferExpiring(
    vouchers: SelectableVoucher[],
    amount: number,
    withinDays: number = 7
  ): SelectionResult {
    // Separate expiring and non-expiring
    const expiring: SelectableVoucher[] = [];
    const nonExpiring: SelectableVoucher[] = [];

    for (const voucher of vouchers) {
      const days = daysUntilExpiry(voucher);
      if (days !== null && days <= withinDays && days > 0) {
        expiring.push(voucher);
      } else {
        nonExpiring.push(voucher);
      }
    }

    // Sort expiring by days until expiry (soonest first), then by value
    expiring.sort((a, b) => {
      const daysA = daysUntilExpiry(a) ?? Infinity;
      const daysB = daysUntilExpiry(b) ?? Infinity;
      if (daysA !== daysB) return daysA - daysB;
      return b.faceValue - a.faceValue;
    });

    // Sort non-expiring by value descending
    nonExpiring.sort((a, b) => b.faceValue - a.faceValue);

    // Combine: expiring first
    const combined = [...expiring, ...nonExpiring];

    // Use greedy with this ordering
    const selected: SelectableVoucher[] = [];
    let totalAmount = 0;

    for (const voucher of combined) {
      if (totalAmount >= amount) {
        break;
      }
      selected.push(voucher);
      totalAmount += voucher.faceValue;
    }

    const sufficient = totalAmount >= amount;
    const changeAmount = sufficient ? totalAmount - amount : 0;
    const shortfall = sufficient ? 0 : amount - totalAmount;

    return {
      vouchers: selected,
      totalAmount,
      changeAmount,
      needsConsolidation: selected.length > 1,
      sufficient,
      shortfall,
    };
  }

  /**
   * Check if vouchers can be consolidated
   */
  static canConsolidate(vouchers: SelectableVoucher[]): boolean {
    if (vouchers.length <= 1) {
      return true; // Single voucher doesn't need consolidation
    }

    // All vouchers must be compatible with each other
    for (let i = 0; i < vouchers.length; i++) {
      for (let j = i + 1; j < vouchers.length; j++) {
        if (!canConsolidatePair(vouchers[i], vouchers[j])) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Group selected vouchers by consolidation compatibility
   */
  static groupForConsolidation(vouchers: SelectableVoucher[]): SelectableVoucher[][] {
    if (vouchers.length <= 1) {
      return vouchers.length === 1 ? [vouchers] : [];
    }

    const groups: SelectableVoucher[][] = [];
    const assigned = new Set<string>();

    for (const voucher of vouchers) {
      if (assigned.has(voucher.id)) continue;

      // Find or create a group for this voucher
      let foundGroup = false;
      for (const group of groups) {
        // Check if voucher is compatible with all in group
        const compatible = group.every((g) => canConsolidatePair(g, voucher));
        if (compatible) {
          group.push(voucher);
          assigned.add(voucher.id);
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup) {
        groups.push([voucher]);
        assigned.add(voucher.id);
      }
    }

    return groups;
  }

  /**
   * Check consolidation compatibility
   */
  static checkConsolidation(vouchers: SelectableVoucher[]): ConsolidationCheck {
    if (vouchers.length <= 1) {
      return {
        canConsolidate: true,
        compatibleGroups: vouchers.length === 1 ? [vouchers] : [],
      };
    }

    const groups = this.groupForConsolidation(vouchers);
    const canConsolidate = groups.length === 1;

    let reason: string | undefined;
    if (!canConsolidate) {
      // Find the first incompatibility
      for (let i = 0; i < vouchers.length; i++) {
        for (let j = i + 1; j < vouchers.length; j++) {
          const a = vouchers[i];
          const b = vouchers[j];
          if (!canConsolidatePair(a, b)) {
            if (a.issuerId !== b.issuerId) {
              reason = 'Different issuers';
            } else if (a.faceUnit !== b.faceUnit) {
              reason = 'Different currencies';
            } else if (a.expiresAt !== b.expiresAt) {
              reason = 'Different expiry dates';
            } else {
              reason = 'Different consolidation metadata';
            }
            break;
          }
        }
        if (reason) break;
      }
    }

    return {
      canConsolidate,
      reason,
      compatibleGroups: groups,
    };
  }

  /**
   * Calculate total available balance for a currency
   */
  static getTotalAvailable(vouchers: SelectableVoucher[], currency: string): number {
    const available = filterForCurrency(vouchers, currency);
    return available.reduce((sum, v) => sum + v.faceValue, 0);
  }
}
