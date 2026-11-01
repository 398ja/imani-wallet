/**
 * #352: another tab's logout must not leave the next login stuck on
 * "Opening wallet…".
 *
 * Staging 0.33.0, two other wallet tabs open: logout's `deleteDatabase` was
 * blocked by their connections, which ignored `versionchange`, and the next
 * `open` of the same DB queued behind that delete with no event at all. It
 * opened only once every other tab was closed. fake-indexeddb implements the
 * same versionchange / blocked / queueing rules, so this is the real mechanism.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletStorage } from '../src';
import { makeFakeCashuToken } from './helpers';

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timed out'> =>
  Promise.race([p, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))]);

const deleteDb = (name: string, onBlocked?: () => void) =>
  new Promise<'deleted'>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => reject(req.error);
    req.onblocked = () => onBlocked?.();
  });

describe('WalletStorage hands the DB over on versionchange (#352)', () => {
  const open: WalletStorage[] = [];
  afterEach(async () => {
    for (const ws of open.splice(0)) await ws.close();
  });
  const make = (userId: string, extra: Partial<ConstructorParameters<typeof WalletStorage>[0]> = {}) => {
    const ws = new WalletStorage({ userId, channelName: `vc-${userId}`, ...extra });
    open.push(ws);
    return ws;
  };

  it('another tab can delete the DB while two tabs hold it, and the next open succeeds', async () => {
    const userId = crypto.randomUUID();
    await make(userId).init(); // tab A
    await make(userId).init(); // tab C

    const blocked = vi.fn();
    expect(await within(deleteDb(`imani-wallet-${userId}`, blocked), 1000)).toBe('deleted');
    expect(blocked).not.toHaveBeenCalled();

    // Tab B logs in again: the open must not queue behind a stuck delete.
    const b = make(userId);
    expect(await within(b.init(), 1000)).toBeUndefined();
    expect(await b.getAllVouchers()).toEqual([]);
  });

  it('awaits onVersionChange before closing, so a write already in flight lands', async () => {
    const userId = crypto.randomUUID();
    const order: string[] = [];
    let ws!: WalletStorage;
    ws = make(userId, {
      onVersionChange: async () => {
        order.push('handover');
        await ws.saveVoucher({ token: makeFakeCashuToken('late'), status: 'active' } as never);
        order.push('late write landed');
      },
    });
    await ws.init();

    const deleted = deleteDb(`imani-wallet-${userId}`);
    expect(await within(deleted, 1000)).toBe('deleted');
    expect(order).toEqual(['handover', 'late write landed']);
  });

  it('still closes when onVersionChange throws', async () => {
    const userId = crypto.randomUUID();
    await make(userId, { onVersionChange: () => Promise.reject(new Error('boom')) }).init();
    expect(await within(deleteDb(`imani-wallet-${userId}`), 1000)).toBe('deleted');
  });

  it('reports a blocked open, and carries on by itself once the other connection closes', async () => {
    const userId = crypto.randomUUID();
    const name = `imani-wallet-${userId}`;
    // An OLD tab (0.33.0) that ignores versionchange, holding version 1.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const onBlocked = vi.fn();
    const ws = make(userId, { onBlocked });
    const init = ws.init();
    expect(await within(init, 200)).toBe('timed out');
    expect(onBlocked).toHaveBeenCalledTimes(1);

    old.close(); // the user closes the other tab
    expect(await within(init, 1000)).toBeUndefined();
    expect(await ws.getAllVouchers()).toEqual([]);
  });
});
