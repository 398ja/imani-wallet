/**
 * @vitest-environment node
 *
 * The scrubber against the vector file shared with imani-support-agent (support-snapshot
 * src/test/resources/scrub-vectors.json), so log lines the agent hands to a model are cleaned by
 * the same rules as the wallet's own data/.
 */
import { describe, expect, it } from 'vitest'

import vectors from './scrub-vectors.json'
import { scrub } from '../scrub'

describe('shared scrub vectors', () => {
  for (const v of vectors.vectors) {
    it(`${v.kind}: ${v.in.slice(0, 30)}`, () => {
      const out = scrub(v.in)
      expect(out).not.toContain(v.secret)
      expect(out).toContain(`<${v.kind}>`)
    })
  }
})
