package cash.imani.app.ui.merchant

import cash.imani.app.ui.shop.MerchantProfile
import cash.imani.identity.repository.IdentityRepository
import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.SalesMetrics
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.usecases.DiscoverMerchantOffersUseCase
import cash.imani.voucher.usecases.DiscoverOffersFilter
import cash.imani.voucher.usecases.GetSalesMetricsUseCase
import cash.imani.voucher.domain.OfferStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime

/**
 * ViewModel for merchant sales dashboard.
 *
 * Manages:
 * - Merchant profile display
 * - Today's sales metrics (vouchers sold, revenue, redemptions)
 * - Active offers list
 * - Recent redemptions feed
 *
 * Phase 3.1 Implementation:
 * - Uses GetSalesMetricsUseCase for today's metrics
 * - Queries active offers via DiscoverMerchantOffersUseCase
 * - Lists recent redemptions from VoucherRepository
 * - Placeholder merchant profile (TODO Phase 3.2: Editable profile)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.1
 *
 * @param identityRepository Repository for fetching merchant identity
 * @param voucherRepository Repository for voucher operations
 * @param discoverOffersUseCase Use case for discovering merchant offers
 * @param getSalesMetricsUseCase Use case for calculating sales metrics
 */
class MerchantDashboardViewModel(
    private val identityRepository: IdentityRepository,
    private val voucherRepository: VoucherRepository,
    private val discoverOffersUseCase: DiscoverMerchantOffersUseCase,
    private val getSalesMetricsUseCase: GetSalesMetricsUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _merchantProfile = MutableStateFlow<MerchantProfile?>(null)
    val merchantProfile: StateFlow<MerchantProfile?> = _merchantProfile.asStateFlow()

    private val _todayMetrics = MutableStateFlow<SalesMetrics?>(null)
    val todayMetrics: StateFlow<SalesMetrics?> = _todayMetrics.asStateFlow()

    private val _activeOffers = MutableStateFlow<List<MerchantOffer>>(emptyList())
    val activeOffers: StateFlow<List<MerchantOffer>> = _activeOffers.asStateFlow()

    private val _recentRedemptions = MutableStateFlow<List<StoredVoucher>>(emptyList())
    val recentRedemptions: StateFlow<List<StoredVoucher>> = _recentRedemptions.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /**
     * Loads complete dashboard data.
     *
     * Fetches:
     * - Merchant profile from identity repository
     * - Today's sales metrics
     * - Active offers list
     * - Recent redemptions (last 10)
     */
    fun loadDashboard() {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null

            try {
                // Load merchant profile
                val identities =
                    identityRepository.listIdentities().getOrElse {
                        throw Exception("Failed to load identity: ${it.message}")
                    }

                val merchantIdentity =
                    identities.firstOrNull()
                        ?: throw Exception("No merchant identity found. Create one first.")

                _merchantProfile.value =
                    MerchantProfile(
                        npub = merchantIdentity.toNpub(),
                        name = merchantIdentity.label,
                        description = "Merchant powered by Imani Wallet", // TODO Phase 3.2: Editable description
                        logo = null, // TODO Phase 3.2: Logo upload
                    )

                // Load today's sales metrics
                loadTodayMetrics()

                // Load active offers
                loadActiveOffers(merchantIdentity.toNpub())

                // Load recent redemptions
                loadRecentRedemptions()
            } catch (e: Exception) {
                _error.value = "Failed to load dashboard: ${e.message}"
                println("[MerchantDashboardViewModel] Error loading dashboard: ${e.message}")
            } finally {
                _loading.value = false
            }
        }
    }

    /**
     * Loads today's sales metrics.
     *
     * Queries vouchers issued today (start of day to now) and calculates:
     * - Total vouchers issued
     * - Total vouchers redeemed
     * - Total revenue from redemptions
     */
    private suspend fun loadTodayMetrics() {
        try {
            val now = Clock.System.now()
            val today = now.toLocalDateTime(TimeZone.currentSystemDefault()).date

            // Start of today (midnight)
            val startOfDay =
                LocalDateTime(
                    year = today.year,
                    monthNumber = today.monthNumber,
                    dayOfMonth = today.dayOfMonth,
                    hour = 0,
                    minute = 0,
                ).toInstant(TimeZone.currentSystemDefault())

            val result =
                getSalesMetricsUseCase(
                    periodStart = startOfDay,
                    periodEnd = now,
                )

            result.onSuccess { metrics ->
                _todayMetrics.value = metrics
                println(
                    "[MerchantDashboardViewModel] Today's metrics: " +
                        "${metrics.totalVouchersIssued} issued, " +
                        "${metrics.totalVouchersRedeemed} redeemed, " +
                        "${metrics.totalRevenue} sat revenue",
                )
            }.onFailure { error ->
                println("[MerchantDashboardViewModel] Error loading metrics: ${error.message}")
                // Use empty metrics as fallback
                _todayMetrics.value =
                    SalesMetrics(
                        totalVouchersIssued = 0,
                        totalVouchersRedeemed = 0,
                        totalRevenue = 0,
                        redemptionRate = 0.0,
                        salesByOffer = emptyMap(),
                        periodStart = startOfDay,
                        periodEnd = now,
                    )
            }
        } catch (e: Exception) {
            println("[MerchantDashboardViewModel] Exception loading metrics: ${e.message}")
        }
    }

    /**
     * Loads active offers for this merchant.
     *
     * @param merchantNpub Merchant's Nostr public key
     */
    private suspend fun loadActiveOffers(merchantNpub: String) {
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
                _activeOffers.value = offers
                println("[MerchantDashboardViewModel] Loaded ${offers.size} active offers")
            }.onFailure { error ->
                println("[MerchantDashboardViewModel] Error loading offers: ${error.message}")
                _activeOffers.value = emptyList()
            }
        } catch (e: Exception) {
            println("[MerchantDashboardViewModel] Exception loading offers: ${e.message}")
            _activeOffers.value = emptyList()
        }
    }

    /**
     * Loads recent redemptions (last 10).
     *
     * Fetches redeemed vouchers, sorted by redemption time descending.
     */
    private suspend fun loadRecentRedemptions() {
        try {
            val result = voucherRepository.getAllVouchers()

            result.onSuccess { allVouchers ->
                val redeemed =
                    allVouchers
                        .filter { it.status == VoucherStatus.REDEEMED }
                        .sortedByDescending { it.redemptionMetadata?.redeemedAt ?: it.issuedAt }
                        .take(10)

                _recentRedemptions.value = redeemed
                println("[MerchantDashboardViewModel] Loaded ${redeemed.size} recent redemptions")
            }.onFailure { error ->
                println("[MerchantDashboardViewModel] Error loading redemptions: ${error.message}")
                _recentRedemptions.value = emptyList()
            }
        } catch (e: Exception) {
            println("[MerchantDashboardViewModel] Exception loading redemptions: ${e.message}")
            _recentRedemptions.value = emptyList()
        }
    }

    /**
     * Refreshes dashboard data.
     */
    fun refresh() {
        loadDashboard()
    }

    /**
     * Clears error state.
     */
    fun clearError() {
        _error.value = null
    }
}
