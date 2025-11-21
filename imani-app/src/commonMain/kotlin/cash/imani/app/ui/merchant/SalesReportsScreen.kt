package cash.imani.app.ui.merchant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.SalesMetrics

/**
 * Sales reports screen - detailed metrics by period.
 *
 * Features:
 * - Daily/weekly/monthly tabs
 * - Metrics visualization
 * - Export to CSV button
 * - Refresh data
 *
 * Phase 3.5 COMPLETE:
 * - Period tab selection
 * - Metrics cards with values
 * - Simple progress bar visualization
 * - CSV export (console log placeholder)
 *
 * Phase 3.5+ TODO:
 * - Chart visualization (line/bar charts)
 * - Browser CSV download
 * - Filter by offer
 *
 * See: project/web-marketplace-ui-implementation.md Phase 3, Task 3.5
 *
 * @param viewModel Sales reports ViewModel
 * @param onBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SalesReportsScreen(
    viewModel: SalesReportsViewModel,
    onBack: () -> Unit,
) {
    val currentPeriod by viewModel.currentPeriod.collectAsState()
    val metrics by viewModel.metrics.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val error by viewModel.error.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sales Reports") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = { viewModel.exportCSV() }) {
                        Icon(Icons.Default.Add, contentDescription = "Export CSV") // TODO: Download icon
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding),
        ) {
            // Period tabs
            TabRow(selectedTabIndex = currentPeriod.ordinal) {
                ReportPeriod.entries.forEach { period ->
                    Tab(
                        selected = currentPeriod == period,
                        onClick = { viewModel.setPeriod(period) },
                        text = { Text(period.label) },
                    )
                }
            }

            if (loading) {
                Box(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            } else if (error != null) {
                Column(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text = "Error loading reports",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = error ?: "Unknown error",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
            } else {
                metrics?.let { m ->
                    Column(
                        modifier =
                            Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        // Summary card
                        SummaryCard(
                            period = currentPeriod,
                            metrics = m,
                        )

                        // Detailed metrics
                        MetricsGrid(metrics = m)

                        // Simple chart placeholder
                        ChartPlaceholder(metrics = m)
                    }
                }
            }
        }
    }
}

/**
 * Summary card with period headline metrics.
 */
@Composable
private fun SummaryCard(
    period: ReportPeriod,
    metrics: SalesMetrics,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        colors =
            CardDefaults.cardColors(
                containerColor = Color(0xFF6B46C1), // Imani Purple
            ),
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "${period.label} Summary",
                style = MaterialTheme.typography.titleMedium,
                color = Color.White.copy(alpha = 0.8f),
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = "${metrics.totalRevenue} sat",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )

            Text(
                text = "Total Revenue",
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.8f),
            )
        }
    }
}

/**
 * Grid of individual metrics.
 */
@Composable
private fun MetricsGrid(
    metrics: SalesMetrics,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            MetricCard(
                title = "Vouchers Sold",
                value = metrics.totalVouchersIssued.toString(),
                modifier = Modifier.weight(1f),
            )
            MetricCard(
                title = "Vouchers Redeemed",
                value = metrics.totalVouchersRedeemed.toString(),
                modifier = Modifier.weight(1f),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            MetricCard(
                title = "Redemption Rate",
                value = "${(metrics.redemptionRate * 100).toInt()}%",
                modifier = Modifier.weight(1f),
            )
            MetricCard(
                title = "Outstanding",
                value = "${metrics.totalVouchersIssued - metrics.totalVouchersRedeemed}",
                subtitle = "vouchers",
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * Individual metric card.
 */
@Composable
private fun MetricCard(
    title: String,
    value: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
) {
    Card(
        modifier = modifier,
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(8.dp))

            Text(
                text = value,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = Color(0xFFF59E0B), // Imani Gold
            )

            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * Chart placeholder with simple progress visualization.
 *
 * TODO Phase 3.5+: Replace with actual chart library
 */
@Composable
private fun ChartPlaceholder(
    metrics: SalesMetrics,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            Text(
                text = "Redemption Progress",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )

            Spacer(Modifier.height(16.dp))

            // Simple progress bar as chart placeholder
            val progress =
                if (metrics.totalVouchersIssued > 0) {
                    metrics.totalVouchersRedeemed.toFloat() / metrics.totalVouchersIssued
                } else {
                    0f
                }

            LinearProgressIndicator(
                progress = { progress },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(24.dp),
                color = Color(0xFF10B981), // Green
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )

            Spacer(Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Redeemed: ${metrics.totalVouchersRedeemed}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "Total: ${metrics.totalVouchersIssued}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Spacer(Modifier.height(16.dp))

            Text(
                text = "Chart visualization coming soon",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
