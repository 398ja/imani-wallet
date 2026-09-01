#!/usr/bin/env node
/**
 * The signer the load generator calls, running beside it.
 *
 *   node loadtest/signer.mjs            # 127.0.0.1:8765, one worker per core
 *
 * POST /sign        { privHex, msgHex } -> { sigHex }
 * POST /derivePub   { privHex }         -> { pubHex }
 * GET  /health                          -> ok
 *
 * WHY A SIDECAR, AND NOT SIGNING INSIDE THE LOAD GENERATOR
 *
 * This is settled, and it is settled by measurement rather than preference.
 * The retired imani-apps project spent a whole spike step on it:
 *
 *   Signing inside k6's JavaScript engine (goja): sign p99 676ms, verify p99
 *   489ms, CPU ~78% with k6 saturating 8 of 12 cores. Roughly 67x over the
 *   budget it needed to hit. Correctness was fine (12641/12641); it was simply
 *   far too slow. Recorded in that repo's loadtest/spike-0/results.md.
 *
 *   The same signing moved into a Node sidecar in cluster mode: 288270/288270
 *   signatures valid, 2401 req/s sustained, sign p99 61ms with 12 workers.
 *   Recorded in loadtest/spike-0b/results.md.
 *
 * Re-running the failed experiment to rediscover the same answer is the most
 * predictable waste available here. If signing cost ever needs to come down
 * further, that project left an escalation menu: a Unix socket transport
 * (saves ~1ms median), a per-VU sidecar (removes inter-VU queueing at ~3GB
 * RAM per 50 VUs), or a pre-signed pool for fixed-message scenarios.
 *
 * WHAT CHANGED IN THE PORT
 *
 * The original wired @noble/secp256k1 v1 by hand, assigning hmacSha256Sync and
 * sha256Sync onto secp.utils because v1's schnorr had no synchronous path
 * without them. This repo already carries @noble/curves v2, whose schnorr.sign
 * is synchronous outright, so that wiring is gone rather than carried over.
 * Everything about the topology, which is the part the spike actually proved,
 * is unchanged.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { createServer } from 'node:http'
import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'

const PORT = Number(process.env.SIGNER_PORT || 8765)
const WORKERS = Number(process.env.SIGNER_WORKERS || availableParallelism())

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('hex must be an even-length string')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function bytesToHex(bytes) {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1 << 16) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'keep-alive',
  })
  res.end(payload)
}

if (cluster.isPrimary) {
  // One process cannot serve the demand: the spike measured a single process
  // at 588 req/s with p99 159ms, where the latency was pure queueing rather
  // than signing cost. Twelve workers took the same work to 2401 req/s at
  // p99 61ms.
  console.error(`[signer] ${WORKERS} workers on 127.0.0.1:${PORT}`)
  for (let i = 0; i < WORKERS; i++) cluster.fork()
  cluster.on('exit', (worker, code, signal) => {
    // Replace rather than exit: a run that quietly loses a worker gets slower
    // and reports that slowness as though the gateway caused it.
    console.error(`[signer] worker ${worker.process.pid} died (${signal || code}), replacing`)
    cluster.fork()
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      for (const id in cluster.workers) cluster.workers[id].kill()
      process.exit(0)
    })
  }
} else {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, 'ok')

      if (req.method === 'POST' && req.url === '/sign') {
        const { privHex, msgHex } = await readJson(req)
        const sig = schnorr.sign(hexToBytes(msgHex), hexToBytes(privHex))
        return send(res, 200, { sigHex: bytesToHex(sig) })
      }

      if (req.method === 'POST' && req.url === '/derivePub') {
        const { privHex } = await readJson(req)
        return send(res, 200, { pubHex: bytesToHex(schnorr.getPublicKey(hexToBytes(privHex))) })
      }

      return send(res, 404, 'not found')
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e) })
    }
  })

  // Small JSON bodies on loopback, where Nagle's delay is pure overhead.
  server.on('connection', (sock) => sock.setNoDelay(true))
  server.listen(PORT, '127.0.0.1')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)))
  }
}
