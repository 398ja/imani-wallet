package cash.imani.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import cash.imani.app.ui.theme.ImaniColors

/**
 * Android-specific Material 3 theme for Imani Wallet.
 *
 * Features:
 * - Dynamic colors on Android 12+ (Material You)
 * - Dark mode support with system preference detection
 * - Imani brand colors as fallback on older Android versions
 *
 * Code Reuse:
 * - Reuses ImaniColors from imani-app (100% shared brand identity)
 * - Material 3 color schemes (≥95% framework reuse)
 */

/**
 * Light color scheme using Imani brand colors.
 */
private val LightColorScheme = lightColorScheme(
    primary = Color(ImaniColors.PRIMARY),
    onPrimary = Color(ImaniColors.ON_PRIMARY),
    secondary = Color(ImaniColors.SECONDARY),
    onSecondary = Color(ImaniColors.ON_PRIMARY),
    tertiary = Color(ImaniColors.ACCENT),
    onTertiary = Color(0xFF000000), // Black on gold
    background = Color(ImaniColors.BACKGROUND),
    onBackground = Color(ImaniColors.ON_BACKGROUND),
    surface = Color(ImaniColors.SURFACE),
    onSurface = Color(ImaniColors.ON_SURFACE),
    error = Color(ImaniColors.ERROR),
    onError = Color(0xFFFFFFFF)
)

/**
 * Dark color scheme using Imani brand colors with adjusted luminance.
 */
private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF9B7DD6), // Lighter purple for dark mode
    onPrimary = Color(0xFF1F1F1F), // Dark gray on primary
    secondary = Color(0xFF4A90E2), // Lighter blue for dark mode
    onSecondary = Color(0xFF1F1F1F),
    tertiary = Color(0xFFFDB44B), // Lighter gold for dark mode
    onTertiary = Color(0xFF1F1F1F),
    background = Color(0xFF121212), // Material dark background
    onBackground = Color(0xFFE0E0E0), // Light gray text
    surface = Color(0xFF1E1E1E), // Elevated surface
    onSurface = Color(0xFFE0E0E0),
    error = Color(0xFFCF6679), // Lighter red for dark mode
    onError = Color(0xFF1F1F1F)
)

/**
 * Imani Wallet Material 3 theme for Android.
 *
 * Adapts to:
 * - System dark mode preference
 * - Dynamic colors on Android 12+ (Material You)
 * - Imani brand colors as fallback
 *
 * @param darkTheme Whether to use dark theme (defaults to system preference)
 * @param dynamicColor Whether to use dynamic colors on Android 12+ (defaults to true)
 * @param content Composable content to theme
 */
@Composable
fun ImaniTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        // Android 12+ (API 31+) with dynamic colors enabled
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) {
                dynamicDarkColorScheme(context)
            } else {
                dynamicLightColorScheme(context)
            }
        }

        // Fallback to Imani brand colors
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = ImaniTypography,
        content = content
    )
}
