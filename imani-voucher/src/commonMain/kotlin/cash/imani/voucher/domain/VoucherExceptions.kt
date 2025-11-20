package cash.imani.voucher.domain

/**
 * Base exception for voucher-related errors.
 */
sealed class VoucherException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Exception thrown when voucher issuance fails.
 */
sealed class VoucherIssuanceException(message: String, cause: Throwable? = null) : VoucherException(message, cause) {
    /**
     * Insufficient balance to issue voucher.
     */
    class InsufficientFunds(
        requested: Long,
        available: Long,
        unit: String,
    ) : VoucherIssuanceException(
            "Insufficient funds: need $requested $unit, have $available $unit",
        )

    /**
     * Failed to swap proofs with mint.
     */
    class SwapFailed(
        message: String,
        cause: Throwable? = null,
    ) : VoucherIssuanceException(message, cause)

    /**
     * Failed to sign voucher.
     */
    class SigningFailed(
        message: String,
        cause: Throwable? = null,
    ) : VoucherIssuanceException(message, cause)

    /**
     * Failed to save voucher to storage.
     */
    class StorageFailed(
        message: String,
        cause: Throwable? = null,
    ) : VoucherIssuanceException(message, cause)

    /**
     * No active identity found for issuing voucher.
     */
    class NoActiveIdentity : VoucherIssuanceException("No active identity found. Please create or select an identity.")
}

/**
 * Exception thrown when voucher redemption fails.
 */
sealed class VoucherRedemptionException(message: String, cause: Throwable? = null) : VoucherException(message, cause) {
    /**
     * Invalid token format.
     */
    class InvalidToken(
        message: String,
        cause: Throwable? = null,
    ) : VoucherRedemptionException(message, cause)

    /**
     * Voucher has already been redeemed.
     */
    class AlreadyRedeemed(
        voucherId: String,
    ) : VoucherRedemptionException("Voucher has already been redeemed: $voucherId")

    /**
     * Voucher has expired.
     */
    class Expired(
        voucherId: String,
        expiryDate: Long,
    ) : VoucherRedemptionException("Voucher expired on $expiryDate: $voucherId")

    /**
     * Voucher signature is invalid.
     */
    class InvalidSignature(
        voucherId: String,
    ) : VoucherRedemptionException("Invalid voucher signature: $voucherId")

    /**
     * Voucher requires P2PK signature but none provided.
     */
    class SignatureRequired(
        voucherId: String,
    ) : VoucherRedemptionException("Voucher requires P2PK signature: $voucherId")

    /**
     * Failed to check proof states with mint.
     */
    class StateCheckFailed(
        message: String,
        cause: Throwable? = null,
    ) : VoucherRedemptionException(message, cause)

    /**
     * Failed to import proofs to wallet.
     */
    class ImportFailed(
        message: String,
        cause: Throwable? = null,
    ) : VoucherRedemptionException(message, cause)

    companion object {
        fun alreadyRedeemed(voucherId: String) = AlreadyRedeemed(voucherId)
    }
}

/**
 * Exception thrown when Nostr backup operation fails.
 */
class BackupException(
    message: String,
    cause: Throwable? = null,
) : VoucherException(message, cause)

/**
 * Exception thrown when Nostr restore operation fails.
 */
class RestoreException(
    message: String,
    cause: Throwable? = null,
) : VoucherException(message, cause)
