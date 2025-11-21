package cash.imani.app.ui.shop

import cash.imani.app.repository.FavoritesRepository
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
 * - Favorite merchant toggling (persisted via FavoritesRepository)
 * - Copy npub, show QR actions
 *
 * Phase 4.2 Update:
 * - Integrated FavoritesRepository for persistent favorites
 *
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.2
 *
 * @param discoverOffersUseCase Use case for discovering merchant offers
 * @param favoritesRepository Repository for managing favorites
 */
class MerchantDetailViewModel(
    private val discoverOffersUseCase: DiscoverMerchantOffersUseCase,
    private val favoritesRepository: FavoritesRepository,
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

                // Check if merchant is favorited (Phase 4.2)
                _isFavorite.value = favoritesRepository.isFavorite(merchantNpub)
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
     * Phase 4.2: Persisted via FavoritesRepository.
     */
    fun toggleFavorite() {
        val npub = _merchantProfile.value?.npub ?: return
        viewModelScope.launch {
            _isFavorite.value = favoritesRepository.toggleFavorite(npub)
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
