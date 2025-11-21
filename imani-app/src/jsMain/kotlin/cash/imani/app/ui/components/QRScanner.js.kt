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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.browser.document
import kotlinx.browser.window
import kotlinx.coroutines.delay
import org.w3c.dom.HTMLCanvasElement
import org.w3c.dom.HTMLVideoElement

/**
 * JS implementation of QR Scanner using HTML5 getUserMedia and jsQR.
 *
 * Creates a video element for camera preview and scans frames for QR codes.
 * Uses the jsQR library for QR code detection.
 */
@Suppress("DEPRECATION")
@androidx.compose.runtime.NoLiveLiterals
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    var scannerState by remember { mutableStateOf<ScannerState>(ScannerState.Initializing) }
    var videoElement by remember { mutableStateOf<HTMLVideoElement?>(null) }
    var canvasElement by remember { mutableStateOf<HTMLCanvasElement?>(null) }

    // Initialize camera and scanner
    LaunchedEffect(Unit) {
        try {
            // Create video element
            val video = document.createElement("video") as HTMLVideoElement
            video.id = "qr-scanner-video"
            video.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 9998;"
            video.autoplay = true
            video.playsInline = true
            document.body?.appendChild(video)
            videoElement = video

            // Create canvas for frame analysis
            val canvas = document.createElement("canvas") as HTMLCanvasElement
            canvas.id = "qr-scanner-canvas"
            canvas.style.display = "none"
            document.body?.appendChild(canvas)
            canvasElement = canvas

            // Request camera access
            val constraints =
                js(
                    """({
                video: { facingMode: "environment" }
            })""",
                )

            val mediaDevices = window.navigator.asDynamic().mediaDevices
            if (mediaDevices == undefined) {
                scannerState = ScannerState.Error("Camera not supported in this browser")
                return@LaunchedEffect
            }

            mediaDevices.getUserMedia(constraints).then { stream: dynamic ->
                video.srcObject = stream
                video.play()
                scannerState = ScannerState.Scanning
                println("[QRScanner] Camera started")
            }.catch { error: dynamic ->
                scannerState = ScannerState.Error("Camera access denied: $error")
                println("[QRScanner] Camera error: $error")
            }
        } catch (e: Exception) {
            scannerState = ScannerState.Error("Failed to initialize camera: ${e.message}")
        }
    }

    // Scan frames for QR codes
    LaunchedEffect(scannerState) {
        if (scannerState != ScannerState.Scanning) return@LaunchedEffect

        val video = videoElement ?: return@LaunchedEffect
        val canvas = canvasElement ?: return@LaunchedEffect
        val ctx = canvas.getContext("2d")

        while (scannerState == ScannerState.Scanning) {
            delay(100) // Scan every 100ms

            if (video.readyState == 4.toShort()) { // HAVE_ENOUGH_DATA
                canvas.width = video.videoWidth
                canvas.height = video.videoHeight

                ctx?.asDynamic()?.drawImage(video, 0, 0, canvas.width, canvas.height)
                val imageData = ctx?.asDynamic()?.getImageData(0, 0, canvas.width, canvas.height)

                if (imageData != null) {
                    // Use jsQR library
                    val jsQR = js("window.jsQR")
                    if (jsQR != undefined) {
                        val code = jsQR(imageData.data, imageData.width, imageData.height)
                        if (code != null && code.data != undefined) {
                            val qrData = code.data.toString()
                            println("[QRScanner] QR detected: ${qrData.take(30)}...")
                            scannerState = ScannerState.Success(qrData)
                            onQRScanned(qrData)
                            break
                        }
                    } else {
                        println("[QRScanner] jsQR library not loaded")
                    }
                }
            }
        }
    }

    // Cleanup on dispose
    DisposableEffect(Unit) {
        onDispose {
            // Stop camera stream
            videoElement?.let { video ->
                video.srcObject?.asDynamic()?.getTracks()?.forEach { track: dynamic ->
                    track.stop()
                }
                video.remove()
            }
            canvasElement?.remove()
            println("[QRScanner] Cleaned up")
        }
    }

    // UI overlay
    Box(
        modifier =
            Modifier
                .fillMaxSize()
                .background(Color.Transparent),
    ) {
        // Close button
        IconButton(
            onClick = {
                scannerState = ScannerState.Closed
                onClose()
            },
            modifier =
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(16.dp),
        ) {
            Icon(
                Icons.Default.Close,
                contentDescription = "Close Scanner",
                tint = Color.White,
                modifier = Modifier.size(32.dp),
            )
        }

        // Status overlay
        when (val state = scannerState) {
            is ScannerState.Initializing -> {
                Box(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.7f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = Color.White)
                        Spacer(Modifier.height(16.dp))
                        Text("Starting camera...", color = Color.White)
                    }
                }
            }

            is ScannerState.Error -> {
                Box(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.9f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Camera Error",
                            style = MaterialTheme.typography.titleLarge,
                            color = Color.White,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            state.message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = Color.White.copy(alpha = 0.8f),
                        )
                    }
                }
            }

            is ScannerState.Scanning -> {
                // Show scan target overlay
                Box(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(32.dp),
                ) {
                    Text(
                        "Point camera at QR code",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }

            is ScannerState.Success -> {
                Box(
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.7f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "QR Code detected!",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.Green,
                    )
                }
            }

            is ScannerState.Closed -> {
                // Nothing to show
            }
        }
    }
}

/**
 * Scanner state machine.
 */
private sealed class ScannerState {
    data object Initializing : ScannerState()

    data object Scanning : ScannerState()

    data class Success(val data: String) : ScannerState()

    data class Error(val message: String) : ScannerState()

    data object Closed : ScannerState()
}
