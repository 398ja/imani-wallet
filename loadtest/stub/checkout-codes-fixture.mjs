// Writes a fake .loadtest-codes.json for the stub store, and prints the STUB_CODES it needs:
//   STUB_CODES="$(node loadtest/stub/checkout-codes-fixture.mjs)" node loadtest/stub/checkout-codes-store.mjs &
//   SMOKE=1 RACE_ROUNDS=2 CODES_URL=http://127.0.0.1:18087 k6 run loadtest/checkout-codes.js
// Overwrites .loadtest-codes.json: move a real one aside first.
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { writeFileSync } from 'node:fs'
const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const luhn=(s,f)=>{let x=f,t=0;for(let i=s.length-1;i>=0;i--){const a=x*A.indexOf(s[i]);t+=Math.floor(a/32)+a%32;x=x===2?1:2}return t}
const code=()=>{let d='';for(let i=0;i<11;i++)d+=A[Math.floor(Math.random()*32)];return 'IMANI'+d+A[(32-luhn(d,2)%32)%32]}
const shops=[0,1].map(()=>{const sk=generateSecretKey();return {privHex:bytesToHex(sk),pubHex:getPublicKey(sk),stall:'aa'.repeat(32)}})
const now=Math.floor(Date.now()/1000)
const mk=(i,x)=>({code:code(),stall:'aa'.repeat(32),shop:i%2,customer:'bb',amount:100,unit:'eur',expires_at:x})
const codes=Array.from({length:6},(_,i)=>mk(i,now+3900)); const previous=[mk(0,now-60)]
writeFileSync('.loadtest-codes.json',JSON.stringify({store:'http://127.0.0.1:18087',shops,codes,previous},null,2))
console.log(JSON.stringify([...codes,...previous].map(c=>({...c,shopKey:shops[c.shop].pubHex}))))
