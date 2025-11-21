package cash.imani.app.ui.shop

import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.OfferStatus
import cash.imani.voucher.usecases.DiscoverMerchantOffersUseCase
import cash.imani.voucher.usecases.DiscoverOffersFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for merchant detail screen.
 *
 * Manages:
 * - Merchant profile loading (Nostr NIP-01 kind:0 event)
 * - Merchant offers discovery (Nostr NIP-33 kind:30078 events)
 * - Favorite merchant toggling
 * - Copy npub, show QR actions
 *
 * Phase 2.3 Implementation:
 * - Placeholder merchant profile (TODO Phase 3: Nostr profile lookup)
 * - Discover offers using DiscoverMerchantOffersUseCase
 * - Filter to show ACTIVE offers only
 * - Favorite toggling (in-memory for now)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.3
 *
 * TODO Phase 3:
 * - Fetch actual merchant profile from Nostr (NIP-01 kind:0)
 * - Persist favorites to localStorage
 * - Cache merchant profiles
 *
 * @param discoverOffersUseCase Use case for discovering merchant offers
 */
class MerchantDetailViewModel(
    private val discoverOffersUseCase: DiscoverMerchantOffersUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _merchantProfile = MutableStateFlow<MerchantProfile?>(null)
    val merchantProfile: StateFlow<MerchantProfile?> = _merchantProfile.asStateFlow()

    private val _offers = MutableStateFlow<List<MerchantOffer>>(emptyList())
    val offers: StateFlow<List<MerchantOffer>> = _offers.asStateFlow()

    private val _isFavorite = MutableStateFlow(false)
    val isFavorite: StateFlow<Boolean> = _isFavorite.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /**
     * Loads merchant profile from Nostr.
     *
     * TODO Phase 3: Query Nostr for NIP-01 kind:0 event (merchant profile).
     * For Phase 2, creates placeholder profile from npub.
     *
     * @param merchantNpub Merchant's Nostr public key (npub format)
     */
    fun loadMerchant(merchantNpub: String) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null

            try {
                // TODO Phase 3: Query Nostr for merchant profile
                // For Phase 2, create placeholder profile
                _merchantProfile.value =
                    MerchantProfile(
                        npub = merchantNpub,
                        name = "Merchant ${merchantNpub.take(12)}...",
                        description =
                            "This merchant is selling vouchers. " +
                                "Merchant profiles will be loaded from Nostr in Phase 3.",
                        logo = null,
                    )

                // Check if merchant is favorited
                // TODO Phase 3: Load from localStorage
                _isFavorite.value = false
            } catch (e: Exception) {
                _error.value = "Failed to load merchant profile: ${e.message}"
            } finally {
                _loading.value = false
            }
        }
    }

    /**
     * Loads merchant offers from Nostr.
     *
     * Queries Nostr relays for active offers published by the merchant.
     * Filters to show only ACTIVE (non-expired) offers.
     *
     * @param merchantNpub Merchant's Nostr public key
     */
    fun loadOffers(merchantNpub: String) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null

            try {
                val result =
                    discoverOffersUseCase(
                        DiscoverOffersFilter(
                            merchantId = merchantNpub,
                            status = OfferStatus.ACTIVE,
                            includeExpired = false,
                        ),
                    )

                result.onSuccess { offers ->
                    _offers.value = offers
                    println(
                        "[MerchantDetailViewModel] Loaded ${offers.size} active offers from merchant $merchantNpub",
                    )
                }.onFailure { error ->
                    _error.value = "Failed to load offers: ${error.message}"
                }
            } catch (e: Exception) {
                _error.value = "Failed to load offers: ${e.message}"
            } finally {
                _loading.value = false
            }
        }
    }

    /**
     * Toggles merchant favorite status.
     *
     * TODO Phase 3: Persist to localStorage.
     * For Phase 2, toggles in-memory state only.
     */
    fun toggleFavorite() {
        viewModelScope.launch {
            _isFavorite.value = !_isFavorite.value

            // TODO Phase 3: Persist to localStorage
            println(
                "[MerchantDetailViewModel] Merchant favorite toggled: ${_isFavorite.value}",
            )
        }
    }

    /**
     * Clears error state.
     */
    fun clearError() {
        _error.value = null
    }
}
