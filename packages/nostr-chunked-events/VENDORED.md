# Vendored copy

- **Source:** https://github.com/398ja/nostr-chunked-events, PR #1 (`feat/reconcile-hardened`), commit `c0d73e70d2ff7a3d68d70f897d44460b066d48c2`, package version 0.3.0.
- **What was copied:** `src/*.ts`, `package.json` and `README.md`, unmodified. `LICENSE` is the MIT licence that `package.json` declares. Upstream ships no LICENSE file at that commit, so this is a copy of the wallet's own MIT licence (same owner).
- **Previously:** imani-apps `packages/nostr-chunked-events` 0.2.0 (`7e7b3fc`), replaced in #206. Where 0.2.0 and 0.3.0 differ, the wallet follows 0.3.0:
  - `createSnapshotChunks`;
  - payload_hash over the chunk plaintext, verified after decrypting;
  - `allowIdenticalDuplicates`;
  - 40,960-byte chunks for strfry.
- **The wallet imports only through `wallet-entry.ts`.** Every name it re-exports is exported from v0.3.0's root index.
- **To switch to the published package:**
  1. Add `nostr-chunked-events@^0.3.0` to dependencies.
  2. Delete the `nostr-chunked-events` alias in `vite.config.ts` and `tsconfig.app.json`.
  3. Delete this directory.
