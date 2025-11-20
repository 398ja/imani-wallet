package cash.imani.voucher.adapter

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.repository.IdentityRepository
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository

/**
 * Factory function for creating JvmVoucherAdapter.
 *
 * **Phase 2 Status**: Placeholder implementation.
 *
 * Full VoucherService integration requires:
 * 1. WalletStorage adapter (backed by SQLDelight or similar)
 * 2. EncryptionService adapter
 * 3. IdentityKeyService adapter
 * 4. NostrGatewayService configuration
 * 5. SendService and TokenCodec from cashu-client
 *
 * See AndroidModule.kt lines 108-162 for complete integration TODO.
 *
 * For now, this function is not implemented. JvmVoucherAdapter should be
 * instantiated directly in dependency injection with a configured VoucherService.
 *
 * **Testing**: Unit tests mock VoucherService directly and don't need this factory.
 *
 * @throws NotImplementedError Always thrown - full integration pending
 */
actual fun createVoucherAdapter(
    voucherRepository: VoucherRepository,
    proofRepository: ProofRepository,
    mintApiClient: MintApiClient,
    identityRepository: IdentityRepository,
    nostrClient: NostrVoucherClient,
    cryptoAdapter: CryptoAdapter,
): VoucherAdapter {
    throw NotImplementedError(
        "JvmVoucherAdapter factory not yet implemented. " +
            "Full VoucherService integration requires WalletStorage, EncryptionService, " +
            "IdentityKeyService, and NostrGatewayService adapters. " +
            "See AndroidModule.kt lines 108-162 for integration plan. " +
            "For testing, instantiate JvmVoucherAdapter directly with mock VoucherService.",
    )
}
