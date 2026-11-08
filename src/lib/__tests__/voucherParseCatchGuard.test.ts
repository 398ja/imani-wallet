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
 * auditing that it fails safe, add it to AUDITED. Counts are per function, so they survive line
 * moves.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const PARSERS =
  /\b(parseVoucherToken|isVoucherSecret|tokenProofs|tokenVoucherDocuments|voucherOfSecret|voucherOfProof|referencedDocuments|validateVoucherDocuments)\s*\(/
const HANDLED = /\bisUnverifiableVoucherError\b|\bthrow\b/

const AUDITED: Record<string, number> = {
  'src/lib/cashlinkDirect.ts#faceOf': 1,
  'src/lib/cashlinkDirect.ts#voucherIdOf': 1,
  'src/lib/cashlinkFlow.ts#armPreflight': 1,
  'src/lib/cashlinkFlow.ts#claimLockedGift': 1,
  'src/lib/cashlinkFlow.ts#recoverOrphanBurn': 1,
  'src/lib/cashlinkFlow.ts#retryDeposit': 1,
  'src/lib/cashlinkFlow.ts#safeProofs': 1,
  'src/lib/cashlinkFlow.ts#tokenStates': 1,
  'src/lib/cashlinkLock.ts#isTheLockAskedFor': 1,
  'src/lib/cashlinkLock.ts#isTheSplitPartAskedFor': 1,
  'src/lib/cashlinkLock.ts#isTheSuccessorAskedFor': 1,
  'src/lib/checkoutCodeFlow.ts#partFace': 1,
  'src/lib/checkoutCodeFlow.ts#sameStallAndUnit': 1,
  'src/lib/checkoutCodeFlow.ts#successorProblem': 1,
  'src/lib/checkoutCodeFlow.ts#syncParts': 2,
  'src/lib/checkoutCodeFlow.ts#unlockReturned': 1,
  'src/lib/checkoutPlan.ts#candidateOf': 1,
  'src/lib/claimReconcile.ts#candidateClaim': 1,
  'src/lib/couponExpiry.ts#lockedToSomeoneElse': 1,
  'src/lib/couponFaceRepair.ts#restatedFace': 1,
  'src/lib/couponTotals.ts#readable': 1,
  'src/lib/dmCrypto.ts#isLinkLockedToken': 1,
  'src/lib/dmPoll.ts#attestReceived': 1,
  'src/lib/dmPoll.ts#exactOf': 1,
  'src/lib/dmPoll.ts#homecomingAlertFor': 1,
  'src/lib/dmPoll.ts#redeem': 1,
  'src/lib/dmPoll.ts#signedId': 1,
  'src/lib/expiryStorage.ts#signedExpiry': 1,
  'src/lib/faceSplit.ts#faceSharesOf': 1,
  'src/lib/giftLink.ts#explainRefusal': 1,
  'src/lib/giftLink.ts#giftCandidates': 1,
  'src/lib/giftLink.ts#giftExclusion': 1,
  'src/lib/giftLink.ts#lockEnd': 1,
  'src/lib/giftLink.ts#parseMintUrl': 1,
  'src/lib/giftLinks.ts#adoptLink': 1,
  'src/lib/giftLinks.ts#couponsLapsed': 1,
  'src/lib/giftLinks.ts#hasAmountProof': 1,
  'src/lib/giftLinks.ts#ownLockedOnLink': 1,
  'src/lib/giftLinks.ts#partlyDelivered': 1,
  'src/lib/giftLinks.ts#tellIssuerClaimed': 2,
  'src/lib/licenceReport.ts#reportOnce': 1,
  'src/lib/licences.ts#licenceFromToken': 1,
  'src/lib/licences.ts#licenceSignatureVerifier': 1,
  'src/lib/lockedGifts.ts#checkLockedGift': 3,
  'src/lib/merchantVouchers.ts#stallOfToken': 1,
  'src/lib/merchants.ts#isWarranted': 1,
  'src/lib/notMoney.ts#terminalCredentialFromToken': 1,
  'src/lib/pay.ts#signedPartOf': 1,
  'src/lib/redemptionRows.ts#refile': 1,
  'src/lib/selfLockedCoupons.ts#faceShare': 1,
  'src/lib/selfLockedCoupons.ts#hasSelfLockedProof': 1,
  'src/lib/selfLockedCoupons.ts#hasUnlockableProof': 1,
  'src/lib/selfLockedCoupons.ts#isCredentialProof': 1,
  'src/lib/selfLockedCoupons.ts#unlockSelfLockedRow': 1,
  'src/lib/terminalDelivery.ts#offerFromRumor': 1,
  'src/lib/terminalLogin.ts#readCredential': 1,
  'src/lib/terminalMint.ts#credentialDefect': 1,
  'src/lib/terminalRenewOwner.ts#completeRenewals': 1,
  'src/lib/terminalRenewOwner.ts#currentExpiry': 1,
  'src/lib/terminalRenewal.ts#renewRequestFromRumor': 1,
  'src/lib/terminalRenewal.ts#renewalFromRumor': 1,
  'src/lib/terminalRevoke.ts#revokeTerminalAtMint': 2,
  'src/lib/terminalRoster.ts#tokenCarriesAttestation': 1,
  'src/lib/terminalTill.ts#idleLockMinutesFor': 1,
  'src/lib/terminalUnlock.ts#heldCredentialFrom': 1,
  'src/lib/tokenSplit.ts#splitTokenByVoucher': 1,
  'src/lib/voucherSplitPlan.ts#planSplit': 2,
  'src/pages/TerminalEnrolPage.tsx#enrol': 1,
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p)
    return /\.tsx?$/.test(f) && !/\.(test|spec)\./.test(f) ? [p] : []
  })
}

function swallowingCatches(): Record<string, number> {
  const found: Record<string, number> = {}
  for (const file of sources('src')) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node, fn: string): void => {
      let name = fn
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) name = node.name.getText()
      else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        name = node.name.getText()
      if (ts.isTryStatement(node) && node.catchClause && PARSERS.test(node.tryBlock.getText())) {
        if (!HANDLED.test(node.catchClause.block.getText())) {
          const key = `${file.replace(/\\/g, '/')}#${name}`
          found[key] = (found[key] ?? 0) + 1
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
    const unaudited = Object.entries(found)
      .filter(([k, n]) => n > (AUDITED[k] ?? 0))
      .map(([k, n]) => `${k} (${n} > ${AUDITED[k] ?? 0})`)
    expect(unaudited, 'check isUnverifiableVoucherError(e) in these catches, or audit and list them').toEqual([])
  })

  it('the audited list has no stale entries', () => {
    const stale = Object.entries(AUDITED)
      .filter(([k, n]) => (found[k] ?? 0) < n)
      .map(([k]) => k)
    expect(stale, 'lower or remove these AUDITED entries').toEqual([])
  })

  it('sees the review sites, so the scan itself works', () => {
    for (const k of [
      'src/lib/claimReconcile.ts#candidateClaim',
      'src/lib/cashlinkDirect.ts#faceOf',
      'src/lib/checkoutPlan.ts#candidateOf',
      'src/lib/couponFaceRepair.ts#restatedFace',
      'src/lib/checkoutCodeFlow.ts#partFace',
    ])
      expect(found[k], k).toBeGreaterThan(0)
  })
})
