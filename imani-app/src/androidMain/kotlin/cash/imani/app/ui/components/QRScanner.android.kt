package cash.imani.app.ui.components

import androidx.compose.runtime.Composable

/**
 * Android implementation of QR Scanner.
 *
 * TODO Phase 4: Implement using CameraX + ML Kit barcode scanning.
 * For now, displays a placeholder message.
 */
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    QRScannerPlaceholder(
        message = "QR Scanner coming soon for Android (CameraX)",
        onClose = onClose,
    )
}
