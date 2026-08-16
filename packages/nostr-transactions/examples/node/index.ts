/**
 * @imani/nostr-transactions - Node.js Example
 *
 * Demonstrates using the transaction library in a Node.js environment
 * with the memory adapter.
 *
 * Run: npx ts-node index.ts
 */

import {
  TransactionStore,
  TransactionType,
  TransactionDirection,
  formatCurrency,
  formatRelativeTime,
  getTransactionTypeLabel,
  exportToJSON,
  exportToCSV,
} from '../../src';

async function main() {
  console.log('='.repeat(60));
  console.log('@imani/nostr-transactions - Node.js Example');
  console.log('='.repeat(60));
  console.log();

  // Create store with memory adapter (IndexedDB not available in Node.js)
  const store = new TransactionStore({
    storage: 'memory',
  });

  await store.init();
  console.log('Store initialized with memory adapter\n');

  // ==================== Add Sample Transactions ====================
  console.log('Adding sample transactions...');

  const now = Math.floor(Date.now() / 1000);

  await store.recordBatch([
    {
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 5000,
      faceValue: 2500,
      faceUnit: 'USD',
      faceDecimals: 2,
      counterparty: 'alice-pubkey',
      counterpartyName: 'Alice',
      memo: 'Coffee payment',
      timestamp: now - 86400 * 7, // 7 days ago
    },
    {
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 2000,
      faceValue: 1000,
      faceUnit: 'USD',
      faceDecimals: 2,
      counterparty: 'bob-pubkey',
      counterpartyName: 'Bob',
      memo: 'Lunch split',
      timestamp: now - 86400 * 5, // 5 days ago
    },
    {
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 10000,
      faceValue: 5000,
      faceUnit: 'USD',
      faceDecimals: 2,
      counterparty: 'charlie-pubkey',
      counterpartyName: 'Charlie',
      memo: 'Project payment',
      timestamp: now - 86400 * 3, // 3 days ago
    },
    {
      type: TransactionType.PURCHASED,
      direction: TransactionDirection.IN,
      tokenAmount: 50000,
      faceValue: 25000,
      faceUnit: 'USD',
      faceDecimals: 2,
      issuerId: 'merchant-pubkey',
      issuerName: 'Gift Card Store',
      memo: 'Gift card purchase',
      timestamp: now - 86400, // 1 day ago
    },
    {
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 1500,
      faceValue: 750,
      faceUnit: 'USD',
      faceDecimals: 2,
      counterparty: 'david-pubkey',
      counterpartyName: 'David',
      memo: 'Birthday gift',
      timestamp: now - 3600, // 1 hour ago
    },
    {
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 100000,
      faceValue: 50000,
      faceUnit: 'XAF',
      faceDecimals: 0,
      counterparty: 'eric-pubkey',
      counterpartyName: 'Eric',
      memo: 'International transfer',
      timestamp: now,
    },
  ]);

  console.log('Added 6 sample transactions\n');

  // ==================== Basic Queries ====================
  console.log('-'.repeat(60));
  console.log('BASIC QUERIES');
  console.log('-'.repeat(60));

  // Get all transactions
  const all = await store.getAll();
  console.log(`\nTotal transactions: ${all.length}`);

  // Get recent transactions
  const recent = await store.getRecent(3);
  console.log(`\nMost recent 3 transactions:`);
  for (const tx of recent) {
    console.log(`  - ${getTransactionTypeLabel(tx.type)}: ${formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals)} (${tx.memo})`);
  }

  // ==================== Fluent Query Builder ====================
  console.log('\n' + '-'.repeat(60));
  console.log('FLUENT QUERY BUILDER');
  console.log('-'.repeat(60));

  // Query received transactions
  console.log('\nReceived transactions:');
  const received = await store.find().received().get();
  for (const tx of received) {
    console.log(`  + ${formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals)} from ${tx.counterpartyName || 'Unknown'}`);
  }

  // Query sent transactions
  console.log('\nSent transactions:');
  const sent = await store.find().sent().get();
  for (const tx of sent) {
    console.log(`  - ${formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals)} to ${tx.counterpartyName || 'Unknown'}`);
  }

  // Query by counterparty
  console.log('\nTransactions with Alice:');
  const aliceTxs = await store.find().counterparty('alice-pubkey').get();
  console.log(`  Found ${aliceTxs.length} transaction(s)`);

  // Query large transactions
  console.log('\nTop 3 largest transactions:');
  const largest = await store.find().largest().limit(3).get();
  for (const tx of largest) {
    console.log(`  ${formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals)} - ${tx.memo}`);
  }

  // Query this week
  console.log('\nTransactions this week:');
  const thisWeek = await store.find().thisWeek().get();
  console.log(`  Found ${thisWeek.length} transaction(s)`);

  // Search by memo
  console.log('\nSearch for "gift":');
  const giftSearch = await store.find().search('gift').get();
  for (const tx of giftSearch) {
    console.log(`  ${tx.memo} - ${formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals)}`);
  }

  // ==================== Statistics ====================
  console.log('\n' + '-'.repeat(60));
  console.log('STATISTICS');
  console.log('-'.repeat(60));

  const stats = await store.getStats();
  console.log(`
Total In:      ${stats.totalIn.toLocaleString()} sats
Total Out:     ${stats.totalOut.toLocaleString()} sats
Net Flow:      ${stats.netFlow.toLocaleString()} sats
Count In:      ${stats.countIn}
Count Out:     ${stats.countOut}
  `);

  console.log('By Type:');
  for (const [type, data] of Object.entries(stats.byType)) {
    console.log(`  ${getTransactionTypeLabel(type)}: ${data.count} tx, ${data.total.toLocaleString()} sats`);
  }

  console.log('\nBy Currency:');
  for (const [unit, data] of Object.entries(stats.byUnit)) {
    console.log(`  ${unit}: ${data.count} tx, ${data.totalFaceValue.toLocaleString()} (${data.totalTokenAmount.toLocaleString()} sats)`);
  }

  // ==================== Query Results ====================
  console.log('\n' + '-'.repeat(60));
  console.log('QUERY RESULTS WITH PAGINATION');
  console.log('-'.repeat(60));

  const page1 = await store.find().newest().page(1, 2).execute();
  console.log(`\nPage 1 (2 per page):`);
  console.log(`  Total: ${page1.total}, Has More: ${page1.hasMore}`);
  for (const tx of page1.transactions) {
    console.log(`  - ${tx.memo}`);
  }

  const page2 = await store.find().newest().page(2, 2).execute();
  console.log(`\nPage 2:`);
  console.log(`  Total: ${page2.total}, Has More: ${page2.hasMore}`);
  for (const tx of page2.transactions) {
    console.log(`  - ${tx.memo}`);
  }

  // ==================== Export ====================
  console.log('\n' + '-'.repeat(60));
  console.log('EXPORT');
  console.log('-'.repeat(60));

  const transactions = await store.getAll();

  const json = exportToJSON(transactions);
  console.log(`\nJSON export (${json.length} characters):`);
  console.log(json.substring(0, 200) + '...');

  const csv = exportToCSV(transactions);
  console.log(`\nCSV export (${csv.split('\n').length} lines):`);
  console.log(csv.split('\n').slice(0, 3).join('\n') + '\n...');

  // ==================== Cleanup ====================
  console.log('\n' + '-'.repeat(60));
  console.log('CLEANUP');
  console.log('-'.repeat(60));

  // Check exists
  const firstTx = all[0];
  const exists = await store.exists(firstTx.id);
  console.log(`\nTransaction ${firstTx.id.substring(0, 8)}... exists: ${exists}`);

  // Delete one
  await store.delete(firstTx.id);
  const existsAfter = await store.exists(firstTx.id);
  console.log(`After delete: ${existsAfter}`);

  // Count remaining
  const remaining = await store.count();
  console.log(`Remaining transactions: ${remaining}`);

  // Close store
  await store.close();
  console.log('\nStore closed');

  console.log('\n' + '='.repeat(60));
  console.log('Example complete!');
  console.log('='.repeat(60));
}

// Run
main().catch(console.error);
