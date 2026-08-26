# @imani/wallet-balance

Balance calculation and aggregation library for Imani wallet. Provides multi-currency balance tracking, voucher selection optimization, and real-time balance updates.

## Installation

```bash
npm install @imani/wallet-balance
```

## Features

- Multi-currency balance calculation
- Real-time balance updates via VoucherStore integration
- Smart voucher selection for payments
- Currency formatting with proper decimal handling
- Grouping by issuer, currency, and backing strategy
- Expiring voucher awareness
- Dynamic currency registration

## Quick Start

```typescript
import { BalanceManager, CurrencyAggregator } from '@imani/wallet-balance';
import { VoucherStore } from '@imani/nostr-vouchers';

// Initialize VoucherStore
const voucherStore = new VoucherStore({ dbName: 'my-wallet' });
await voucherStore.init();

// Create BalanceManager
const balanceManager = new BalanceManager({
  voucherStore,
  refreshInterval: 30000, // Auto-refresh every 30s
});
await balanceManager.init();

// Get balance
const balance = await balanceManager.getBalance();
console.log(`Total: ${balance.currencies.EUR?.formatted}`);

// Listen for changes
balanceManager.on('balance:updated', ({ current }) => {
  console.log('Balance updated:', current);
});
```

## API Reference

### BalanceManager

Main class for balance management with VoucherStore integration.

```typescript
const manager = new BalanceManager({
  voucherStore: VoucherStore;      // Required: VoucherStore instance
  transactionStore?: TransactionStore; // Optional: for pending tx awareness
  refreshInterval?: number;        // Auto-refresh interval in ms (0 to disable)
  includePending?: boolean;        // Include pending transactions
  debug?: boolean;                 // Enable debug logging
  expiringWithinDays?: number;     // Days threshold for "expiring soon" (default: 7)
});
```

#### Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize and subscribe to VoucherStore events |
| `close()` | Cleanup and unsubscribe |
| `getBalance(options?)` | Get wallet balance (cached) |
| `getBalanceBreakdown()` | Get full balance breakdown |
| `getBalanceByCurrency(currency)` | Get balance for specific currency |
| `getBalanceByIssuer(issuerId)` | Get balance for specific issuer |
| `getIssuerBalances()` | Get all issuer balances |
| `getCurrencyBalances()` | Get all currency balances |
| `getTopIssuers(limit?)` | Get top N issuers by balance |
| `selectVouchersForAmount(request)` | Select vouchers for payment |
| `refresh()` | Force refresh balance |

#### Events

```typescript
manager.on('balance:updated', ({ previous, current, trigger }) => { });
manager.on('balance:currency-changed', ({ currency, previous, current, difference }) => { });
manager.on('balance:issuer-changed', ({ issuerId, previous, current }) => { });
manager.on('balance:error', ({ error, operation }) => { });
manager.on('balance:refreshing', ({ timestamp }) => { });
manager.on('balance:refreshed', ({ balance, duration }) => { });
```

### BalanceCalculator

Pure functions for balance calculation (no side effects).

```typescript
import { BalanceCalculator } from '@imani/wallet-balance';

// Calculate total balance
const balance = BalanceCalculator.calculateTotal(vouchers);

// Calculate by currency
const eurBalance = BalanceCalculator.calculateForCurrency(vouchers, 'EUR');

// Calculate by issuer
const issuerBalances = BalanceCalculator.calculateByIssuer(vouchers);

// Full breakdown
const breakdown = BalanceCalculator.calculateBreakdown(vouchers);

// Filter options
const filtered = BalanceCalculator.calculateTotal(vouchers, {
  activeOnly: true,
  excludeExpired: true,
  issuerId: 'specific-issuer',
  currency: 'EUR',
  backingStrategy: 'MINIMAL',
  expiringWithinDays: 7,
});
```

### CurrencyAggregator

Currency handling and formatting utilities.

```typescript
import { CurrencyAggregator, registerCurrency } from '@imani/wallet-balance';

// Format amounts
CurrencyAggregator.format(1500, 'EUR');     // "€15,00"
CurrencyAggregator.format(1000, 'SAT');     // "1,000 sats"
CurrencyAggregator.format(5000, 'XAF');     // "5 000 FCFA"

// Format multiple currencies
CurrencyAggregator.formatMultiple(balances); // "€15,00 + $10.00"

// Unit conversion
CurrencyAggregator.toMajorUnits(1500, 2);   // 15 (cents to euros)
CurrencyAggregator.toMinorUnits(15, 2);     // 1500 (euros to cents)

// Aggregate amounts
const aggregated = CurrencyAggregator.aggregate([
  { amount: 1000, currency: 'EUR' },
  { amount: 500, currency: 'EUR' },
]);

// Register custom currency
registerCurrency('CUSTOM', {
  symbol: 'C$',
  decimals: 2,
  symbolPosition: 'before',
});
```

### SelectionOptimizer

Smart voucher selection for payments.

```typescript
import { SelectionOptimizer } from '@imani/wallet-balance';

// Select vouchers for payment
const result = SelectionOptimizer.selectForAmount(vouchers, {
  amount: 1000,            // Amount in minor units (cents)
  currency: 'EUR',
  strategy: 'prefer-single', // or 'minimize-change', 'use-expiring-first'
  preferredIssuerId: 'issuer-1',
  excludeVoucherIds: ['exclude-this'],
});

// Result
{
  vouchers: Voucher[];      // Selected vouchers
  totalAmount: number;      // Total selected
  changeAmount: number;     // Overage
  needsConsolidation: boolean;
  sufficient: boolean;
  shortfall: number;
  consolidationGroups?: Voucher[][];
}

// Check consolidation compatibility
const check = SelectionOptimizer.checkConsolidation(vouchers);
// { canConsolidate: boolean, reason?: string, compatibleGroups: Voucher[][] }
```

## Supported Currencies

Built-in support for:

| Currency | Symbol | Decimals |
|----------|--------|----------|
| EUR | € | 2 |
| USD | $ | 2 |
| GBP | £ | 2 |
| SAT/SATS | sats | 0 |
| XAF/XOF | FCFA | 0 |
| NGN | ₦ | 2 |
| KES | KSh | 2 |
| JPY | ¥ | 0 |
| BTC | ₿ | 8 |

Unknown currencies use sensible defaults (2 decimals, code as symbol).

## Selection Strategies

| Strategy | Description |
|----------|-------------|
| `prefer-single` | Prefer single voucher (default) |
| `minimize-count` | Use fewest vouchers |
| `minimize-change` | Minimize overpayment |
| `use-expiring-first` | Prioritize expiring vouchers |

## Types

```typescript
interface WalletBalance {
  currencies: Record<string, CurrencyBalance>;
  totalSatsBacking: number;
  primaryCurrency: string | null;
  calculatedAt: number;
  includesPending: boolean;
}

interface CurrencyBalance {
  currency: string;
  amount: number;
  decimals: number;
  formatted: string;
  voucherCount: number;
}

interface IssuerBalance {
  issuerId: string;
  issuerName: string;
  currencies: Record<string, CurrencyBalance>;
  totalSatsBacking: number;
  voucherCount: number;
}

interface BalanceBreakdown {
  total: WalletBalance;
  byIssuer: IssuerBalance[];
  byStrategy: Record<BackingStrategy, WalletBalance>;
  expiringSoon: WalletBalance;
  expiringWithinDays: number;
}
```

## Integration with Imani Packages

```typescript
import { VoucherStore } from '@imani/nostr-vouchers';
import { TransactionStore } from '@imani/nostr-transactions';
import { BalanceManager } from '@imani/wallet-balance';

// Full integration
const voucherStore = new VoucherStore({ dbName: 'wallet' });
const transactionStore = new TransactionStore({ dbName: 'wallet' });

await Promise.all([voucherStore.init(), transactionStore.init()]);

const balanceManager = new BalanceManager({
  voucherStore,
  transactionStore,
  includePending: true,
});
await balanceManager.init();

// Balance now accounts for pending transactions
const balance = await balanceManager.getBalance();
```

## Bundle Formats

| Format | File | Size |
|--------|------|------|
| ESM | dist/index.js | ~46 KB |
| CJS | dist/index.cjs | ~46 KB |
| Browser IIFE | dist/wallet-balance.browser.global.js | ~51 KB |

Browser global: `ImaniWalletBalance`

## License

MIT
