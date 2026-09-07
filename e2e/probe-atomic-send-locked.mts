/**
 * Can a customer SPEND a coupon that is locked to them?
 *
 * Issue #58. Locking a coupon is only half the property: if the owner cannot
 * spend it, the lock has destroyed the money rather than protected it. The
 * client's real spend path is the atomic-send saga in gateway-core — it does
 * not call /wallet/send at all — and that path had no witness support
 * whatsoever, so a locked coupon could be issued and never paid with.
 *
 * Four separate defects sat between issue and send, each hidden behind the one
 * before it: the split could not READ a locked voucher, then could not VERIFY
 * it in the shape it was signed, then re-serialised its swap outputs in the
 * unlocked shape (losing the lock and the signature), and finally the swap
 * itself never attached the sender's witness.
 *
 * Run WITNESSES=off to see the property this proves: the same send then fails
 * at the mint with 10001, "Insufficient valid signatures".
 *
 *   npx tsx e2e/probe-atomic-send-locked.mts
 *
 * Needs the imani-test stack up and a funded gateway wallet.
 */
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { proofSecrets } from '../src/lib/voucherToken'

const CUSTOMER='http://localhost:28082', CORE='http://localhost:28081'
const MINT='http://127.0.0.1.mint:7777'
const sk=hexToBytes(JSON.parse(readFileSync('/tmp/lockkey.json','utf8')).sk); const pk=getPublicKey(sk)
function auth(u:string,m:string,b?:string){const t=[['u',u],['method',m]]
  if(b)t.push(['payload',bytesToHex(sha256(new TextEncoder().encode(b)))])
  return 'Nostr '+Buffer.from(JSON.stringify(finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:t,content:''},sk))).toString('base64')}
async function call(base:string,p:string,m:string,pl?:unknown,ex:Record<string,string>={}){const u=base+p
  const b=pl?JSON.stringify(pl):undefined
  const r=await fetch(u,{method:m,headers:{'Content-Type':'application/json',Authorization:auth(u,m,b),...ex},body:b})
  return {status:r.status,text:await r.text()}}

// 1. Issue a coupon LOCKED to us.
const c=await call(CUSTOMER,'/api/v1/wallet/vouchers','POST',{face_value:120,face_unit:'sat',
  face_decimals:0,mint_url:MINT,backing_strategy:'FIXED',recipient_pubkey:'02'+pk,backing_sats:120})
if(c.status!==201){console.error('issue failed',c.status,c.text.slice(0,200));process.exit(1)}
const vid=JSON.parse(c.text).voucher_id
let token:string|undefined=JSON.parse(c.text).token
for(let i=0;!token&&i<8;i++){await new Promise(r=>setTimeout(r,3000))
  try{token=JSON.parse((await call(CUSTOMER,`/api/v1/wallet/vouchers/${vid}`,'GET')).text).token}catch{}}
if(!token){console.error('FAIL: no token');process.exit(1)}
const secrets=proofSecrets(token)
console.log('1. issued', secrets.length, 'proof(s), kind:', JSON.parse(secrets[0])[0])

// 2. Sign, exactly as shared/api.js now does.
const w:Record<string,string[]>={}
for(const s of secrets){const p=JSON.parse(s)
  if(p[0]==='P2PK_VOUCHER') w[s]=[bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(s)),sk))]}
console.log('2. signed', Object.keys(w).length, 'secret(s)')

// 3. Atomic send, WITH witnesses in the body.
const recipient='0'.repeat(63)+'1'
const send=await call(CORE,'/api/v1/atomic-send','POST',{
  token, amount:60, recipient_pubkey:recipient, face_value:60, face_unit:'sat',
  // WITNESSES=off omits them, which must fail: without that arm a
  // permissive mint would let this probe pass while enforcing nothing.
  ...(process.env.WITNESSES === 'off' ? {} : { witnesses: JSON.stringify(w) }),
},{'Idempotency-Key':`as-${Date.now()}`})
console.log('3. initiate:', send.status, send.status===202?'ACCEPTED':send.text.slice(0,220))
if(send.status!==202) process.exit(1)
const sendId=JSON.parse(send.text).send_id ?? JSON.parse(send.text).sendId

// 4. Poll the saga to a terminal state.
for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,1500))
  const st=await call(CORE,`/api/v1/atomic-send/${sendId}`,'GET')
  let s; try{s=JSON.parse(st.text)}catch{continue}
  const state=s.status ?? s.state
  if(['COMPLETED','FAILED','EXPIRED','DM_ERROR','SPLIT_ERROR','RECLAIM_READY'].includes(state)){
    const wantFailure = process.env.WITNESSES === 'off'
    const ok = state === 'COMPLETED' || state === 'DM_ERROR'
    console.log('4. saga:', state, ok ? '' : JSON.stringify(s).slice(0, 200))
    if (wantFailure) {
      if (ok) {
        console.error('FAIL: an UNSIGNED locked send completed — the lock is not enforced')
        process.exit(1)
      }
      console.log('\nPASS: without witnesses the send is refused, as it must be.')
      process.exit(0)
    }
    if (!ok) {
      console.error('FAIL: a correctly signed locked send did not complete')
      process.exit(1)
    }
    console.log('\nPASS: a coupon locked to its owner is spendable by its owner.')
    process.exit(0)
  }
}
console.log('4. saga did not reach a terminal state')
