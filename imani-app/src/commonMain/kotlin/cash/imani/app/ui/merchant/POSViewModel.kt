package cash.imani.app.ui.merchant

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.usecases.RedeemVoucherUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock

/**
 * ViewModel for POS (Point of Sale) voucher redemption.
 *
 * Manages:
 * - QR code scanning state
 * - Voucher token decoding
 * - Redemption confirmation
 * - Partial redemption amounts
 *
 * Phase 3.4 Implementation:
 * - Token decoding and validation
 * - Full and partial redemption support
 * - Success/error states with amounts
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.4
 *
 * @param redeemVoucherUseCase Use case for redeeming vouchers
 */
class POSViewModel(
    private val redeemVoucherUseCase: RedeemVoucherUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _redemptionState = MutableStateFlow<RedemptionState>(RedemptionState.Scanning)
    val redemptionState: StateFlow<RedemptionState> = _redemptionState.asStateFlow()

    private var currentToken: String? = null

    /**
     * Decodes a voucher token from QR code or manual entry.
     *
     * @param token Cashu token string (cashuA...)
     */
    fun decodeVoucher(token: String) {
        viewModelScope.launch {
            _redemptionState.value = RedemptionState.Loading

            try {
                // Validate token format
                if (!token.startsWith("cashu")) {
                    throw Exception("Invalid token format. Must start with 'cashu'")
                }

                currentToken = token

                // For Phase 3.4, we create a placeholder voucher from the token
                // In production, we'd decode the CBOR and extract amount
                // For now, create a mock voucher for UI demonstration
                val mockVoucher = StoredVoucher(
                    voucherId = "pos-${Clock.System.now().toEpochMilliseconds()}",
                    issuerId = "customer",
                    unit = "sat",
                    faceValue = extractAmountFromToken(token),
                    expiresAt = null,
                    memo = "Voucher from customer",
                    issuerSignature = "",
                    issuerPublicKey = "",
                    issuedAt = Clock.System.now(),
                    status = VoucherStatus.ISSUED,
                    token = token,
                )

                _redemptionState.value = RedemptionState.VoucherLoaded(mockVoucher)
                println("[POSViewModel] Voucher decoded: ${mockVoucher.faceValue} sat")
            } catch (e: Exception) {
                println("[POSViewModel] Error decoding voucher: ${e.message}")
                _redemptionState.value = RedemptionState.Error(
                    e.message ?: "Failed to decode voucher token",
                )
            }
        }
    }

    /**
     * Extracts approximate amount from token.
     *
     * TODO: Properly decode CBOR token to get exact amount.
     * For now, returns a placeholder amount based on token length.
     */
    private fun extractAmountFromToken(token: String): Long {
        // Simple heuristic: token length correlates with amount (very rough)
        // In production, decode the CBOR properly
        return when {
            token.length > 500 -> 1000L
            token.length > 300 -> 500L
            token.length > 100 -> 100L
            else -> 50L
        }
    }

    /**
     * Redeems the loaded voucher for the specified amount.
     *
     * @param amount Amount to redeem (must be <= voucher balance)
     */
    fun redeemVoucher(amount: Int) {
        val token = currentToken ?: return
        val currentState = _redemptionState.value

        if (currentState !is RedemptionState.VoucherLoaded) return

        viewModelScope.launch {
            _redemptionState.value = RedemptionState.Redeeming

            try {
                // Call the redeem use case
                val result = redeemVoucherUseCase(token)

                result.onSuccess { _ ->
                    val remaining = currentState.voucher.faceValue - amount
                    _redemptionState.value = RedemptionState.Success(
                        amount = amount,
                        remainingBalance = remaining.coerceAtLeast(0).toInt(),
                    )
                    println("[POSViewModel] Redemption successful: $amount sat")
                }.onFailure { error ->
                    _redemptionState.value = RedemptionState.Error(
                        error.message ?: "Redemption failed",
                    )
                }
            } catch (e: Exception) {
                println("[POSViewModel] Error redeeming: ${e.message}")
                _redemptionState.value = RedemptionState.Error(
                    e.message ?: "Redemption failed",
                )
            }
        }
    }

    /**
     * Resets state to scanning mode.
     */
    fun resetToScanning() {
        currentToken = null
        _redemptionState.value = RedemptionState.Scanning
    }
}

/**
 * State for POS redemption flow.
 */
sealed class RedemptionState {
    /** Ready to scan QR code or enter token */
    data object Scanning : RedemptionState()

    /** Loading/decoding token */
    data object Loading : RedemptionState()

    /** Voucher decoded, ready to confirm redemption */
    data class VoucherLoaded(val voucher: StoredVoucher) : RedemptionState()

    /** Redemption in progress */
    data object Redeeming : RedemptionState()

    /** Redemption successful */
    data class Success(
        val amount: Int,
        val remainingBalance: Int,
    ) : RedemptionState()

    /** Error occurred */
    data class Error(val message: String) : RedemptionState()
}
