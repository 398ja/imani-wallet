/**
 * Guard for cashu-voucher#64 review L6: a parse error is not "plain ecash".
 *
 * `parseVoucherToken` and friends throw `VoucherDocumentMissing` / `VoucherDocumentsInvalid` for a
 * by-reference voucher nobody can verify. A `catch` that swallows that error and carries on as if
 * the token were plain ecash would turn an unverifiable coupon into money. Every swallowing catch
 * below was audited and fails safe (no claim, zero credit, not lockable, unreadable).
 *
 * The test parses src with the TypeScript compiler, finds each `try` whose block calls a voucher
 * parser, and counts the catches that neither consult `isUnverifiableVoucherError` nor rethrow.
 * A new one fails here. Fix it by checking `isUnverifiableVoucherError(e)` first, or, after
 * auditing that it fails safe, add it to AUDITED. Entries are keyed by function and a hash of
 * the catch text, so any edit to an audited catch needs a fresh audit. A catch counts as handled
 * only when its first statement rethrows or tests `isUnverifiableVoucherError` (review N9), and
 * `try` blocks around a wrapper (any function calling a parser directly) are scanned too.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const BASE_PARSERS = [
  'parseVoucherToken',
  'isVoucherSecret',
  'tokenProofs',
  'tokenVoucherDocuments',
  'voucherOfSecret',
  'voucherOfProof',
  'referencedDocuments',
  'validateVoucherDocuments',
]

/** Wrappers named in review N9; any other function calling a base parser is found by the scan. */
const NAMED_WRAPPERS = ['licenceFromToken', 'terminalCredentialFromToken', 'readable', 'hasUnlockableProof']

const AUDITED = new Set<string>([
  // Each fails safe: no claim, zero credit, not lockable, unreadable, pending or retried.
  // The NGN overcharge: sendFaceOf answers undefined and debitFor the request on any failure, so an
  // unverifiable voucher gets no prediction; the screen and the history keep the request, and the
  // gateway refuses the send itself. Neither credits anything.
  'src/lib/pay.ts#debitFor#02159eb3f93f',
  'src/lib/sendFace.ts#sendFaceOf#e6d14ec06b1e',
  'src/components/SwapBackOffer.tsx#SwapBackOffer#61b402ebda63',
  'src/lib/cashback.ts#commitToken#6eb60a5b13a2',
  'src/lib/cashback.ts#resolveClaimUrl#c0a6b1d9439b',
  'src/lib/cashbackValidation.ts#cashbackValidation#3966c98b95f8',
  'src/lib/cashlinkDirect.ts#faceOf#7b867bc9a4a5',
  'src/lib/cashlinkDirect.ts#runLocked#ee4a1919ef0b',
  'src/lib/cashlinkDirect.ts#voucherIdOf#e6d14ec06b1e',
  'src/lib/cashlinkFlow.ts#armGift#6aad6670e452',
  'src/lib/cashlinkFlow.ts#armPreflight#ecbcb0e322ed',
  'src/lib/cashlinkFlow.ts#claimLockedGift#a5fc4f487f2f',
  'src/lib/cashlinkFlow.ts#finishCashlinkClaims#d124708efdb9',
  'src/lib/cashlinkFlow.ts#found#8ffa37ccdd2e',
  'src/lib/cashlinkFlow.ts#recoverOrphanBurn#fd266fd0a09b',
  'src/lib/cashlinkFlow.ts#restoreFinding#33f82e2d42c0',
  'src/lib/cashlinkFlow.ts#retryDeposit#8e892c22b735',
  'src/lib/cashlinkFlow.ts#safeProofs#9d08a4ee6905',
  'src/lib/cashlinkFlow.ts#settleLockedGift#8eccd0226c3a',
  'src/lib/cashlinkFlow.ts#tokenStates#8004903f482c',
  'src/lib/cashlinkLock.ts#isTheLockAskedFor#fd266fd0a09b',
  'src/lib/cashlinkLock.ts#isTheSplitPartAskedFor#fd266fd0a09b',
  'src/lib/cashlinkLock.ts#isTheSuccessorAskedFor#fd266fd0a09b',
  'src/lib/checkoutCarve.ts#canCarve#fd266fd0a09b',
  'src/lib/checkoutCodeFlow.ts#lockParts#0df539e5ccdb',
  'src/lib/checkoutCodeFlow.ts#partFace#7b867bc9a4a5',
  'src/lib/checkoutCodeFlow.ts#sameStallAndUnit#fd266fd0a09b',
  'src/lib/checkoutCodeFlow.ts#successorProblem#c4ef078dd252',
  'src/lib/checkoutCodeFlow.ts#syncParts#7245302b811d',
  'src/lib/checkoutCodeFlow.ts#syncParts#7a07e3c4dc6d',
  'src/lib/checkoutCodeFlow.ts#unlockReturned#ee4a1919ef0b',
  'src/lib/checkoutCodesApp.ts#onCheckoutNoticeDm#7f384e238642',
  'src/lib/checkoutPlan.ts#candidateOf#f87cee35fdf2',
  'src/lib/claimReconcile.ts#candidateClaim#e6d14ec06b1e',
  'src/lib/claimReconcile.ts#reconcileClaims#cd506327fae6',
  'src/lib/couponExpiry.ts#lockedToSomeoneElse#84577bf96097',
  'src/lib/couponFaceRepair.ts#restatedFace#7fa34d6c8a4e',
  'src/lib/couponTotals.ts#readable#7fa34d6c8a4e',
  'src/lib/dmCrypto.ts#isLinkLockedToken#fd266fd0a09b',
  'src/lib/dmCrypto.ts#unwrapNip17Dm#de4a1944ca06',
  // #310 (imani-wallet#580): publishRedeemed answers null on any failure, so an unverifiable voucher
  // publishes no REDEEMED event; dmPoll#redeem's catch only logs a failed ledger publish after the
  // redemption is done. Neither turns a voucher into plain ecash.
  'src/lib/attestation.ts#publishRedeemed#3e94eb68289c',
  'src/lib/dmPoll.ts#redeem#c47258e5bf40',
  'src/lib/dmPoll.ts#attestReceived#98c9b3871002',
  'src/lib/dmPoll.ts#checkSwapAndWrite#c0d3be0c0c76',
  'src/lib/dmPoll.ts#exactOf#e6d14ec06b1e',
  'src/lib/dmPoll.ts#homecomingAlertFor#fa3840895150',
  'src/lib/dmPoll.ts#redeem#e2dccedfcfca',
  'src/lib/dmPoll.ts#signedId#7fa34d6c8a4e',
  'src/lib/expiryStorage.ts#signedExpiry#e6d14ec06b1e',
  'src/lib/faceSplit.ts#faceSharesOf#e6d14ec06b1e',
  'src/lib/giftLinks.ts#adoptLink#bf29573c5995',
  'src/lib/giftLinks.ts#armLink#953d1460ed13',
  'src/lib/giftLinks.ts#couponsLapsed#fd266fd0a09b',
  'src/lib/giftLinks.ts#hasAmountProof#fd266fd0a09b',
  'src/lib/giftLinks.ts#ownLockedOnLink#9d08a4ee6905',
  'src/lib/giftLinks.ts#partlyDelivered#fd266fd0a09b',
  'src/lib/giftLinks.ts#recheckClaim#7e96b27e21e8',
  'src/lib/giftLinks.ts#reconcileGiftLinks#a1e2aaae3c3a',
  'src/lib/giftLinks.ts#swapGiftTokens#e64c24db4050',
  'src/lib/giftLinks.ts#tellIssuerClaimed#6c2d8d0f1f9b',
  'src/lib/giftLinks.ts#tellIssuerClaimed#f74c1d5d8c59',
  'src/lib/giftLink.ts#explainRefusal#54eef16382a3',
  'src/lib/giftLink.ts#giftCandidates#fd266fd0a09b',
  'src/lib/giftLink.ts#giftExclusion#23a20b4ff99f',
  'src/lib/giftLink.ts#lockEnd#e6d14ec06b1e',
  'src/lib/giftLink.ts#parseMintUrl#7fa34d6c8a4e',
  'src/lib/licenceReport.ts#reportOnce#bf29573c5995',
  'src/lib/licences.ts#licenceFromToken#7fa34d6c8a4e',
  'src/lib/licences.ts#licenceSignatureVerifier#fd266fd0a09b',
  'src/lib/lockedGiftsApp.ts#readGiftReturn#d4de9e2ef54a',
  // #532: merging a buyer's copy handed over in parts. On any failure the first part is kept as it
  // is, unmerged; checkLockedGift then decides it, so nothing is credited or spent by the catch.
  'src/lib/lockedGiftsApp.ts#mergeSameVoucher#023567cb5c07',
  'src/lib/lockedGiftsApp.ts#runSweep#4d51dc63f638',
  'src/lib/lockedGiftsApp.ts#runSweep#a29d28c626f5',
  'src/lib/lockedGifts.ts#checkLockedGift#29e0cbd762d4',
  'src/lib/lockedGifts.ts#checkLockedGift#29e0cbd762d4~2',
  'src/lib/lockedGifts.ts#checkLockedGift#3743ee3efc61',
  'src/lib/logout.ts#safeCheck#9f046bca5618',
  'src/lib/logout.ts#safeCodes#90b87257e01c',
  'src/lib/logout.ts#safeStash#1d2b80f0bc33',
  'src/lib/merchants.ts#isWarranted#b561c0de42e9',
  'src/lib/merchantVouchers.ts#stallOfToken#7fa34d6c8a4e',
  'src/lib/notMoneyNotice.ts#announceTerminalDm#fd266fd0a09b',
  'src/lib/notMoney.ts#terminalCredentialFromToken#7fa34d6c8a4e',
  'src/lib/pay.ts#signedPartOf#e6d14ec06b1e',
  // imani-wallet#277: an unreadable token has no card reference, so it gets no refund badge and no
  // send-side check. Display and UX only: gateway-customer's receive guard still refuses it.
  'src/lib/cardVoucherRef.ts#cardReferenceOfRow#e6d14ec06b1e',
  'src/lib/receiveSwap.ts#receiveByOwnSwap#95ffa067ed7a',
  'src/lib/redemptionRows.ts#refile#4e947b60885a',
  'src/lib/selfLockedCoupons.ts#faceShare#e6d14ec06b1e',
  'src/lib/selfLockedCoupons.ts#hasSelfLockedProof#fd266fd0a09b',
  'src/lib/selfLockedCoupons.ts#hasUnlockableProof#fd266fd0a09b',
  'src/lib/selfLockedCoupons.ts#isCredentialProof#fd266fd0a09b',
  'src/lib/selfLockedCoupons.ts#unlockSelfLockedRow#ee4a1919ef0b',
  'src/lib/terminalDeliveryNet.ts#collectRenewRequests#7b867bc9a4a5',
  'src/lib/terminalDelivery.ts#offerFromRumor#c4ef078dd252',
  'src/lib/terminalLogin.ts#readCredential#b7e1f41cb4a9',
  'src/lib/terminalMint.ts#credentialDefect#c4ef078dd252',
  'src/lib/terminalRenewal.ts#renewalFromRumor#a69774164e7a',
  'src/lib/terminalRenewal.ts#renewRequestFromRumor#c4ef078dd252',
  'src/lib/terminalRenewOwner.ts#completeRenewals#7fa34d6c8a4e',
  'src/lib/terminalRenewOwner.ts#currentExpiry#e6d14ec06b1e',
  'src/lib/terminalRenewOwner.ts#runRenewal#62187ce3ebfb',
  'src/lib/terminalRevoke.ts#resumeMinting#0efbe727720d',
  'src/lib/terminalRevoke.ts#revokeTerminalAtMint#3c090b878f46',
  'src/lib/terminalRevoke.ts#revokeTerminalAtMint#937542f28674',
  'src/lib/terminalRoster.ts#tokenCarriesAttestation#fd266fd0a09b',
  'src/lib/terminalTill.ts#idleLockMinutesFor#2cd5711c131e',
  'src/lib/terminalTill.ts#run#2aea17362e53',
  'src/lib/terminalUnlock.ts#heldCredentialFrom#7fa34d6c8a4e',
  'src/lib/tokenSplit.ts#splitTokenByVoucher#185cdfc71f17',
  'src/lib/transferSignature.ts#publishDueLocked#c28b789ac2e4',
  'src/lib/transferSignature.ts#resumeTransferReceipts#ffda4cb62126',
  'src/lib/voucherSplitPlan.ts#canSplit#fd266fd0a09b',
  'src/lib/voucherSplitPlan.ts#planSplit#7fa34d6c8a4e',
  'src/lib/voucherSplitPlan.ts#planSplit#bf29573c5995',
  'src/lib/voucherSplit.ts#finishOne#ee4a1919ef0b',
  'src/lib/witness.ts#secretsFromToken#9d08a4ee6905',
  'src/pages/DeleteAccountPage.tsx#go#877cb02e068b',
  // #402 online shop: the enrol pipeline moved to terminalEnrolFlow.ts. Its catches rethrow (the row
  // write as EnrolNotStartedError, the mint after settleMintFailure); the screens' catches only word
  // the failure. None reads a token as plain ecash.
  'src/lib/terminalEnrolFlow.ts#enrolTerminal#c0372312dea7',
  // The Terminals open-time pass, moved unchanged into a hook both screens share (same hash).
  'src/hooks/useTerminalUpkeep.ts#useTerminalUpkeep#a3a5f1cc76ec',
  'src/pages/OnlineShopPage.tsx#connect#7da9854e1956',
  'src/pages/OnlineShopPage.tsx#disconnect#1a467249bb31',
  'src/pages/TerminalEnrolPage.tsx#enrol#c6d87daadd72',
  'src/pages/TerminalsPage.tsx#TerminalsPage#a86fffe832b1',
])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p)
    return /\.tsx?$/.test(f) && !/\.(test|spec)\./.test(f) ? [p] : []
  })
}

const callRe = (names: Iterable<string>) => new RegExp(`\\b(${[...names].join('|')})\\s*\\(`)

type Fn = { file: string; name: string; body: ts.Node }

function functionsOf(sf: ts.SourceFile, file: string): Fn[] {
  const out: Fn[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body)
      out.push({ file, name: node.name.getText(), body: node.body })
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      out.push({ file, name: node.name.getText(), body: node.initializer.body })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * A catch handles the error only when its FIRST statement rethrows, or is an `if` testing
 * `isUnverifiableVoucherError` (review N9): a `throw` buried in an unrelated branch does not count.
 */
function handled(block: ts.Block): boolean {
  const first = block.statements[0]
  if (!first) return false
  if (ts.isThrowStatement(first)) return true
  return ts.isIfStatement(first) && /\bisUnverifiableVoucherError\s*\(/.test(first.expression.getText())
}

function catchHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)
}

/** The parsers a `try` is scanned for: the base ones, the named wrappers, and every function calling a base parser. */
function parserNames(files: Array<{ sf: ts.SourceFile; file: string }>): Set<string> {
  const base = callRe(BASE_PARSERS)
  const names = new Set([...BASE_PARSERS, ...NAMED_WRAPPERS])
  for (const { sf, file } of files) for (const f of functionsOf(sf, file)) if (base.test(f.body.getText())) names.add(f.name)
  return names
}

/** Swallowing catches keyed `file#function#hash(catch text)`. */
function swallowingCatches(): Set<string> {
  const files = sources('src').map((file) => ({
    file: file.replace(/\\/g, '/'),
    sf: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
  }))
  const parsers = callRe(parserNames(files))
  const found = new Set<string>()
  for (const { sf, file } of files) {
    const visit = (node: ts.Node, fn: string): void => {
      let name = fn
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) name = node.name.getText()
      else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        name = node.name.getText()
      if (ts.isTryStatement(node) && node.catchClause && parsers.test(node.tryBlock.getText())) {
        if (!handled(node.catchClause.block)) {
          const key = `${file}#${name}#${catchHash(node.catchClause.getText())}`
          let n = 1
          while (found.has(n === 1 ? key : `${key}~${n}`)) n++
          found.add(n === 1 ? key : `${key}~${n}`)
          if (process.env.DUMP_CATCHES) console.log(`@@ ${key} | ${(node.tryBlock.getText().match(parsers) ?? [''])[0]}\n${node.catchClause.getText()}`)
        }
      }
      ts.forEachChild(node, (child) => visit(child, name))
    }
    visit(sf, '<module>')
  }
  return found
}

describe('voucher parse catches (cashu-voucher#64, review L6)', () => {
  const found = swallowingCatches()

  it('no new catch swallows an unverifiable voucher as plain ecash', () => {
    const unaudited = [...found].filter((k) => !AUDITED.has(k)).sort()
    expect(unaudited, 'check isUnverifiableVoucherError(e) first in these catches, or audit and list them').toEqual([])
  })

  it('the audited list has no stale entries', () => {
    const stale = [...AUDITED].filter((k) => !found.has(k))
    expect(stale, 'remove these AUDITED entries (the catch changed: re-audit it)').toEqual([])
  })

  it('the first-statement rule refuses a throw in an unrelated branch', () => {
    const sf = ts.createSourceFile('x.ts', 'try { f() } catch (e) { if (x) throw e; return null }', ts.ScriptTarget.Latest, true)
    const block = (sf.statements[0] as ts.TryStatement).catchClause!.block
    expect(handled(block)).toBe(false)
    const ok = ts.createSourceFile('y.ts', 'try { f() } catch (e) { if (isUnverifiableVoucherError(e)) throw e; return null }', ts.ScriptTarget.Latest, true)
    expect(handled((ok.statements[0] as ts.TryStatement).catchClause!.block)).toBe(true)
  })

  it('sees the review sites, so the scan itself works', () => {
    for (const k of [
      'src/lib/claimReconcile.ts#candidateClaim',
      'src/lib/cashlinkDirect.ts#faceOf',
      'src/lib/checkoutPlan.ts#candidateOf',
      'src/lib/couponFaceRepair.ts#restatedFace',
      'src/lib/checkoutCodeFlow.ts#partFace',
    ])
      expect([...found].some((f) => f.startsWith(`${k}#`)), k).toBe(true)
  })
})
