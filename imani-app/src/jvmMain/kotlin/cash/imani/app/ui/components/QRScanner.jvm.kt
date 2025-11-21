package cash.imani.app.ui.components

import androidx.compose.runtime.Composable

/**
 * JVM implementation of QR Scanner.
 *
 * TODO Phase 5: Implement using webcam access via JavaCV or similar.
 * For now, displays a placeholder message.
 */
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    QRScannerPlaceholder(
        message = "QR Scanner not yet available on JVM desktop",
        onClose = onClose,
    )
}
