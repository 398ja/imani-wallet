package cash.imani.app.ui.shop

import cash.imani.voucher.domain.LightningInvoice
import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.usecases.CheckInvoicePaidUseCase
import cash.imani.voucher.usecases.CreateLightningInvoiceUseCase
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for purchase voucher screen.
 *
 * Manages the complete Lightning payment flow:
 * 1. Load offer details
 * 2. Confirm purchase
 * 3. Generate Lightning invoice (NUT-04)
 * 4. Poll for payment confirmation
 * 5. Issue voucher after payment
 * 6. Show success screen
 *
 * Phase 2.4 Implementation:
 * - State machine: Confirm → PaymentPending → Success/Error
 * - Invoice generation using CreateLightningInvoiceUseCase
 * - Payment polling using CheckInvoicePaidUseCase (2s interval)
 * - Voucher issuance using IssueVoucherUseCase
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.4
 *
 * @param createInvoiceUseCase Use case for generating Lightning invoices
 * @param checkInvoicePaidUseCase Use case for checking invoice payment status
 * @param issueVoucherUseCase Use case for issuing vouchers after payment
 */
class PurchaseViewModel(
    private val createInvoiceUseCase: CreateLightningInvoiceUseCase,
    private val checkInvoicePaidUseCase: CheckInvoicePaidUseCase,
    private val issueVoucherUseCase: IssueVoucherUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _purchaseState = MutableStateFlow<PurchaseState>(PurchaseState.Loading)
    val purchaseState: StateFlow<PurchaseState> = _purchaseState.asStateFlow()

    private var paymentPollingJob: Job? = null
    private var currentOffer: MerchantOffer? = null
    private var currentInvoice: LightningInvoice? = null

    /**
     * Loads offer details for purchase.
     *
     * TODO Phase 3: Fetch actual offer from Nostr using DiscoverMerchantOffersUseCase.
     * For Phase 2, creates placeholder offer.
     *
     * @param offerId Offer ID to load
     */
    fun loadOffer(offerId: String) {
        viewModelScope.launch {
            _purchaseState.value = PurchaseState.Loading

            try {
                // TODO Phase 3: Load actual offer from Nostr
                // For Phase 2, create placeholder offer
                val offer =
                    MerchantOffer(
                        offerId = offerId,
                        merchantId = "merchant-npub",
                        amount = 1000,
                        unit = "sat",
                        price = 900,
                        description = "Test Voucher Offer",
                        mintUrl = "http://localhost:7777",
                        expiresAt = null,
                        createdAt = kotlinx.datetime.Clock.System.now(),
                        status = cash.imani.voucher.domain.OfferStatus.ACTIVE,
                    )

                currentOffer = offer
                _purchaseState.value = PurchaseState.Confirm(offer)
            } catch (e: Exception) {
                _purchaseState.value = PurchaseState.Error("Failed to load offer: ${e.message}")
            }
        }
    }

    /**
     * Generates Lightning invoice for the offer.
     *
     * Uses CreateLightningInvoiceUseCase to request invoice from mint (NUT-04).
     * Transitions to PaymentPending state and starts polling.
     */
    fun generateInvoice() {
        val offer = currentOffer ?: return

        viewModelScope.launch {
            _purchaseState.value = PurchaseState.Loading

            try {
                val result =
                    createInvoiceUseCase(
                        amount = offer.price.toInt(),
                        mintUrl = offer.mintUrl,
                        unit = offer.unit,
                    )

                result.onSuccess { invoice ->
                    currentInvoice = invoice
                    _purchaseState.value = PurchaseState.PaymentPending(invoice)
                    startPaymentPolling()
                }.onFailure { error ->
                    _purchaseState.value =
                        PurchaseState.Error("Failed to generate invoice: ${error.message}")
                }
            } catch (e: Exception) {
                _purchaseState.value = PurchaseState.Error("Failed to generate invoice: ${e.message}")
            }
        }
    }

    /**
     * Starts polling for invoice payment confirmation.
     *
     * Polls CheckInvoicePaidUseCase every 2 seconds until:
     * - Payment confirmed → issue voucher
     * - Invoice expired → show error
     * - Max retries reached (150 retries = 5 minutes)
     */
    private fun startPaymentPolling() {
        val invoice = currentInvoice ?: return
        val offer = currentOffer ?: return

        paymentPollingJob?.cancel()
        paymentPollingJob =
            viewModelScope.launch {
                var retries = 0
                val maxRetries = 150 // 5 minutes at 2s intervals

                while (retries < maxRetries) {
                    delay(2000) // Poll every 2 seconds

                    try {
                        val result =
                            checkInvoicePaidUseCase(
                                quoteId = invoice.quoteId,
                                mintUrl = offer.mintUrl,
                            )

                        result.onSuccess { isPaid ->
                            if (isPaid) {
                                println("[PurchaseViewModel] Payment confirmed!")
                                issueVoucher(offer, invoice)
                                return@launch
                            }
                        }.onFailure { error ->
                            println(
                                "[PurchaseViewModel] Error checking payment: ${error.message}",
                            )
                        }
                    } catch (e: Exception) {
                        println("[PurchaseViewModel] Exception checking payment: ${e.message}")
                    }

                    retries++
                }

                // Timeout reached
                _purchaseState.value =
                    PurchaseState.Error(
                        "Payment timeout. Invoice expired after 5 minutes.",
                    )
            }
    }

    /**
     * Issues voucher after payment confirmation.
     *
     * Uses IssueVoucherUseCase to create voucher from paid proofs.
     * Transitions to Success state with voucher details.
     *
     * @param offer Merchant offer being purchased
     * @param invoice Lightning invoice that was paid
     */
    @Suppress("UNUSED_PARAMETER")
    private fun issueVoucher(
        offer: MerchantOffer,
        invoice: LightningInvoice,
    ) {
        viewModelScope.launch {
            try {
                val request =
                    IssueVoucherRequest(
                        amount = offer.amount,
                        unit = offer.unit,
                        mintUrl = offer.mintUrl,
                        memo = offer.description,
                        lockToPubkey = null, // TODO: Lock to customer pubkey if desired
                    )

                val result = issueVoucherUseCase(request)

                result.onSuccess { issueResult ->
                    _purchaseState.value =
                        PurchaseState.Success(
                            voucher = issueResult.voucher,
                            token = issueResult.token,
                        )
                }.onFailure { error ->
                    _purchaseState.value =
                        PurchaseState.Error("Payment successful but voucher issuance failed: ${error.message}")
                }
            } catch (e: Exception) {
                _purchaseState.value =
                    PurchaseState.Error("Payment successful but voucher issuance failed: ${e.message}")
            }
        }
    }

    /**
     * Handles payment confirmation callback.
     *
     * Called from LightningInvoiceDisplay when payment is detected.
     * Stops polling and issues voucher.
     */
    fun handlePaymentConfirmed() {
        paymentPollingJob?.cancel()

        val offer = currentOffer ?: return
        val invoice = currentInvoice ?: return

        issueVoucher(offer, invoice)
    }

    /**
     * Retries the purchase flow from confirmation state.
     */
    fun retry() {
        currentOffer?.let { offer ->
            _purchaseState.value = PurchaseState.Confirm(offer)
        }
    }

    /**
     * Cancels payment polling and cleans up resources.
     */
    fun cancel() {
        paymentPollingJob?.cancel()
        currentOffer = null
        currentInvoice = null
    }
}

/**
 * Purchase state machine.
 */
sealed class PurchaseState {
    /**
     * Loading state - fetching offer details or generating invoice.
     */
    data object Loading : PurchaseState()

    /**
     * Confirm purchase state - show offer details and confirm button.
     *
     * @param offer Merchant offer to purchase
     */
    data class Confirm(val offer: MerchantOffer) : PurchaseState()

    /**
     * Payment pending state - show Lightning invoice and wait for payment.
     *
     * @param invoice Lightning invoice for payment
     */
    data class PaymentPending(val invoice: LightningInvoice) : PurchaseState()

    /**
     * Success state - payment confirmed and voucher issued.
     *
     * @param voucher Issued voucher
     * @param token Cashu token string
     */
    data class Success(
        val voucher: StoredVoucher,
        val token: String,
    ) : PurchaseState()

    /**
     * Error state - something went wrong.
     *
     * @param message Error message to display
     */
    data class Error(val message: String) : PurchaseState()
}
