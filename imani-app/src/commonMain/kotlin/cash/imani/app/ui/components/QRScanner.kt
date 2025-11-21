package cash.imani.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Cross-platform QR scanner component.
 *
 * Uses platform-specific implementations:
 * - JS: HTML5 getUserMedia + jsQR library
 * - Android: CameraX (future)
 * - iOS: AVFoundation (future)
 *
 * Phase 4.3: Camera QR Scanner
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.3
 *
 * @param onQRScanned Callback when a QR code is detected
 * @param onClose Callback to close the scanner
 */
@Composable
expect fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onClose: () -> Unit,
)

/**
 * Placeholder scanner view for non-web platforms.
 */
@Composable
fun QRScannerPlaceholder(
    message: String = "QR Scanner not available on this platform",
    onClose: () -> Unit,
) {
    Box(
        modifier =
            Modifier
                .fillMaxSize()
                .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        IconButton(
            onClick = onClose,
            modifier =
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(16.dp),
        ) {
            Icon(
                Icons.Default.Close,
                contentDescription = "Close",
                tint = Color.White,
            )
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(64.dp),
                color = Color.White,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = message,
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
