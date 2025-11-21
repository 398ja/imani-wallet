package cash.imani.app.ui.shop

import cash.imani.identity.util.Bech32
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for merchant discovery screen.
 *
 * Manages:
 * - Nostr npub search and validation
 * - Merchant profile lookup (placeholder for Phase 2)
 * - Recent merchants list (localStorage)
 *
 * Phase 2.2 Implementation:
 * - Npub validation (Bech32 decoding)
 * - Search state management
 * - Recent merchants persistence (TODO: localStorage integration)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 2, Task 2.2
 *
 * TODO Phase 3: Integrate actual Nostr profile lookup via NostrClient
 * TODO Phase 4: QR code scanning
 */
class MerchantDiscoveryViewModel {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _searchState = MutableStateFlow<SearchState>(SearchState.Idle)
    val searchState: StateFlow<SearchState> = _searchState.asStateFlow()

    private val _recentMerchants = MutableStateFlow<List<MerchantProfile>>(emptyList())
    val recentMerchants: StateFlow<List<MerchantProfile>> = _recentMerchants.asStateFlow()

    init {
        loadRecentMerchants()
    }

    /**
     * Searches for a merchant by Nostr npub.
     *
     * Validates npub format, then queries Nostr for merchant profile.
     * On success, adds merchant to recent list and navigates to detail screen.
     *
     * @param npub Nostr public key (npub1...)
     */
    fun searchMerchant(npub: String) {
        viewModelScope.launch {
            _searchState.value = SearchState.Loading

            // Validate npub format
            val validationResult = validateNpub(npub)
            if (validationResult.isFailure) {
                _searchState.value =
                    SearchState.Error(
                        validationResult.exceptionOrNull()?.message
                            ?: "Invalid npub format",
                    )
                return@launch
            }

            // TODO Phase 3: Query Nostr for merchant profile
            // For now, simulate success
            _searchState.value = SearchState.Success(npub)

            // Add to recent merchants (placeholder data)
            addRecentMerchant(
                MerchantProfile(
                    npub = npub,
                    name = "Merchant ${npub.take(12)}...",
                    description = "Merchant profile from Nostr",
                    logo = null,
                ),
            )
        }
    }

    /**
     * Loads recent merchants from storage.
     *
     * TODO Phase 2.2: Integrate localStorage/IndexedDB for persistence
     * Currently returns empty list.
     */
    private fun loadRecentMerchants() {
        viewModelScope.launch {
            // TODO: Load from localStorage
            _recentMerchants.value = emptyList()
        }
    }

    /**
     * Adds a merchant to recent merchants list.
     *
     * Deduplicates by npub and limits to 10 most recent.
     *
     * TODO Phase 2.2: Persist to localStorage
     *
     * @param merchant Merchant profile to add
     */
    private fun addRecentMerchant(merchant: MerchantProfile) {
        viewModelScope.launch {
            val updated =
                (_recentMerchants.value + merchant)
                    .distinctBy { it.npub }
                    .takeLast(10)

            _recentMerchants.value = updated

            // TODO: Save to localStorage
        }
    }

    /**
     * Resets search state to idle.
     */
    fun resetSearchState() {
        _searchState.value = SearchState.Idle
    }
}

/**
 * Validates Nostr npub format.
 *
 * Checks:
 * 1. Starts with "npub1"
 * 2. Valid Bech32 encoding
 * 3. Decoded data is exactly 32 bytes (Nostr public key)
 *
 * @param input Npub string to validate
 * @return Result with validated npub or error
 */
fun validateNpub(input: String): Result<String> {
    // Check prefix
    if (!input.startsWith("npub1")) {
        return Result.failure(
            Exception("Invalid npub format. Must start with 'npub1'"),
        )
    }

    // Decode Bech32
    val decoded =
        try {
            Bech32.decode(input)
        } catch (e: Exception) {
            return Result.failure(
                Exception("Invalid Bech32 encoding: ${e.message}"),
            )
        }

    // Check HRP (human-readable part)
    if (decoded.first != "npub") {
        return Result.failure(
            Exception("Invalid npub prefix. Expected 'npub', got '${decoded.first}'"),
        )
    }

    // Check data length (should be 32 bytes for Nostr public key)
    if (decoded.second.size != 32) {
        return Result.failure(
            Exception("Invalid npub length. Expected 32 bytes, got ${decoded.second.size}"),
        )
    }

    return Result.success(input)
}

/**
 * Search state for merchant discovery.
 */
sealed class SearchState {
    /**
     * Idle state - no search in progress.
     */
    data object Idle : SearchState()

    /**
     * Loading state - search in progress.
     */
    data object Loading : SearchState()

    /**
     * Success state - merchant found, navigate to detail.
     *
     * @param npub Merchant npub that was found
     */
    data class Success(val npub: String) : SearchState()

    /**
     * Error state - search failed.
     *
     * @param message Error message to display
     */
    data class Error(val message: String) : SearchState()
}

/**
 * Merchant profile data.
 *
 * Lightweight model for recent merchants list.
 * Full profile is fetched when navigating to detail screen.
 *
 * Phase 3.2: Added contact info fields for profile editing
 * TODO Phase 3: Fetch from Nostr profile (NIP-01 kind:0 event)
 *
 * @param npub Merchant Nostr public key
 * @param name Merchant business name (1-100 chars)
 * @param description Short merchant description (1-500 chars)
 * @param logo URL to merchant logo (optional)
 * @param email Contact email (optional)
 * @param phone Contact phone (optional)
 * @param website Website URL (optional)
 */
data class MerchantProfile(
    val npub: String,
    val name: String,
    val description: String,
    val logo: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val website: String? = null,
)
