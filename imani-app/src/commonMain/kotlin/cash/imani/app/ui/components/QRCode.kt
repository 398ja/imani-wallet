package cash.imani.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Displays a QR code for the given data.
 *
 * Platform-specific implementation using:
 * - Web: qrcode.js library via JS interop
 * - Android: zxing library
 * - iOS: CoreImage framework
 *
 * Phase 4.3: Camera QR Scanner
 *
 * @param data The data to encode in the QR code
 * @param modifier Modifier for styling
 */
@Composable
expect fun QRCodeImage(
    data: String,
    modifier: Modifier = Modifier,
)

/**
 * QR code scanner using device camera.
 *
 * Platform-specific implementation using:
 * - Web: jsQR library via getUserMedia API
 * - Android: CameraX + ML Kit
 * - iOS: AVFoundation
 *
 * Phase 4.3: Camera QR Scanner
 *
 * @param onQRScanned Callback when QR code is successfully scanned
 * @param onDismiss Callback to close the scanner
 * @param modifier Modifier for styling
 */
@Composable
expect fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
)
