package cash.imani.voucher.adapter

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.repository.IdentityRepository
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository

/**
 * JS platform implementation of VoucherAdapter factory.
 *
 * Creates a WebVoucherAdapter with full business logic implementation:
 * - Proof selection and swap operations with Cashu mint
 * - P2PK secret generation (NUT-11)
 * - Token encoding (V4 CBOR + Bech32)
 * - Voucher signing with Schnorr signatures
 * - IndexedDB storage for browser persistence
 * - Nostr relay backup using nostr-tools library
 * - Web Crypto API for cryptographic operations
 *
 * **Phase 2.4.1 Refactoring**: WebVoucherAdapter contains IssueVoucherUseCase business logic.
 * **Phase 2.4.2 Refactoring**: WebVoucherAdapter contains RedeemVoucherUseCase business logic.
 * Use cases are now thin wrappers that delegate to this adapter.
 *
 * Browser Requirements:
 * - IndexedDB support (Chrome 24+, Firefox 16+, Safari 10+)
 * - WebSocket support for Nostr relays
 * - Web Crypto API for cryptographic operations
 *
 * @see WebVoucherAdapter
 */
actual fun createVoucherAdapter(
    voucherRepository: VoucherRepository,
    proofRepository: ProofRepository,
    mintApiClient: MintApiClient,
    identityRepository: IdentityRepository,
    nostrClient: NostrVoucherClient,
    cryptoAdapter: CryptoAdapter,
): VoucherAdapter {
    return WebVoucherAdapter(
        voucherRepository = voucherRepository,
        proofRepository = proofRepository,
        mintApiClient = mintApiClient,
        identityRepository = identityRepository,
        nostrClient = nostrClient,
        cryptoAdapter = cryptoAdapter,
    )
}
