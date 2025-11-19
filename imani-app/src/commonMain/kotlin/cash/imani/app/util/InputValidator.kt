package cash.imani.app.util

/**
 * Input validation utilities for user inputs across the application.
 *
 * Provides comprehensive validation for:
 * - Identity labels
 * - Mnemonic phrases
 * - Nsec keys
 * - Voucher amounts
 * - URLs (mint and relay)
 * - Memos and descriptions
 *
 * All validation methods return ValidationResult with success/error state
 * and user-friendly error messages.
 *
 * Security Features:
 * - Prevents injection attacks via input sanitization
 * - Enforces length limits to prevent DoS
 * - Validates format to prevent malformed data
 * - Clear error messages for user feedback
 */
object InputValidator {
    /**
     * Validates an identity label.
     *
     * Requirements:
     * - Not blank
     * - Length between 1-100 characters (after trimming)
     * - No leading/trailing whitespace in result
     *
     * @param label User input label
     * @return ValidationResult with trimmed label or error
     */
    fun validateLabel(label: String): ValidationResult<String> {
        val trimmed = label.trim()

        return when {
            trimmed.isEmpty() ->
                ValidationResult.Error("Label cannot be empty")

            trimmed.length > 100 ->
                ValidationResult.Error("Label must be 100 characters or less")

            trimmed.length < 1 ->
                ValidationResult.Error("Label must be at least 1 character")

            else ->
                ValidationResult.Success(trimmed)
        }
    }

    /**
     * Validates a BIP39 mnemonic phrase format.
     *
     * Requirements:
     * - Not blank
     * - Contains 12 or 24 words
     * - Only alphanumeric words separated by spaces
     *
     * Note: This validates format only. Use Bip39Adapter.validateMnemonic()
     * for cryptographic validation.
     *
     * @param mnemonic User input mnemonic phrase
     * @return ValidationResult with trimmed/normalized mnemonic or error
     */
    fun validateMnemonicFormat(mnemonic: String): ValidationResult<String> {
        val trimmed = mnemonic.trim().lowercase()

        if (trimmed.isEmpty()) {
            return ValidationResult.Error("Recovery phrase cannot be empty")
        }

        // Normalize whitespace (replace multiple spaces with single space)
        val normalized = trimmed.replace(Regex("\\s+"), " ")
        val words = normalized.split(" ")

        return when {
            words.size !in listOf(12, 24) ->
                ValidationResult.Error(
                    "Recovery phrase must be 12 or 24 words (found ${words.size})",
                )

            words.any { !it.matches(Regex("^[a-z]+$")) } ->
                ValidationResult.Error("Recovery phrase must contain only lowercase words")

            else ->
                ValidationResult.Success(normalized)
        }
    }

    /**
     * Validates an nsec (Nostr private key) format.
     *
     * Requirements:
     * - Starts with "nsec1"
     * - Length appropriate for Bech32 encoding
     * - Contains only valid Bech32 characters
     *
     * @param nsec User input nsec key
     * @return ValidationResult with trimmed nsec or error
     */
    fun validateNsecFormat(nsec: String): ValidationResult<String> {
        val trimmed = nsec.trim()

        return when {
            trimmed.isEmpty() ->
                ValidationResult.Error("Private key cannot be empty")

            !trimmed.startsWith("nsec1") ->
                ValidationResult.Error("Private key must start with 'nsec1'")

            trimmed.length < 60 ->
                ValidationResult.Error("Private key is too short (expected ~63 characters)")

            trimmed.length > 70 ->
                ValidationResult.Error("Private key is too long (expected ~63 characters)")

            !trimmed.matches(Regex("^nsec1[023456789acdefghjklmnpqrstuvwxyz]+$")) ->
                ValidationResult.Error("Private key contains invalid characters")

            else ->
                ValidationResult.Success(trimmed)
        }
    }

    /**
     * Validates a voucher amount.
     *
     * Requirements:
     * - Positive integer (> 0)
     * - Within reasonable bounds (1-21M BTC in sats)
     *
     * @param amount User input amount as string
     * @return ValidationResult with parsed amount or error
     */
    fun validateAmount(amount: String): ValidationResult<Long> {
        val trimmed = amount.trim()

        if (trimmed.isEmpty()) {
            return ValidationResult.Error("Amount cannot be empty")
        }

        val parsed = trimmed.toLongOrNull()

        return when {
            parsed == null ->
                ValidationResult.Error("Amount must be a valid number")

            parsed <= 0 ->
                ValidationResult.Error("Amount must be greater than 0")

            parsed > 2_100_000_000_000_000 -> // 21M BTC in sats
                ValidationResult.Error("Amount exceeds maximum (21M BTC)")

            else ->
                ValidationResult.Success(parsed)
        }
    }

    /**
     * Validates a URL (for mints, relays, etc.).
     *
     * Requirements:
     * - Valid URL format
     * - HTTPS protocol (unless localhost for dev)
     * - Reasonable length
     *
     * @param url User input URL
     * @param allowHttp Allow HTTP for localhost/development (default: false)
     * @return ValidationResult with trimmed URL or error
     */
    fun validateUrl(
        url: String,
        allowHttp: Boolean = false,
    ): ValidationResult<String> {
        val trimmed = url.trim()

        return when {
            trimmed.isEmpty() ->
                ValidationResult.Error("URL cannot be empty")

            trimmed.length > 2048 ->
                ValidationResult.Error("URL is too long (max 2048 characters)")

            !trimmed.startsWith("http://") && !trimmed.startsWith("https://") ->
                ValidationResult.Error("URL must start with http:// or https://")

            trimmed.startsWith("http://") && !allowHttp && !isLocalhost(trimmed) ->
                ValidationResult.Error("HTTPS is required for security (HTTP only allowed for localhost)")

            !isValidUrlFormat(trimmed) ->
                ValidationResult.Error("Invalid URL format")

            else ->
                ValidationResult.Success(trimmed)
        }
    }

    /**
     * Validates a memo or description field.
     *
     * Requirements:
     * - Optional (can be empty)
     * - Max length enforced
     * - No special control characters
     *
     * @param memo User input memo
     * @param maxLength Maximum allowed length (default: 500)
     * @return ValidationResult with trimmed memo or error
     */
    fun validateMemo(
        memo: String,
        maxLength: Int = 500,
    ): ValidationResult<String> {
        val trimmed = memo.trim()

        return when {
            trimmed.length > maxLength ->
                ValidationResult.Error("Memo must be $maxLength characters or less")

            trimmed.contains(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]")) ->
                ValidationResult.Error("Memo contains invalid control characters")

            else ->
                ValidationResult.Success(trimmed)
        }
    }

    /**
     * Checks if URL is localhost.
     */
    private fun isLocalhost(url: String): Boolean {
        val lower = url.lowercase()
        return lower.contains("://localhost") ||
            lower.contains("://127.0.0.1") ||
            lower.contains("://[::1]")
    }

    /**
     * Basic URL format validation.
     */
    private fun isValidUrlFormat(url: String): Boolean {
        // Basic validation - must have protocol and domain
        val pattern = Regex("^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$")
        return pattern.matches(url)
    }
}

/**
 * Result of input validation.
 */
sealed class ValidationResult<out T> {
    /**
     * Validation succeeded with clean value.
     */
    data class Success<T>(val value: T) : ValidationResult<T>()

    /**
     * Validation failed with error message.
     */
    data class Error(val message: String) : ValidationResult<Nothing>()

    /**
     * Returns true if validation succeeded.
     */
    fun isSuccess(): Boolean = this is Success

    /**
     * Returns true if validation failed.
     */
    fun isError(): Boolean = this is Error

    /**
     * Gets the success value or null.
     */
    fun getOrNull(): T? = if (this is Success) value else null

    /**
     * Gets the error message or null.
     */
    fun getErrorOrNull(): String? = if (this is Error) message else null
}
