package cash.imani.app.ui.theme

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Accessibility utilities for WCAG 2.1 AA compliance.
 *
 * Requirements (from design spec lines 1631-1665):
 * - Text contrast ≥ 4.5:1
 * - Keyboard navigation (Tab, Enter, Esc)
 * - Screen reader support (ARIA labels)
 * - Touch targets ≥ 48x48dp
 * - Focus indicators (2px solid)
 * - Color blindness (icons + text)
 *
 * Phase 5.1: Accessibility
 * See: project/web-marketplace-ui-implementation.md Phase 5, Task 5.1
 */

/**
 * Minimum touch target size per WCAG 2.1 AA.
 * Interactive elements must be at least 48x48dp.
 */
val MinTouchTargetSize: Dp = 48.dp

/**
 * Minimum contrast ratio for normal text (WCAG AA).
 */
const val MinContrastRatioNormal = 4.5f

/**
 * Minimum contrast ratio for large text (WCAG AA).
 * Large text is ≥18pt or ≥14pt bold.
 */
const val MinContrastRatioLarge = 3.0f

/**
 * Modifier to ensure minimum touch target size (48x48dp).
 *
 * Usage:
 * ```kotlin
 * IconButton(
 *     onClick = {},
 *     modifier = Modifier.minTouchTarget()
 * ) {
 *     Icon(Icons.Default.Add, contentDescription = "Add item")
 * }
 * ```
 */
fun Modifier.minTouchTarget(): Modifier = this.defaultMinSize(
    minWidth = MinTouchTargetSize,
    minHeight = MinTouchTargetSize,
)

/**
 * Modifier to add semantic content description for screen readers.
 *
 * Usage:
 * ```kotlin
 * Box(
 *     modifier = Modifier.accessibilityLabel("Shopping cart with 3 items")
 * )
 * ```
 */
fun Modifier.accessibilityLabel(label: String): Modifier = this.semantics {
    contentDescription = label
}

/**
 * Modifier to mark an element as a button for screen readers.
 */
fun Modifier.accessibilityButton(label: String): Modifier = this.semantics {
    contentDescription = label
    role = Role.Button
}

/**
 * Modifier to mark an element as an image for screen readers.
 */
fun Modifier.accessibilityImage(label: String): Modifier = this.semantics {
    contentDescription = label
    role = Role.Image
}

/**
 * Modifier to mark an element as a checkbox for screen readers.
 */
fun Modifier.accessibilityCheckbox(label: String, checked: Boolean): Modifier = this.semantics {
    contentDescription = if (checked) "$label, checked" else "$label, unchecked"
    role = Role.Checkbox
}

/**
 * Content descriptions for common UI elements.
 *
 * Usage:
 * ```kotlin
 * Icon(
 *     Icons.Default.Close,
 *     contentDescription = ContentDescriptions.closeButton
 * )
 * ```
 */
object ContentDescriptions {
    // Navigation
    const val backButton = "Go back"
    const val closeButton = "Close"
    const val menuButton = "Open menu"
    const val searchButton = "Search"
    const val settingsButton = "Settings"

    // Actions
    const val addButton = "Add"
    const val deleteButton = "Delete"
    const val editButton = "Edit"
    const val saveButton = "Save"
    const val shareButton = "Share"
    const val copyButton = "Copy to clipboard"
    const val refreshButton = "Refresh"

    // Tabs
    const val shopTab = "Shop tab"
    const val merchantTab = "Merchant tab"
    const val settingsTab = "Settings tab"

    // Vouchers
    const val voucherQRCode = "Voucher QR code"
    const val scanQRCode = "Scan QR code"
    const val sendVoucher = "Send voucher to friend"
    const val redeemVoucher = "Redeem voucher"

    // Merchants
    const val favoriteButton = "Add to favorites"
    const val unfavoriteButton = "Remove from favorites"
    const val merchantLogo = "Merchant logo"
    const val merchantProfile = "Merchant profile"

    // Status
    const val loadingIndicator = "Loading"
    const val successIcon = "Success"
    const val errorIcon = "Error"
    const val warningIcon = "Warning"
}

/**
 * Accessibility-friendly loading state announcements.
 */
object AccessibilityAnnouncements {
    const val loading = "Loading, please wait"
    const val loadingComplete = "Loading complete"
    const val actionSuccessful = "Action completed successfully"
    const val actionFailed = "Action failed"
    const val networkError = "Network error, please try again"
}
