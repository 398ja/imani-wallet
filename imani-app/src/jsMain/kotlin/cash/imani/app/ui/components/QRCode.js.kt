package cash.imani.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.await
import org.jetbrains.skia.Image as SkiaImage
import org.khronos.webgl.Uint8ClampedArray
import org.w3c.dom.HTMLCanvasElement
import kotlin.js.Promise

/**
 * QR code generation using qrcode.js library.
 *
 * Generates QR code as PNG data URL and displays it as an image.
 * Phase 4.3: Camera QR Scanner
 */
@Composable
actual fun QRCodeImage(
    data: String,
    modifier: Modifier,
) {
    var qrDataUrl by remember(data) { mutableStateOf<String?>(null) }
    var isLoading by remember(data) { mutableStateOf(true) }
    var error by remember(data) { mutableStateOf<String?>(null) }

    LaunchedEffect(data) {
        try {
            isLoading = true
            error = null

            // Generate QR code using qrcode.js
            val options = js("""{
                width: 300,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            }""")

            val dataUrl = QRCodeJS.toDataURL(data, options).await() as String
            qrDataUrl = dataUrl
            isLoading = false
        } catch (e: Throwable) {
            error = "Failed to generate QR code: ${e.message}"
            isLoading = false
            println("[QRCodeImage] Error generating QR: ${e.message}")
        }
    }

    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        when {
            isLoading -> {
                CircularProgressIndicator()
            }

            error != null -> {
                Text(
                    text = "QR Error",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            qrDataUrl != null -> {
                // Convert data URL to ImageBitmap
                QRCodeImageFromDataUrl(
                    dataUrl = qrDataUrl!!,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/**
 * Renders QR code image from data URL.
 */
@Composable
private fun QRCodeImageFromDataUrl(
    dataUrl: String,
    modifier: Modifier = Modifier,
) {
    var imageBitmap by remember(dataUrl) { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(dataUrl) {
        try {
            // Create image element to load the data URL
            val img = kotlinx.browser.document.createElement("img") as org.w3c.dom.HTMLImageElement
            img.src = dataUrl

            // Wait for image to load
            kotlinx.coroutines.suspendCancellableCoroutine<Unit> { continuation ->
                img.onload = {
                    // Convert to canvas
                    val canvas =
                        kotlinx.browser.document.createElement("canvas") as HTMLCanvasElement
                    canvas.width = img.width
                    canvas.height = img.height

                    val ctx = canvas.getContext("2d") as org.w3c.dom.CanvasRenderingContext2D
                    ctx.drawImage(img, 0.0, 0.0)

                    // Get image data
                    val imageData = ctx.getImageData(0.0, 0.0, canvas.width.toDouble(), canvas.height.toDouble())

                    // Convert to Skia Image
                    val bytes = imageData.data.asDynamic() as Uint8ClampedArray
                    val skiaImage = SkiaImage.makeRaster(
                        org.jetbrains.skia.ImageInfo.makeN32(
                            canvas.width,
                            canvas.height,
                            org.jetbrains.skia.ColorAlphaType.UNPREMUL,
                        ),
                        bytes.unsafeCast<ByteArray>(),
                        canvas.width * 4,
                    )

                    imageBitmap = skiaImage.toComposeImageBitmap()
                    continuation.resume(Unit) {}
                }

                img.onerror = { _, _, _, _, _ ->
                    println("[QRCodeImage] Failed to load image")
                    continuation.resume(Unit) {}
                }
            }
        } catch (e: Throwable) {
            println("[QRCodeImage] Error loading QR image: ${e.message}")
        }
    }

    imageBitmap?.let { bitmap ->
        Image(
            bitmap = bitmap,
            contentDescription = "QR Code",
            modifier = modifier,
        )
    }
}

/**
 * QR code scanner using jsQR library and getUserMedia API.
 *
 * Simplified implementation for Phase 4.3.
 * TODO: Full camera integration in future phase.
 *
 * Phase 4.3: Camera QR Scanner (placeholder)
 */
@Composable
actual fun QRScannerView(
    onQRScanned: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = "QR Scanner",
                style = MaterialTheme.typography.titleLarge,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = "Camera-based QR scanning coming soon!\n\nFor now, use the Copy/Paste method to redeem vouchers.",
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))
            Button(onClick = onDismiss) {
                Text("Close")
            }
        }
    }
}

/**
 * External declarations for qrcode.js library.
 */
@JsModule("qrcode")
@JsNonModule
external object QRCodeJS {
    fun toDataURL(text: String, options: dynamic): Promise<String>
}
