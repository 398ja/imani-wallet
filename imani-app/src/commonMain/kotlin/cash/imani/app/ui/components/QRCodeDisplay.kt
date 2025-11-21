package cash.imani.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * QR code display component.
 *
 * Displays a QR code for:
 * - Voucher tokens (redemption)
 * - Merchant npub (profile sharing)
 * - Lightning invoices (payment)
 *
 * Includes:
 * - QR code image (TODO: implement actual QR generation)
 * - Optional label
 * - Data preview (truncated)
 * - Copy to clipboard button
 *
 * TODO Phase 1.2 Enhancement: Implement actual QR code generation
 *   Option 1: Use qrcode.js via JS interop (web only)
 *   Option 2: Use kotlinx-qrcode library (multiplatform)
 *   See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.2
 *
 * See: project/web-client-ui-design.md lines 1260-1320
 *
 * @param data Data to encode (voucher token, npub, invoice)
 * @param size Size of QR code display
 * @param label Optional label to display below QR code
 * @param modifier Modifier for styling
 */
@Composable
fun QRCodeDisplay(
    data: String,
    size: Dp = 250.dp,
    label: String? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier.fillMaxWidth(),
    ) {
        // QR Code placeholder
        // TODO: Replace with actual QR code generation
        Box(
            modifier =
                Modifier
                    .size(size)
                    .background(Color.White, RoundedCornerShape(8.dp))
                    .padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "QR CODE\n(Placeholder)",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
                color = Color.Gray,
            )
        }

        // Optional label
        if (label != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Data preview (truncated for readability)
        SelectionContainer {
            Text(
                text =
                    if (data.length > 40) {
                        data.take(20) + "..." + data.takeLast(20)
                    } else {
                        data
                    },
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Copy button
        OutlinedButton(
            onClick = {
                // TODO Phase 1.2: Implement clipboard copy
                // For web: use window.navigator.clipboard.writeText(data)
                // For Android: use ClipboardManager
                // For now, this is a placeholder
                println("[QRCodeDisplay] Copy to clipboard: $data")
            },
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
            Spacer(modifier = Modifier.width(4.dp))
            Text("Copy")
        }
    }
}
