import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

/**
 * Every redemption call site must carry the gift-wrap event id.
 *
 * There are TWO in this package — `TokenRedeemer.redeem` and
 * `DmPollService.redeemToken` — and the service drives the second one. A fix
 * applied to only the first left the live path broken while a behavioural test
 * against `TokenRedeemer` passed, because the consumer
 * (`postPaymentReceipt`) returns quietly on a blank id rather than throwing.
 *
 * That is the specific mistake this file exists to prevent: not "is the field
 * passed" for one call site, but "is it passed at EVERY call site". A
 * behavioural test can only cover the paths someone thought to exercise; this
 * asserts over the source, so a third call site added later fails here on the
 * day it is written.
 *
 * <p>Without the id the recipient cannot name which delivery was claimed, so
 * the settlement receipt is never posted and the sender's "Voucher Claimed"
 * notification never fires.
 */
describe('redemption call sites', () => {
  const FILES = [
    'processing/TokenRedeemer.ts',
    'core/DmPollService.ts',
  ];

  it.each(FILES)('%s passes deliveryEventId when it redeems', (file) => {
    const text = readFileSync(join(src, file), 'utf8');

    // Only meaningful if this file actually redeems; if the call moves, the
    // list above must move with it.
    expect(text).toMatch(/redemptionAdapter\??\.redeem\(/);
    expect(text).toContain('deliveryEventId');
  });

  /**
   * Guards the list itself. A new call site added to a file not named above
   * would otherwise slip through silently — exactly how the live path was
   * missed the first time.
   */
  it('names every file in the package that calls redeem', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/redemptionAdapter\??\.redeem\(/.test(text)) {
            found.push(full.slice(src.length + 1));
          }
        }
      }
    };
    walk(src);

    expect(found.sort()).toEqual([...FILES].sort());
  });
});
