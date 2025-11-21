package cash.imani.app.ui.merchant

import cash.imani.identity.repository.IdentityRepository
import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.network.MintConfig
import cash.imani.voucher.usecases.CreateOfferUseCase
import cash.imani.voucher.usecases.PublishOfferToNostrUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.time.Duration.Companion.days

/**
 * ViewModel for creating merchant voucher offers.
 *
 * Manages:
 * - Offer form validation
 * - Offer creation via CreateOfferUseCase
 * - Offer publishing to Nostr via PublishOfferToNostrUseCase
 *
 * Phase 3.3 Implementation:
 * - Form state and validation
 * - Create + publish flow
 * - Success/error states
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.3
 *
 * @param identityRepository Repository for fetching merchant identity
 * @param createOfferUseCase Use case for creating offers
 * @param publishOfferUseCase Use case for publishing to Nostr
 */
class CreateOfferViewModel(
    private val identityRepository: IdentityRepository,
    private val createOfferUseCase: CreateOfferUseCase,
    private val publishOfferUseCase: PublishOfferToNostrUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _createState = MutableStateFlow<CreateOfferState>(CreateOfferState.Idle)
    val createState: StateFlow<CreateOfferState> = _createState.asStateFlow()

    private val _validationErrors = MutableStateFlow<OfferValidationErrors>(OfferValidationErrors())
    val validationErrors: StateFlow<OfferValidationErrors> = _validationErrors.asStateFlow()

    /**
     * Creates and publishes a new offer.
     *
     * @param name Voucher/offer name (used as description)
     * @param description Optional additional description
     * @param price Price in sats
     * @param validityDays Days until offer expires
     * @param allowPartialRedemption Whether partial redemption is allowed (metadata)
     */
    fun createOffer(
        name: String,
        description: String,
        price: Int,
        validityDays: Int,
        allowPartialRedemption: Boolean,
    ) {
        // Validate
        val errors = validateOffer(name, price)
        _validationErrors.value = errors

        if (errors.hasErrors()) {
            _createState.value = CreateOfferState.ValidationFailed
            return
        }

        viewModelScope.launch {
            _createState.value = CreateOfferState.Creating

            try {
                // Get merchant identity
                val identities = identityRepository.listIdentities().getOrThrow()
                val merchantIdentity =
                    identities.firstOrNull()
                        ?: throw Exception("No merchant identity found. Create one first.")

                // Build offer description
                val fullDescription =
                    if (description.isNotBlank()) {
                        "$name - $description"
                    } else {
                        name
                    }

                // Create offer
                val offer =
                    createOfferUseCase(
                        merchantId = merchantIdentity.toNpub(),
                        amount = price.toLong(), // For simplicity, face value = price
                        price = price.toLong(),
                        description = fullDescription,
                        mintUrl = MintConfig.LOCAL_MINT, // TODO: User-selectable mint
                        unit = "sat",
                        expiryDuration = validityDays.days,
                        metadata =
                            mapOf(
                                "allowPartialRedemption" to allowPartialRedemption.toString(),
                                "name" to name,
                            ),
                    ).getOrThrow()

                println("[CreateOfferViewModel] Offer created: ${offer.offerId}")

                // Publish to Nostr
                _createState.value = CreateOfferState.Publishing

                publishOfferUseCase(offer).getOrThrow()

                println("[CreateOfferViewModel] Offer published to Nostr")

                _createState.value = CreateOfferState.Success(offer)
            } catch (e: Exception) {
                println("[CreateOfferViewModel] Error creating offer: ${e.message}")
                _createState.value = CreateOfferState.Error(e.message ?: "Failed to create offer")
            }
        }
    }

    /**
     * Validates offer parameters.
     */
    private fun validateOffer(
        name: String,
        price: Int,
    ): OfferValidationErrors {
        val nameError =
            when {
                name.isBlank() -> "Voucher name is required"
                name.length > 100 -> "Name must be 100 characters or less"
                else -> null
            }

        val priceError =
            when {
                price <= 0 -> "Price must be greater than 0"
                price > 1_000_000 -> "Price cannot exceed 1,000,000 sats"
                else -> null
            }

        return OfferValidationErrors(
            nameError = nameError,
            priceError = priceError,
        )
    }

    /**
     * Clears create state after acknowledgment.
     */
    fun clearState() {
        _createState.value = CreateOfferState.Idle
        _validationErrors.value = OfferValidationErrors()
    }
}

/**
 * State for offer creation flow.
 */
sealed class CreateOfferState {
    data object Idle : CreateOfferState()

    data object ValidationFailed : CreateOfferState()

    data object Creating : CreateOfferState()

    data object Publishing : CreateOfferState()

    data class Success(val offer: MerchantOffer) : CreateOfferState()

    data class Error(val message: String) : CreateOfferState()
}

/**
 * Validation errors for offer form.
 */
data class OfferValidationErrors(
    val nameError: String? = null,
    val priceError: String? = null,
) {
    fun hasErrors(): Boolean = nameError != null || priceError != null
}
