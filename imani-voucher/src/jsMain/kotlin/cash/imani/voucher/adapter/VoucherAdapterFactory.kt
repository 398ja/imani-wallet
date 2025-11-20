package cash.imani.voucher.adapter

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.usecases.IssueVoucherUseCase
import cash.imani.voucher.usecases.RedeemVoucherUseCase

/**
 * JS platform implementation of VoucherAdapter factory.
 *
 * Creates a WebVoucherAdapter that:
 * - Delegates to existing Kotlin/JS use cases (IssueVoucherUseCase, RedeemVoucherUseCase)
 * - Stores vouchers in IndexedDB via VoucherRepository
 * - Backs up to Nostr relays using nostr-tools library
 * - Implements crypto using Web Crypto API
 *
 * **Architecture**: ~70% code reuse from existing KMP use cases, ~30% web-specific (storage, crypto)
 *
 * Browser Requirements:
 * - IndexedDB support (Chrome 24+, Firefox 16+, Safari 10+)
 * - WebSocket support for Nostr relays
 * - Web Crypto API for signature verification
 *
 * @see WebVoucherAdapter
 */
actual fun createVoucherAdapter(
    issueVoucherUseCase: IssueVoucherUseCase,
    redeemVoucherUseCase: RedeemVoucherUseCase,
    voucherRepository: VoucherRepository,
    nostrClient: NostrVoucherClient,
    cryptoAdapter: CryptoAdapter,
): VoucherAdapter {
    return WebVoucherAdapter(
        issueVoucherUseCase = issueVoucherUseCase,
        redeemVoucherUseCase = redeemVoucherUseCase,
        voucherRepository = voucherRepository,
        nostrClient = nostrClient,
        cryptoAdapter = cryptoAdapter,
    )
}
