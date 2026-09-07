import { useEffect, useState } from 'react'

import { loadUnprotectedKey } from './nap'

/**
 * Whether this device's key is behind a passphrase. `undefined` while checking.
 *
 * Every screen that asks for the passphrase has to know, or it renders a
 * required field that nobody can fill and a button that never enables. Asked of
 * the stored ciphertext rather than a flag — see `loadUnprotectedKey`.
 *
 * The key it decrypts on the way to the answer is deliberately dropped. These
 * screens re-ask for the passphrase precisely so that an unlocked wallet left
 * open on a stall does not hand out its key, and holding the decrypted key in
 * a hook consumed by all of them would quietly undo that.
 */
export function useDevicePassphrase(): boolean | undefined {
  const [protectedKey, setProtectedKey] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let live = true
    void loadUnprotectedKey().then(
      (key) => live && setProtectedKey(key === null),
      // A keystore that will not answer is not proof of an open device. Assume
      // protected: the cost is one field the customer can leave alone.
      () => live && setProtectedKey(true),
    )
    return () => {
      live = false
    }
  }, [])

  return protectedKey
}
