/**
 * Recording what the wallet stored, and putting it back.
 *
 * A snapshot is a *recording* of the real issuing flow, never an invention.
 * Coupons are client-held by design, so the only honest path into stored state
 * is a browser performing a real issue and receive against a real backend.
 * That is slow and needs the whole stack, so it runs rarely and the result is
 * replayed per commit.
 *
 * Synthesised state could reach any size in a fraction of the time, and that
 * is exactly the trap: invented records drift from what the flow actually
 * writes, and then the suite measures a shape production never produces while
 * reporting green.
 *
 * The staleness this creates is the price, and it is paid in `sources.ts`: a
 * snapshot knows which sources produced it and refuses to be restored once
 * they have moved.
 */

import type { Page } from '@playwright/test'

/** One IndexedDB object store, and everything in it. */
export interface StoreContents {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  records: unknown[]
}

export interface DatabaseContents {
  name: string
  version: number
  stores: StoreContents[]
}

export interface Snapshot {
  /** Format version, so an old snapshot fails clearly rather than oddly. */
  format: 1
  recordedAt: string
  /**
   * The fingerprint of the code that produced this. A snapshot restored when
   * this no longer matches is measuring a shape the wallet has stopped
   * producing. See `sources.ts`.
   */
  sourceHash: string
  /** How many coupons this recording holds, which is the axis of the ladder. */
  coupons: number
  databases: DatabaseContents[]
  /**
   * Wallet state also lives outside IndexedDB: keystore, watermarks, seen-sets
   * and merchant caches are all in localStorage, and a wallet restored without
   * them boots into a different state than the one recorded.
   */
  localStorage: Record<string, string>
}

/**
 * Read every IndexedDB database and localStorage out of a live page.
 *
 * Runs in the page rather than through a storage API, because only the page
 * can see its own origin's databases.
 */
export async function capture(page: Page, coupons: number): Promise<Omit<Snapshot, 'sourceHash'>> {
  const captured = await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    const out: Array<{
      name: string
      version: number
      stores: Array<{
        name: string
        keyPath: string | string[] | null
        autoIncrement: boolean
        records: unknown[]
      }>
    }> = []

    for (const { name, version } of dbs) {
      if (!name) continue
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => ok(r.result)
        r.onerror = () => no(r.error)
      })

      const stores: Array<{
        name: string
        keyPath: string | string[] | null
        autoIncrement: boolean
        records: unknown[]
      }> = []

      for (const storeName of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const records = await new Promise<unknown[]>((ok, no) => {
          const r = store.getAll()
          r.onsuccess = () => ok(r.result)
          r.onerror = () => no(r.error)
        })
        stores.push({
          name: storeName,
          keyPath: store.keyPath as string | string[] | null,
          autoIncrement: store.autoIncrement,
          records,
        })
      }

      out.push({ name, version: version ?? db.version, stores })
      db.close()
    }

    const ls: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k) ls[k] = localStorage.getItem(k) ?? ''
    }

    return { databases: out, localStorage: ls }
  })

  return {
    format: 1,
    recordedAt: new Date().toISOString(),
    coupons,
    databases: captured.databases,
    localStorage: captured.localStorage,
  }
}

/**
 * Write a snapshot into a page's storage, before the app has booted.
 *
 * Must run on an about:blank page at the right origin, ahead of any
 * navigation, so the app finds the state already present rather than racing
 * it. Goes in through the real schema: no production module gains a seam for
 * this.
 */
export async function restore(page: Page, snapshot: Snapshot): Promise<void> {
  if (snapshot.format !== 1) {
    throw new Error(`unknown snapshot format ${snapshot.format}; re-record it`)
  }

  await page.evaluate(async (snap: Snapshot) => {
    for (const key of Object.keys(snap.localStorage)) {
      localStorage.setItem(key, snap.localStorage[key])
    }

    for (const dbSpec of snap.databases) {
      // Delete first: restoring over an existing database would merge two
      // states and measure neither.
      await new Promise<void>((ok, no) => {
        const r = indexedDB.deleteDatabase(dbSpec.name)
        r.onsuccess = () => ok()
        r.onerror = () => no(r.error)
        r.onblocked = () => ok()
      })

      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = indexedDB.open(dbSpec.name, dbSpec.version)
        r.onupgradeneeded = () => {
          const created = r.result
          for (const store of dbSpec.stores) {
            if (created.objectStoreNames.contains(store.name)) continue
            created.createObjectStore(store.name, {
              keyPath: store.keyPath ?? undefined,
              autoIncrement: store.autoIncrement,
            })
          }
        }
        r.onsuccess = () => ok(r.result)
        r.onerror = () => no(r.error)
      })

      for (const store of dbSpec.stores) {
        if (store.records.length === 0) continue
        if (!db.objectStoreNames.contains(store.name)) continue
        const tx = db.transaction(store.name, 'readwrite')
        const os = tx.objectStore(store.name)
        for (const record of store.records) os.put(record)
        await new Promise<void>((ok, no) => {
          tx.oncomplete = () => ok()
          tx.onerror = () => no(tx.error)
        })
      }

      db.close()
    }
  }, snapshot)
}

/** How many records a snapshot holds, for proving a restore actually landed. */
export function countRecords(snapshot: Snapshot): number {
  return snapshot.databases.reduce(
    (total, db) => total + db.stores.reduce((n, s) => n + s.records.length, 0),
    0,
  )
}
