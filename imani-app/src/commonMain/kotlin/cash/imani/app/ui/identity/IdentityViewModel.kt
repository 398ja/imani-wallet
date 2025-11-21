package cash.imani.app.ui.identity

import cash.imani.identity.domain.Identity
import cash.imani.identity.usecases.CreateIdentityUseCase
import cash.imani.identity.usecases.ImportIdentityFromNsecUseCase
import cash.imani.identity.usecases.ImportIdentityUseCase
import cash.imani.identity.usecases.ListIdentitiesUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for identity management screens.
 *
 * Manages UI state and coordinates between UI and use cases.
 * Uses Kotlin Flow for reactive state management.
 */
class IdentityViewModel(
    private val createIdentityUseCase: CreateIdentityUseCase,
    private val listIdentitiesUseCase: ListIdentitiesUseCase,
    private val importIdentityUseCase: ImportIdentityUseCase,
    private val importIdentityFromNsecUseCase: ImportIdentityFromNsecUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _uiState = MutableStateFlow<IdentityUiState>(IdentityUiState.Loading)
    val uiState: StateFlow<IdentityUiState> = _uiState.asStateFlow()

    private val _createState = MutableStateFlow<CreateIdentityState>(CreateIdentityState.Idle)
    val createState: StateFlow<CreateIdentityState> = _createState.asStateFlow()

    private val _importState = MutableStateFlow<ImportIdentityState>(ImportIdentityState.Idle)
    val importState: StateFlow<ImportIdentityState> = _importState.asStateFlow()

    private val _navigationState = MutableStateFlow<IdentityNavigationState>(IdentityNavigationState.None)
    val navigationState: StateFlow<IdentityNavigationState> = _navigationState.asStateFlow()

    init {
        loadIdentities()
    }

    /**
     * Loads all identities from repository.
     */
    fun loadIdentities() {
        viewModelScope.launch {
            _uiState.value = IdentityUiState.Loading
            listIdentitiesUseCase()
                .onSuccess { identities ->
                    _uiState.value = IdentityUiState.Success(identities)
                }
                .onFailure { error ->
                    _uiState.value =
                        IdentityUiState.Error(
                            error.message ?: "Failed to load identities",
                        )
                }
        }
    }

    /**
     * Creates a new identity with the given label.
     */
    fun createIdentity(label: String) {
        viewModelScope.launch {
            _createState.value = CreateIdentityState.Creating
            createIdentityUseCase(label)
                .onSuccess { result ->
                    _createState.value =
                        CreateIdentityState.Success(
                            identity = result.identity,
                            mnemonic = result.mnemonic,
                        )
                    loadIdentities() // Refresh list
                }
                .onFailure { error ->
                    _createState.value =
                        CreateIdentityState.Error(
                            error.message ?: "Failed to create identity",
                        )
                }
        }
    }

    /**
     * Imports an identity from a BIP39 mnemonic phrase.
     */
    fun importFromMnemonic(
        mnemonic: String,
        label: String,
    ) {
        viewModelScope.launch {
            _importState.value = ImportIdentityState.Importing
            importIdentityUseCase(mnemonic, label)
                .onSuccess { identity ->
                    _importState.value = ImportIdentityState.Success(identity)
                    loadIdentities() // Refresh list
                }
                .onFailure { error ->
                    _importState.value =
                        ImportIdentityState.Error(
                            error.message ?: "Failed to import from mnemonic",
                        )
                }
        }
    }

    /**
     * Imports an identity from an nsec (Nostr private key).
     */
    fun importFromNsec(
        nsec: String,
        label: String,
    ) {
        viewModelScope.launch {
            _importState.value = ImportIdentityState.Importing
            importIdentityFromNsecUseCase(nsec, label)
                .onSuccess { identity ->
                    _importState.value = ImportIdentityState.Success(identity)
                    loadIdentities() // Refresh list
                }
                .onFailure { error ->
                    _importState.value =
                        ImportIdentityState.Error(
                            error.message ?: "Failed to import from nsec",
                        )
                }
        }
    }

    /**
     * Resets the create state to idle.
     */
    fun resetCreateState() {
        _createState.value = CreateIdentityState.Idle
    }

    /**
     * Resets the import state to idle.
     */
    fun resetImportState() {
        _importState.value = ImportIdentityState.Idle
    }

    /**
     * Navigate to create identity screen.
     */
    fun showCreateIdentity() {
        _navigationState.value = IdentityNavigationState.CreateIdentity
    }

    /**
     * Navigate to import identity screen.
     */
    fun showImportIdentity() {
        _navigationState.value = IdentityNavigationState.ImportIdentity
    }

    /**
     * Reset navigation state after navigation handled.
     */
    fun resetNavigationState() {
        _navigationState.value = IdentityNavigationState.None
    }
}

/**
 * UI state for identity list screen.
 */
sealed class IdentityUiState {
    data object Loading : IdentityUiState()

    data class Success(val identities: List<Identity>) : IdentityUiState()

    data class Error(val message: String) : IdentityUiState()
}

/**
 * UI state for create identity flow.
 */
sealed class CreateIdentityState {
    data object Idle : CreateIdentityState()

    data object Creating : CreateIdentityState()

    data class Success(
        val identity: Identity,
        val mnemonic: String,
    ) : CreateIdentityState()

    data class Error(val message: String) : CreateIdentityState()
}

/**
 * UI state for import identity flow.
 */
sealed class ImportIdentityState {
    data object Idle : ImportIdentityState()

    data object Importing : ImportIdentityState()

    data class Success(val identity: Identity) : ImportIdentityState()

    data class Error(val message: String) : ImportIdentityState()
}

/**
 * Navigation state for identity screens.
 */
sealed class IdentityNavigationState {
    data object None : IdentityNavigationState()

    data object CreateIdentity : IdentityNavigationState()

    data object ImportIdentity : IdentityNavigationState()
}
