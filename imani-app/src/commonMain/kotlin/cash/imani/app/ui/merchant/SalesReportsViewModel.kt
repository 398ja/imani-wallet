package cash.imani.app.ui.merchant

import cash.imani.voucher.domain.SalesMetrics
import cash.imani.voucher.usecases.GetSalesMetricsUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.minus
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime

/**
 * ViewModel for sales reports screen.
 *
 * Manages:
 * - Period selection (daily, weekly, monthly)
 * - Metrics calculation for each period
 * - CSV export
 *
 * Phase 3.5 Implementation:
 * - Daily/weekly/monthly metrics
 * - Period aggregation
 * - Export functionality (placeholder)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.5
 *
 * @param getSalesMetricsUseCase Use case for calculating sales metrics
 */
class SalesReportsViewModel(
    private val getSalesMetricsUseCase: GetSalesMetricsUseCase,
) {
    private val viewModelScope = CoroutineScope(Dispatchers.Main)

    private val _currentPeriod = MutableStateFlow(ReportPeriod.DAILY)
    val currentPeriod: StateFlow<ReportPeriod> = _currentPeriod.asStateFlow()

    private val _metrics = MutableStateFlow<SalesMetrics?>(null)
    val metrics: StateFlow<SalesMetrics?> = _metrics.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    init {
        loadMetrics(ReportPeriod.DAILY)
    }

    /**
     * Changes report period and loads metrics.
     */
    fun setPeriod(period: ReportPeriod) {
        _currentPeriod.value = period
        loadMetrics(period)
    }

    /**
     * Loads metrics for the specified period.
     */
    private fun loadMetrics(period: ReportPeriod) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null

            try {
                val now = Clock.System.now()
                val timezone = TimeZone.currentSystemDefault()
                val today = now.toLocalDateTime(timezone).date

                // Calculate period start based on selected period
                val periodStart =
                    when (period) {
                        ReportPeriod.DAILY -> {
                            // Start of today
                            LocalDateTime(
                                year = today.year,
                                monthNumber = today.monthNumber,
                                dayOfMonth = today.dayOfMonth,
                                hour = 0,
                                minute = 0,
                            ).toInstant(timezone)
                        }
                        ReportPeriod.WEEKLY -> {
                            // 7 days ago
                            val weekAgo = today.minus(7, DateTimeUnit.DAY)
                            LocalDateTime(
                                year = weekAgo.year,
                                monthNumber = weekAgo.monthNumber,
                                dayOfMonth = weekAgo.dayOfMonth,
                                hour = 0,
                                minute = 0,
                            ).toInstant(timezone)
                        }
                        ReportPeriod.MONTHLY -> {
                            // 30 days ago
                            val monthAgo = today.minus(30, DateTimeUnit.DAY)
                            LocalDateTime(
                                year = monthAgo.year,
                                monthNumber = monthAgo.monthNumber,
                                dayOfMonth = monthAgo.dayOfMonth,
                                hour = 0,
                                minute = 0,
                            ).toInstant(timezone)
                        }
                    }

                val result =
                    getSalesMetricsUseCase(
                        periodStart = periodStart,
                        periodEnd = now,
                    )

                result.onSuccess { metrics ->
                    _metrics.value = metrics
                    println("[SalesReportsViewModel] Loaded ${period.label} metrics")
                }.onFailure { error ->
                    _error.value = error.message
                    println("[SalesReportsViewModel] Error loading metrics: ${error.message}")
                }
            } catch (e: Exception) {
                _error.value = e.message
                println("[SalesReportsViewModel] Exception: ${e.message}")
            } finally {
                _loading.value = false
            }
        }
    }

    /**
     * Exports metrics to CSV.
     *
     * TODO Phase 3.5+: Implement actual CSV download
     */
    fun exportCSV() {
        val currentMetrics = _metrics.value ?: return

        // Build CSV content
        val csv =
            buildString {
                appendLine("Metric,Value")
                appendLine("Period,${_currentPeriod.value.label}")
                appendLine("Vouchers Issued,${currentMetrics.totalVouchersIssued}")
                appendLine("Vouchers Redeemed,${currentMetrics.totalVouchersRedeemed}")
                appendLine("Total Revenue (sat),${currentMetrics.totalRevenue}")
                appendLine("Redemption Rate,${(currentMetrics.redemptionRate * 100).toInt()}%")
            }

        println("[SalesReportsViewModel] CSV Export:\n$csv")
        // TODO Phase 3.5+: Trigger browser download
    }

    /**
     * Refreshes current period metrics.
     */
    fun refresh() {
        loadMetrics(_currentPeriod.value)
    }

    /**
     * Clears error state.
     */
    fun clearError() {
        _error.value = null
    }
}

/**
 * Report period options.
 */
enum class ReportPeriod(val label: String, val days: Int) {
    DAILY("Daily", 1),
    WEEKLY("Weekly", 7),
    MONTHLY("Monthly", 30),
}
