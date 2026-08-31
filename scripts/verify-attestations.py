#!/usr/bin/env python3
"""
Independently verify the attestation stream, sharing NO code with the wallet.

Why this exists
---------------
`src/lib/audit.ts` and `scripts/audit-probe.mjs` share an implementation: the
probe imports the reader. So the probe can only ever confirm that the reader
agrees with itself. If `readAttestation` accepted a forgery, both would say the
stream is clean, and the earlier verification would have looked exactly as green
as it did.

This is the independent check. BIP-340 Schnorr verification is implemented here
from the specification, in pure Python, with no `@noble/curves`, no
`nostr-tools`, and no import from the wallet. Where it agrees with the reader,
the agreement means something; where it disagrees, one of them is wrong.

It re-derives the event id as well, because a signature over a hash nobody
recomputed proves only that the publisher signed *something*.

Usage:  python3 scripts/verify-attestations.py [relay-wss-url]
"""
import hashlib
import json
import ssl
import sys
import base64
import os
import socket
from urllib.parse import urlparse

# --- BIP-340, from the spec. No crypto library on this machine. ---------------
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def tagged_hash(tag: str, msg: bytes) -> bytes:
    t = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(t + t + msg).digest()


def point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0] and p1[1] != p2[1]:
        return None
    if p1 == p2:
        lam = (3 * p1[0] * p1[0] * pow(2 * p1[1], P - 2, P)) % P
    else:
        lam = ((p2[1] - p1[1]) * pow(p2[0] - p1[0], P - 2, P)) % P
    x3 = (lam * lam - p1[0] - p2[0]) % P
    return (x3, (lam * (p1[0] - x3) - p1[1]) % P)


def point_mul(p, n):
    r = None
    for i in range(256):
        if (n >> i) & 1:
            r = point_add(r, p)
        p = point_add(p, p)
    return r


def lift_x(x: int):
    if x >= P:
        return None
    y_sq = (pow(x, 3, P) + 7) % P
    y = pow(y_sq, (P + 1) // 4, P)
    if pow(y, 2, P) != y_sq:
        return None
    return (x, y if y % 2 == 0 else P - y)


def schnorr_verify(msg: bytes, pubkey: bytes, sig: bytes) -> bool:
    """BIP-340 verification, written from the spec."""
    if len(pubkey) != 32 or len(sig) != 64:
        return False
    Pt = lift_x(int.from_bytes(pubkey, 'big'))
    if Pt is None:
        return False
    r = int.from_bytes(sig[:32], 'big')
    s = int.from_bytes(sig[32:], 'big')
    if r >= P or s >= N:
        return False
    e = int.from_bytes(
        tagged_hash("BIP0340/challenge", sig[:32] + pubkey + msg), 'big') % N
    R = point_add(point_mul(G, s), point_mul(Pt, N - e))
    if R is None or R[1] % 2 != 0 or R[0] != r:
        return False
    return True


def event_id(ev: dict) -> str:
    """NIP-01 canonical serialisation. Recomputed, never trusted."""
    ser = json.dumps(
        [0, ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"], ev["content"]],
        separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(ser.encode()).hexdigest()


# --- Minimal websocket client (RFC 6455), so no `websockets` dependency ------
def ws_fetch(url: str, req: str, timeout: float = 20.0) -> list:
    u = urlparse(url)
    host = u.hostname
    port = u.port or (443 if u.scheme == "wss" else 80)
    sock = socket.create_connection((host, port), timeout=timeout)
    if u.scheme == "wss":
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.send((f"GET {u.path or '/'} HTTP/1.1\r\nHost: {host}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)
    payload = req.encode()
    header = b"\x81"
    mask = os.urandom(4)
    ln = len(payload)
    if ln < 126:
        header += bytes([0x80 | ln])
    elif ln < 65536:
        header += bytes([0x80 | 126]) + ln.to_bytes(2, 'big')
    else:
        header += bytes([0x80 | 127]) + ln.to_bytes(8, 'big')
    sock.send(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    data = buf.split(b"\r\n\r\n", 1)[1]
    messages = []
    while True:
        while len(data) < 2:
            data += sock.recv(65536)
        ln = data[1] & 127
        off = 2
        if ln == 126:
            while len(data) < 4:
                data += sock.recv(65536)
            ln = int.from_bytes(data[2:4], 'big'); off = 4
        elif ln == 127:
            while len(data) < 10:
                data += sock.recv(65536)
            ln = int.from_bytes(data[2:10], 'big'); off = 10
        while len(data) < off + ln:
            data += sock.recv(65536)
        frame, data = data[off:off + ln], data[off + ln:]
        msg = json.loads(frame.decode())
        if msg[0] == "EVENT":
            messages.append(msg[2])
        elif msg[0] == "EOSE":
            sock.close()
            return messages


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "wss://relay.staging.398ja.xyz"
    events = ws_fetch(url, json.dumps(["REQ", "indep", {"kinds": [7377], "limit": 500}]))

    good, bad = [], []
    for ev in events:
        why = None
        if event_id(ev) != ev["id"]:
            why = "id is not the hash of the canonical serialisation"
        elif not schnorr_verify(bytes.fromhex(ev["id"]),
                                bytes.fromhex(ev["pubkey"]),
                                bytes.fromhex(ev["sig"])):
            why = "BIP-340 signature does not verify"
        (bad if why else good).append((ev, why))

    print(f"relay: {url}")
    print(f"fetched {len(events)}")
    print(f"signatures verify (independent BIP-340): {len(good)}")
    for ev, why in bad:
        print(f"  INVALID {ev['id'][:12]}… {why}")

    # The reader's OTHER claims, re-derived here rather than taken from it.
    nulls = {}
    payload_bad = 0
    for ev, _ in good:
        tag = next((t[1] for t in ev["tags"] if t[0] == "n"), None)
        try:
            c = json.loads(ev["content"])
        except Exception:
            payload_bad += 1
            continue
        if not tag or c.get("nullifier") != tag or "batch" in c:
            payload_bad += 1
            continue
        nulls.setdefault(tag, []).append(ev)

    dupes = {k: v for k, v in nulls.items() if len(v) > 1}
    conflicting = {k: v for k, v in dupes.items()
                   if len({(e["pubkey"], json.loads(e["content"])["commitment"]) for e in v}) > 1}

    print(f"payload-unreadable among verified: {payload_bad}")
    print(f"distinct redemptions: {len(nulls)}")
    print(f"duplicate nullifiers: {len(dupes)}  conflicting: {len(conflicting)}")

    # Counted over events that pass BOTH signature and payload checks, which is
    # what the reader means by a stall. Counting authors of merely
    # signature-valid events gives 11 on staging rather than 9: the two refused
    # events come from two publishers who post nothing else, so they are authors
    # on the relay but not stalls in the ledger. Reported the loose way first,
    # and the difference read as a discrepancy with the reader until it was
    # chased down — it was this line, not the reader.
    stalls = {e["pubkey"] for k, v in nulls.items() for e in v}
    print(f"distinct ledger keys (stalls): {len(stalls)}")

    sys.exit(1 if bad or conflicting else 0)


if __name__ == "__main__":
    main()
