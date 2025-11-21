package cash.imani.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Screen size breakpoints for responsive design.
 *
 * Based on design spec (lines 1550-1628):
 * - MOBILE: <640dp → Bottom tabs, single column
 * - TABLET: 640-1024dp → Side nav rail, two columns
 * - DESKTOP: >1024dp → Three columns, persistent rail
 *
 * Phase 4.4: Responsive Design
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.4
 */
enum class ScreenSize {
    MOBILE,
    TABLET,
    DESKTOP,
    ;

    val isMobile: Boolean get() = this == MOBILE
    val isTablet: Boolean get() = this == TABLET
    val isDesktop: Boolean get() = this == DESKTOP
    val isCompact: Boolean get() = this == MOBILE
    val isExpanded: Boolean get() = this == DESKTOP
}

/**
 * Responsive layout configuration for different screen sizes.
 */
data class ResponsiveConfig(
    val screenSize: ScreenSize,
    val columns: Int,
    val contentPadding: Dp,
    val cardWidth: Dp?,
    val showBottomNav: Boolean,
    val showSideNav: Boolean,
) {
    companion object {
        fun forScreenSize(screenSize: ScreenSize): ResponsiveConfig =
            when (screenSize) {
                ScreenSize.MOBILE ->
                    ResponsiveConfig(
                        screenSize = screenSize,
                        columns = 1,
                        contentPadding = 16.dp,
                        cardWidth = null, // Full width
                        showBottomNav = true,
                        showSideNav = false,
                    )
                ScreenSize.TABLET ->
                    ResponsiveConfig(
                        screenSize = screenSize,
                        columns = 2,
                        contentPadding = 24.dp,
                        cardWidth = 320.dp,
                        showBottomNav = false,
                        showSideNav = true,
                    )
                ScreenSize.DESKTOP ->
                    ResponsiveConfig(
                        screenSize = screenSize,
                        columns = 3,
                        contentPadding = 32.dp,
                        cardWidth = 360.dp,
                        showBottomNav = false,
                        showSideNav = true,
                    )
            }
    }
}

/**
 * Composition local for responsive configuration.
 */
val LocalResponsiveConfig = compositionLocalOf { ResponsiveConfig.forScreenSize(ScreenSize.MOBILE) }

/**
 * Determines screen size from width in dp.
 */
fun screenSizeFromWidth(widthDp: Int): ScreenSize =
    when {
        widthDp < 640 -> ScreenSize.MOBILE
        widthDp < 1024 -> ScreenSize.TABLET
        else -> ScreenSize.DESKTOP
    }

/**
 * Platform-specific window size provider.
 *
 * Returns the current window width in dp.
 */
@Composable
expect fun rememberWindowWidth(): Int

/**
 * Provides responsive configuration based on current window size.
 *
 * Usage:
 * ```kotlin
 * ResponsiveProvider {
 *     val config = LocalResponsiveConfig.current
 *     if (config.screenSize.isMobile) {
 *         // Mobile layout
 *     } else {
 *         // Tablet/Desktop layout
 *     }
 * }
 * ```
 */
@Composable
fun ResponsiveProvider(content: @Composable () -> Unit) {
    val windowWidth = rememberWindowWidth()
    val screenSize = screenSizeFromWidth(windowWidth)
    val config = ResponsiveConfig.forScreenSize(screenSize)

    CompositionLocalProvider(LocalResponsiveConfig provides config) {
        content()
    }
}

/**
 * Helper composable for responsive layouts.
 *
 * Usage:
 * ```kotlin
 * ResponsiveLayout { screenSize ->
 *     when (screenSize) {
 *         ScreenSize.MOBILE -> MobileLayout()
 *         ScreenSize.TABLET -> TabletLayout()
 *         ScreenSize.DESKTOP -> DesktopLayout()
 *     }
 * }
 * ```
 */
@Composable
fun ResponsiveLayout(content: @Composable (ScreenSize) -> Unit) {
    val windowWidth = rememberWindowWidth()
    val screenSize = screenSizeFromWidth(windowWidth)
    content(screenSize)
}
