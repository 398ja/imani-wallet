package cash.imani.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Duration.Companion.seconds

/**
 * Voucher card component for displaying voucher summaries.
 *
 * Displays:
 * - Merchant name and logo (optional)
 * - Voucher name/description
 * - Balance (current / original amount)
 * - Expiration date with countdown
 * - Status badge
 * - Quick "Redeem" action button
 *
 * Used in:
 * - My Vouchers screen (customer view)
 * - Sales Dashboard (merchant view)
 * - Voucher history lists
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.2
 * See: project/web-client-ui-design.md lines 1103-1196
 *
 * @param merchantName Name of merchant who issued voucher
 * @param merchantLogo URL to merchant logo (optional)
 * @param voucherName Voucher description/name
 * @param balance Current remaining balance in sats
 * @param originalAmount Original voucher amount in sats
 * @param expiresAt Expiration timestamp (epoch seconds)
 * @param status Voucher status
 * @param onClick Callback when card is clicked
 * @param modifier Modifier for styling
 */
@Composable
fun VoucherCard(
    merchantName: String,
    merchantLogo: String? = null,
    voucherName: String,
    balance: Int,
    originalAmount: Int,
    expiresAt: Long?,
    status: VoucherStatus,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
        colors =
            CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Merchant header
            Row(verticalAlignment = Alignment.CenterVertically) {
                // TODO Phase 1.2: Add merchant logo support when image loading is implemented
                // if (merchantLogo != null) {
                //     AsyncImage(
                //         model = merchantLogo,
                //         contentDescription = null,
                //         modifier = Modifier.size(40.dp).clip(CircleShape)
                //     )
                //     Spacer(Modifier.width(12.dp))
                // }

                // Merchant name
                Text(
                    text = merchantName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(modifier = Modifier.height(8.dp))

            // Voucher name
            Text(
                text = voucherName,
                style = MaterialTheme.typography.bodyLarge,
            )

            Spacer(modifier = Modifier.height(4.dp))

            // Balance and Redeem button
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Balance: $balance / $originalAmount sat",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (status == VoucherStatus.ISSUED && balance > 0) {
                    Button(
                        onClick = onClick,
                        modifier = Modifier.height(36.dp),
                    ) {
                        Text("Redeem")
                    }
                }
            }

            Spacer(modifier = Modifier.height(4.dp))

            // Expiry date
            if (expiresAt != null) {
                val daysUntilExpiry = calculateDaysUntil(expiresAt)
                val expiryText =
                    if (daysUntilExpiry > 0) {
                        "Expires: ${formatDate(expiresAt)} ($daysUntilExpiry days)"
                    } else {
                        "Expired: ${formatDate(expiresAt)}"
                    }

                Text(
                    text = expiryText,
                    style = MaterialTheme.typography.bodySmall,
                    color =
                        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
                            MaterialTheme.colorScheme.error // Warning color for expiring soon
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                )

                Spacer(modifier = Modifier.height(8.dp))
            }

            // Status badge
            StatusBadge(status = status)
        }
    }
}

/**
 * Calculate days until a future timestamp.
 *
 * @param epochSeconds Target timestamp in epoch seconds
 * @return Number of days until target (negative if past)
 */
private fun calculateDaysUntil(epochSeconds: Long): Int {
    val now = Clock.System.now()
    val target = Instant.fromEpochSeconds(epochSeconds)
    val duration = target - now
    return (duration.inWholeSeconds / 86400).toInt()
}

/**
 * Format epoch timestamp as readable date.
 *
 * @param epochSeconds Timestamp in epoch seconds
 * @return Formatted date string (e.g., "Jan 15, 2025")
 */
private fun formatDate(epochSeconds: Long): String {
    val instant = Instant.fromEpochSeconds(epochSeconds)
    val localDateTime = instant.toLocalDateTime(TimeZone.currentSystemDefault())

    val monthNames =
        listOf(
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        )

    val month = monthNames[localDateTime.monthNumber - 1]
    val day = localDateTime.dayOfMonth
    val year = localDateTime.year

    return "$month $day, $year"
}
