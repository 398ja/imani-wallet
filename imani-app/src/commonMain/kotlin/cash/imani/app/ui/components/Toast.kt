package cash.imani.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Toast message types with associated colors and icons.
 */
enum class ToastType {
    SUCCESS,
    ERROR,
    WARNING,
    INFO,
}

/**
 * Toast message data.
 */
data class ToastMessage(
    val message: String,
    val type: ToastType = ToastType.INFO,
    val duration: Long = 3000L, // milliseconds
    val action: ToastAction? = null,
)

/**
 * Optional action for toast messages.
 */
data class ToastAction(
    val label: String,
    val onClick: () -> Unit,
)

/**
 * Toast notification component.
 *
 * Displays a temporary notification message with automatic dismissal.
 * Supports success, error, warning, and info states with appropriate
 * colors and icons.
 *
 * @param message The toast message to display
 * @param visible Whether the toast is currently visible
 * @param onDismiss Callback when toast is dismissed
 */
@Composable
fun Toast(
    message: ToastMessage,
    visible: Boolean,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Auto-dismiss after duration
    LaunchedEffect(visible) {
        if (visible) {
            delay(message.duration)
            onDismiss()
        }
    }

    AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(initialOffsetY = { -it }) + fadeIn(),
        exit = slideOutVertically(targetOffsetY = { -it }) + fadeOut(),
        modifier = modifier,
    ) {
        Box(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .padding(16.dp)
                    .background(
                        color = getToastBackgroundColor(message.type),
                        shape = RoundedCornerShape(8.dp),
                    )
                    .padding(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Icon
                Icon(
                    imageVector = getToastIcon(message.type),
                    contentDescription = null,
                    tint = getToastContentColor(message.type),
                    modifier = Modifier.size(24.dp),
                )

                Spacer(Modifier.width(12.dp))

                // Message
                Text(
                    text = message.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = getToastContentColor(message.type),
                    modifier = Modifier.weight(1f),
                )

                // Action button (if provided)
                message.action?.let { action ->
                    Spacer(Modifier.width(8.dp))
                    androidx.compose.material3.TextButton(
                        onClick = {
                            action.onClick()
                            onDismiss()
                        },
                    ) {
                        Text(
                            text = action.label,
                            color = getToastContentColor(message.type),
                        )
                    }
                }

                // Dismiss button
                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier.size(24.dp),
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Dismiss",
                        tint = getToastContentColor(message.type),
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

/**
 * Get background color for toast type.
 */
@Composable
private fun getToastBackgroundColor(type: ToastType): Color =
    when (type) {
        ToastType.SUCCESS -> Color(0xFF4CAF50) // Green
        ToastType.ERROR -> Color(0xFFE53935) // Red
        ToastType.WARNING -> Color(0xFFFFA726) // Orange
        ToastType.INFO -> Color(0xFF42A5F5) // Blue
    }

/**
 * Get content color (text/icon) for toast type.
 */
@Composable
private fun getToastContentColor(type: ToastType): Color = Color.White

/**
 * Get icon for toast type.
 */
private fun getToastIcon(type: ToastType): ImageVector =
    when (type) {
        ToastType.SUCCESS -> Icons.Default.CheckCircle
        ToastType.ERROR -> Icons.Default.Close
        ToastType.WARNING -> Icons.Default.Warning
        ToastType.INFO -> Icons.Default.Info
    }

/**
 * Toast host state for managing multiple toasts.
 */
class ToastHostState {
    private var _currentToast by mutableStateOf<ToastMessage?>(null)
    private var _isVisible by mutableStateOf(false)

    val currentToast: ToastMessage? get() = _currentToast
    val isVisible: Boolean get() = _isVisible

    /**
     * Show a toast message.
     */
    fun showToast(message: ToastMessage) {
        _currentToast = message
        _isVisible = true
    }

    /**
     * Show a success toast.
     */
    fun showSuccess(message: String, duration: Long = 3000L) {
        showToast(ToastMessage(message, ToastType.SUCCESS, duration))
    }

    /**
     * Show an error toast.
     */
    fun showError(message: String, duration: Long = 4000L) {
        showToast(ToastMessage(message, ToastType.ERROR, duration))
    }

    /**
     * Show a warning toast.
     */
    fun showWarning(message: String, duration: Long = 3500L) {
        showToast(ToastMessage(message, ToastType.WARNING, duration))
    }

    /**
     * Show an info toast.
     */
    fun showInfo(message: String, duration: Long = 3000L) {
        showToast(ToastMessage(message, ToastType.INFO, duration))
    }

    /**
     * Dismiss the current toast.
     */
    fun dismiss() {
        _isVisible = false
    }
}

/**
 * Remember toast host state across recompositions.
 */
@Composable
fun rememberToastHostState(): ToastHostState {
    return remember { ToastHostState() }
}

/**
 * Toast host container that displays toasts.
 *
 * Should be placed at the top level of your UI hierarchy.
 *
 * @param toastHostState The toast host state
 * @param modifier Modifier for the toast host
 */
@Composable
fun ToastHost(
    toastHostState: ToastHostState,
    modifier: Modifier = Modifier,
) {
    val currentToast = toastHostState.currentToast

    if (currentToast != null) {
        Toast(
            message = currentToast,
            visible = toastHostState.isVisible,
            onDismiss = { toastHostState.dismiss() },
            modifier = modifier,
        )
    }
}
