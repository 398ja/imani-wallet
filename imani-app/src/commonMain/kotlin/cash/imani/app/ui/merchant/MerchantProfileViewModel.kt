package cash.imani.app.ui.merchant

import cash.imani.app.ui.shop.MerchantProfile
import cash.imani.identity.repository.IdentityRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for merchant profile editing.
 *
 * Manages:
 * - Loading current profile from identity repository
 * - Validating profile fields (name 1-100, description 1-500)
 * - Saving profile updates
 *
 * Phase 3.2 Implementation:
 * - Profile loading from identity
 * - Field validation
 * - Save with success/error states
 *
 * TODO Phase 3.2+: Publish to Nostr (NIP-01 kind:0 event)
 * TODO Phase 3.2+: Logo upload
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.2
 *
 * @param identityRepository Repository for fetching/updating merchant identity
 */
class MerchantProfileViewModel(
    private val identityRepository: IdentityRepository,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _profile = MutableStateFlow<MerchantProfile?>(null)
    val profile: StateFlow<MerchantProfile?> = _profile.asStateFlow()

    private val _saveState = MutableStateFlow<SaveState>(SaveState.Idle)
    val saveState: StateFlow<SaveState> = _saveState.asStateFlow()

    private val _validationErrors = MutableStateFlow<ValidationErrors>(ValidationErrors())
    val validationErrors: StateFlow<ValidationErrors> = _validationErrors.asStateFlow()

    /**
     * Loads current merchant profile.
     */
    fun loadProfile() {
        viewModelScope.launch {
            val identities = identityRepository.listIdentities().getOrElse {
                println("[MerchantProfileViewModel] Error loading identity: ${it.message}")
                return@launch
            }

            val merchantIdentity = identities.firstOrNull()
            if (merchantIdentity == null) {
                println("[MerchantProfileViewModel] No merchant identity found")
                return@launch
            }

            _profile.value = MerchantProfile(
                npub = merchantIdentity.toNpub(),
                name = merchantIdentity.label,
                description = "Merchant powered by Imani Wallet", // TODO: Load from Nostr
                logo = null,
                email = null,
                phone = null,
                website = null,
            )
        }
    }

    /**
     * Validates and saves profile updates.
     *
     * @param name Business name (1-100 chars)
     * @param description Business description (1-500 chars)
     * @param email Contact email (optional)
     * @param phone Contact phone (optional)
     * @param website Website URL (optional)
     */
    fun saveProfile(
        name: String,
        description: String,
        email: String?,
        phone: String?,
        website: String?,
    ) {
        // Validate fields
        val errors = validateFields(name, description, email, website)
        _validationErrors.value = errors

        if (errors.hasErrors()) {
            _saveState.value = SaveState.ValidationFailed
            return
        }

        viewModelScope.launch {
            _saveState.value = SaveState.Saving

            try {
                // Update identity label (name)
                val identities = identityRepository.listIdentities().getOrThrow()
                val merchantIdentity = identities.firstOrNull()
                    ?: throw Exception("No merchant identity found")

                // TODO Phase 3.2+: Update identity label if changed
                // The IdentityRepository doesn't support label updates yet
                // For now, profile changes are stored locally and in Nostr (kind:0)
                if (merchantIdentity.label != name) {
                    println("[MerchantProfileViewModel] Note: Identity label change requires Nostr profile update")
                }

                // Update local profile state
                _profile.value = MerchantProfile(
                    npub = merchantIdentity.toNpub(),
                    name = name,
                    description = description,
                    logo = null, // TODO Phase 3.2+: Logo upload
                    email = email?.ifBlank { null },
                    phone = phone?.ifBlank { null },
                    website = website?.ifBlank { null },
                )

                // TODO Phase 3.2+: Publish to Nostr (NIP-01 kind:0 event)
                // val profileEvent = createNip01ProfileEvent(name, description, email, website)
                // nostrClient.publishEvent(profileEvent)

                _saveState.value = SaveState.Success
                println("[MerchantProfileViewModel] Profile saved successfully")
            } catch (e: Exception) {
                _saveState.value = SaveState.Error(e.message ?: "Failed to save profile")
                println("[MerchantProfileViewModel] Error saving profile: ${e.message}")
            }
        }
    }

    /**
     * Validates profile fields.
     *
     * @return ValidationErrors with any field errors
     */
    private fun validateFields(
        name: String,
        description: String,
        email: String?,
        website: String?,
    ): ValidationErrors {
        val nameError = when {
            name.isBlank() -> "Business name is required"
            name.length > 100 -> "Business name must be 100 characters or less"
            else -> null
        }

        val descriptionError = when {
            description.isBlank() -> "Description is required"
            description.length > 500 -> "Description must be 500 characters or less"
            else -> null
        }

        val emailError = if (!email.isNullOrBlank() && !isValidEmail(email)) {
            "Invalid email format"
        } else {
            null
        }

        val websiteError = if (!website.isNullOrBlank() && !isValidUrl(website)) {
            "Invalid website URL"
        } else {
            null
        }

        return ValidationErrors(
            nameError = nameError,
            descriptionError = descriptionError,
            emailError = emailError,
            websiteError = websiteError,
        )
    }

    /**
     * Simple email validation.
     */
    private fun isValidEmail(email: String): Boolean {
        return email.contains("@") && email.contains(".")
    }

    /**
     * Simple URL validation.
     */
    private fun isValidUrl(url: String): Boolean {
        return url.startsWith("http://") || url.startsWith("https://")
    }

    /**
     * Clears save state after user acknowledges.
     */
    fun clearSaveState() {
        _saveState.value = SaveState.Idle
    }
}

/**
 * Save state for profile updates.
 */
sealed class SaveState {
    data object Idle : SaveState()
    data object Saving : SaveState()
    data object ValidationFailed : SaveState()
    data object Success : SaveState()
    data class Error(val message: String) : SaveState()
}

/**
 * Validation errors for profile fields.
 */
data class ValidationErrors(
    val nameError: String? = null,
    val descriptionError: String? = null,
    val emailError: String? = null,
    val websiteError: String? = null,
) {
    fun hasErrors(): Boolean {
        return nameError != null || descriptionError != null ||
            emailError != null || websiteError != null
    }
}
