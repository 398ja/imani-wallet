package cash.imani.app.ui.voucher

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherResult
import cash.imani.voucher.usecases.IssueVoucherUseCase
import cash.imani.voucher.usecases.RedeemVoucherResult
import cash.imani.voucher.usecases.RedeemVoucherUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for voucher management screens.
 *
 * Manages UI state and coordinates between UI and voucher use cases.
 * Uses Kotlin Flow for reactive state management.
 */
class VoucherViewModel(
    private val voucherRepository: VoucherRepository,
    private val issueVoucherUseCase: IssueVoucherUseCase,
    private val redeemVoucherUseCase: RedeemVoucherUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _uiState = MutableStateFlow<VoucherUiState>(VoucherUiState.Loading)
    val uiState: StateFlow<VoucherUiState> = _uiState.asStateFlow()

    private val _issueState = MutableStateFlow<IssueVoucherState>(IssueVoucherState.Idle)
    val issueState: StateFlow<IssueVoucherState> = _issueState.asStateFlow()

    private val _redeemState = MutableStateFlow<RedeemVoucherState>(RedeemVoucherState.Idle)
    val redeemState: StateFlow<RedeemVoucherState> = _redeemState.asStateFlow()

    init {
        loadVouchers()
    }

    /**
     * Loads all vouchers from repository.
     */
    fun loadVouchers() {
        viewModelScope.launch {
            _uiState.value = VoucherUiState.Loading
            voucherRepository.getAllVouchers()
                .onSuccess { vouchers ->
                    _uiState.value = VoucherUiState.Success(vouchers)
                }
                .onFailure { error ->
                    _uiState.value =
                        VoucherUiState.Error(
                            error.message ?: "Failed to load vouchers",
                        )
                }
        }
    }

    /**
     * Issues a new voucher.
     *
     * @param request Voucher issuance parameters
     */
    fun issueVoucher(request: IssueVoucherRequest) {
        viewModelScope.launch {
            _issueState.value = IssueVoucherState.Issuing
            issueVoucherUseCase(request)
                .onSuccess { result ->
                    _issueState.value = IssueVoucherState.Success(result)
                    loadVouchers() // Refresh list
                }
                .onFailure { error ->
                    _issueState.value =
                        IssueVoucherState.Error(
                            error.message ?: "Failed to issue voucher",
                        )
                }
        }
    }

    /**
     * Redeems a voucher from its token string.
     *
     * @param token Cashu V4 token string
     */
    fun redeemVoucher(token: String) {
        viewModelScope.launch {
            _redeemState.value = RedeemVoucherState.Redeeming
            redeemVoucherUseCase(token)
                .onSuccess { result ->
                    _redeemState.value = RedeemVoucherState.Success(result)
                    loadVouchers() // Refresh list
                }
                .onFailure { error ->
                    _redeemState.value =
                        RedeemVoucherState.Error(
                            error.message ?: "Failed to redeem voucher",
                        )
                }
        }
    }

    /**
     * Resets the issue state to idle.
     */
    fun resetIssueState() {
        _issueState.value = IssueVoucherState.Idle
    }

    /**
     * Resets the redeem state to idle.
     */
    fun resetRedeemState() {
        _redeemState.value = RedeemVoucherState.Idle
    }
}

/**
 * UI state for voucher list screen.
 */
sealed class VoucherUiState {
    data object Loading : VoucherUiState()

    data class Success(val vouchers: List<StoredVoucher>) : VoucherUiState()

    data class Error(val message: String) : VoucherUiState()
}

/**
 * UI state for issue voucher flow.
 */
sealed class IssueVoucherState {
    data object Idle : IssueVoucherState()

    data object Issuing : IssueVoucherState()

    data class Success(val result: IssueVoucherResult) : IssueVoucherState()

    data class Error(val message: String) : IssueVoucherState()
}

/**
 * UI state for redeem voucher flow.
 */
sealed class RedeemVoucherState {
    data object Idle : RedeemVoucherState()

    data object Redeeming : RedeemVoucherState()

    data class Success(val result: RedeemVoucherResult) : RedeemVoucherState()

    data class Error(val message: String) : RedeemVoucherState()
}
