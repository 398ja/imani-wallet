package cash.imani.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import cash.imani.voucher.domain.VoucherStatus

/**
 * Status badge component for vouchers.
 *
 * Displays voucher status with color-coded badges:
 * - ISSUED: Blue (active, ready to use)
 * - ACTIVE: Green (active, ready to use) - alias for ISSUED
 * - EXPIRING_SOON: Orange (warning, expires soon)
 * - DELIVERED: Cyan (sent to recipient)
 * - REDEEMED: Gray (already used)
 * - REVOKED: Red (cancelled by issuer)
 * - EXPIRED: Gray (past expiration date)
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.2
 * See: project/web-client-ui-design.md lines 1200-1256
 *
 * @param status Voucher status to display
 * @param modifier Modifier for styling
 */
@Composable
fun StatusBadge(
    status: VoucherStatus,
    modifier: Modifier = Modifier,
) {
    val (color, icon, label) =
        when (status) {
            VoucherStatus.ISSUED ->
                Triple(
                    Color(0xFF2196F3), // Blue
                    Icons.Default.CheckCircle,
                    "Active",
                )

            VoucherStatus.DELIVERED ->
                Triple(
                    Color(0xFF00BCD4), // Cyan
                    Icons.Default.CheckCircle,
                    "Delivered",
                )

            VoucherStatus.REDEEMED ->
                Triple(
                    Color(0xFF9E9E9E), // Gray
                    Icons.Default.CheckCircle,
                    "Redeemed",
                )

            VoucherStatus.REVOKED ->
                Triple(
                    Color(0xFFF44336), // Red
                    Icons.Default.Close,
                    "Revoked",
                )

            VoucherStatus.EXPIRED ->
                Triple(
                    Color(0xFF757575), // Dark Gray
                    Icons.Default.Warning,
                    "Expired",
                )
        }

    Row(
        modifier =
            modifier
                .background(
                    color = color.copy(alpha = 0.1f),
                    shape = RoundedCornerShape(12.dp),
                ).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(16.dp),
        )

        Spacer(modifier = Modifier.width(4.dp))

        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = color,
        )
    }
}

/**
 * Extended status for UI-specific states (not in domain model).
 *
 * Used for displaying warning states like "expiring soon".
 */
sealed interface VoucherUiStatus {
    data object Active : VoucherUiStatus

    data object ExpiringSoon : VoucherUiStatus

    data object Expired : VoucherUiStatus

    data object Redeemed : VoucherUiStatus
}

/**
 * Status badge for UI-specific statuses.
 *
 * Use this for computed states like "expiring soon" that aren't
 * part of the domain model.
 *
 * @param status UI-specific status
 * @param modifier Modifier for styling
 */
@Composable
fun UiStatusBadge(
    status: VoucherUiStatus,
    modifier: Modifier = Modifier,
) {
    val (color, icon, label) =
        when (status) {
            VoucherUiStatus.Active ->
                Triple(
                    Color(0xFF4CAF50), // Green
                    Icons.Default.CheckCircle,
                    "Active",
                )

            VoucherUiStatus.ExpiringSoon ->
                Triple(
                    Color(0xFFFF9800), // Orange
                    Icons.Default.Warning,
                    "Expiring Soon",
                )

            VoucherUiStatus.Expired ->
                Triple(
                    Color(0xFF757575), // Gray
                    Icons.Default.Close,
                    "Expired",
                )

            VoucherUiStatus.Redeemed ->
                Triple(
                    Color(0xFF9E9E9E), // Gray
                    Icons.Default.CheckCircle,
                    "Redeemed",
                )
        }

    Row(
        modifier =
            modifier
                .background(
                    color = color.copy(alpha = 0.1f),
                    shape = RoundedCornerShape(12.dp),
                ).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(16.dp),
        )

        Spacer(modifier = Modifier.width(4.dp))

        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = color,
        )
    }
}
