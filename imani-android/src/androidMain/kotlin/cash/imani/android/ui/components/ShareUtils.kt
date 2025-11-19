package cash.imani.android.ui.components

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.io.File
import java.io.FileOutputStream

/**
 * Android share utilities for vouchers.
 *
 * Features:
 * - Share voucher token as text
 * - Share QR code as image
 * - FileProvider integration for secure file sharing
 *
 * Code Reuse:
 * - Android Intent system (100% platform API reuse)
 * - ZXing QR code generation (≥95% library reuse)
 * - FileProvider (100% AndroidX reuse)
 *
 * Usage:
 * ```kotlin
 * val context = LocalContext.current
 * ShareUtils.shareVoucherToken(context, "cashuA...")
 * ShareUtils.shareVoucherQR(context, "cashuA...", "Birthday gift")
 * ```
 */
object ShareUtils {

    /**
     * Share voucher token as plain text.
     *
     * Opens Android share sheet with text sharing options
     * (messaging apps, email, clipboard, etc.).
     *
     * @param context Android context
     * @param token Cashu token string (cashuA...)
     */
    fun shareVoucherToken(context: Context, token: String) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, token)
            putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher")
        }
        context.startActivity(Intent.createChooser(intent, "Share Voucher"))
    }

    /**
     * Share voucher as QR code image.
     *
     * Generates QR code, saves to cache, and opens Android share sheet
     * with image sharing options.
     *
     * @param context Android context
     * @param token Cashu token string (cashuA...)
     * @param memo Optional memo to include in share message
     */
    fun shareVoucherQR(context: Context, token: String, memo: String? = null) {
        try {
            // Generate QR code bitmap
            val bitmap = generateQRCode(token, size = 512)

            // Save to cache directory
            val file = File(context.cacheDir, "voucher_qr_${System.currentTimeMillis()}.png")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }

            // Get content URI via FileProvider
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )

            // Share intent
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, memo ?: "Imani Voucher")
                putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher QR Code")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            context.startActivity(Intent.createChooser(intent, "Share QR Code"))
        } catch (e: Exception) {
            // Fallback to token sharing if QR generation fails
            shareVoucherToken(context, token)
        }
    }

    /**
     * Generate QR code bitmap from string content.
     *
     * Uses ZXing library for QR code generation.
     *
     * @param content String to encode (typically cashu token)
     * @param size Size of QR code in pixels (square)
     * @return Bitmap containing QR code
     */
    fun generateQRCode(content: String, size: Int = 512): Bitmap {
        val writer = QRCodeWriter()
        val bitMatrix = writer.encode(content, BarcodeFormat.QR_CODE, size, size)

        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)

        for (x in 0 until size) {
            for (y in 0 until size) {
                bitmap.setPixel(
                    x,
                    y,
                    if (bitMatrix[x, y]) Color.BLACK else Color.WHITE
                )
            }
        }

        return bitmap
    }

    /**
     * Share both token text and QR code.
     *
     * Combines text and image sharing in one intent.
     *
     * @param context Android context
     * @param token Cashu token string
     * @param memo Optional memo
     */
    fun shareVoucherComplete(context: Context, token: String, memo: String? = null) {
        try {
            // Generate QR code
            val bitmap = generateQRCode(token, size = 512)
            val file = File(context.cacheDir, "voucher_qr_${System.currentTimeMillis()}.png")
            FileOutputStream(file).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }

            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )

            // Share with both image and text
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, buildString {
                    if (memo != null) {
                        append(memo)
                        append("\n\n")
                    }
                    append("Imani Voucher Token:\n")
                    append(token)
                })
                putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            context.startActivity(Intent.createChooser(intent, "Share Voucher"))
        } catch (e: Exception) {
            // Fallback
            shareVoucherToken(context, token)
        }
    }
}
