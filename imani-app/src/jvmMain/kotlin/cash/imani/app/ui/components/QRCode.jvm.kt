package cash.imani.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

/**
 * JVM stub implementation for QR code generation.
 *
 * Phase 4.3: Camera QR Scanner
 * TODO: Implement with zxing library for desktop
 */
@Composable
actual fun QRCodeImage(
    data: String,
    modifier: Modifier,
) {
    Box(
        modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "QR Code\n(JVM stub)",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

/**
 * JVM stub implementation for QR code scanner.
 *
 * Phase 4.3: Camera QR Scanner
 * TODO: Implement with webcam library for desktop
 */
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier,
) {
    Box(
        modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "QR Scanner\n(JVM stub)",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
