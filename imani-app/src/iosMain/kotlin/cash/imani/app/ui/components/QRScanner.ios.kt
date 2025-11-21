package cash.imani.app.ui.components

import androidx.compose.runtime.Composable

/**
 * iOS implementation of QR Scanner.
 *
 * TODO Phase 5: Implement using AVFoundation camera APIs.
 * For now, displays a placeholder message.
 */
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    QRScannerPlaceholder(
        message = "QR Scanner coming soon for iOS (AVFoundation)",
        onClose = onClose,
    )
}
