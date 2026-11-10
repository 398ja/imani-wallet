/**
 * @vitest-environment node
 *
 * The closed vocabulary of data/ is exported to imani-support-agent (support-snapshot
 * src/main/resources/snapshot-vocabulary.json), whose intake refuses any other string. This test
 * fails when the wallet's vocabulary changes and the committed copy was not regenerated:
 *   UPDATE_VOCAB=1 npx vitest run src/lib/snapshot/__tests__/vocabulary.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataVocabulary } from '../build'

const FILE = join(__dirname, 'snapshot-vocabulary.json')

describe('shared data/ vocabulary', () => {
  it('matches the committed copy', () => {
    const now = JSON.stringify(dataVocabulary(), null, 1) + '\n'
    if (process.env.UPDATE_VOCAB) writeFileSync(FILE, now)
    expect(readFileSync(FILE, 'utf8')).toBe(now)
  })
})
