package cash.imani.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Error boundary data class.
 */
data class ErrorInfo(
    val exception: Throwable,
    val componentName: String,
    val timestamp: Long = kotlinx.datetime.Clock.System.now().toEpochMilliseconds(),
) {
    /**
     * Get a user-friendly error message.
     */
    fun getUserFriendlyMessage(): String {
        return when {
            exception.message?.contains("network", ignoreCase = true) == true ->
                "Network connection issue. Please check your internet connection."

            exception.message?.contains("timeout", ignoreCase = true) == true ->
                "Request timed out. Please try again."

            exception.message?.contains("not found", ignoreCase = true) == true ->
                "The requested resource was not found."

            exception.message?.contains("unauthorized", ignoreCase = true) == true ->
                "You are not authorized to access this resource."

            else -> "An unexpected error occurred. Please try again."
        }
    }

    /**
     * Get technical error details for debugging.
     */
    fun getTechnicalDetails(): String {
        return buildString {
            appendLine("Component: $componentName")
            appendLine("Error: ${exception::class.simpleName}")
            appendLine("Message: ${exception.message}")
            exception.stackTraceToString().lines().take(5).forEach {
                appendLine("  $it")
            }
        }
    }
}

/**
 * Error boundary component that catches and handles errors gracefully.
 *
 * Note: This component works with error state management rather than try-catch
 * since Compose doesn't support try-catch around composable functions.
 *
 * Usage with ViewModel:
 * ```kotlin
 * val errorInfo by viewModel.errorState.collectAsState()
 *
 * ErrorBoundary(
 *     errorInfo = errorInfo,
 *     componentName = "VoucherList",
 *     onError = { error ->
 *         // Log error, send to analytics, etc.
 *     },
 *     onReset = {
 *         viewModel.clearError()
 *         viewModel.retry()
 *     }
 * ) {
 *     VoucherListContent()
 * }
 * ```
 */
@Composable
fun ErrorBoundary(
    errorInfo: ErrorInfo?,
    componentName: String,
    onError: (ErrorInfo) -> Unit = {},
    onReset: () -> Unit = {},
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (errorInfo != null) {
        ErrorFallbackUI(
            errorInfo = errorInfo,
            onRetry = {
                onReset()
            },
            onReport = {
                // Report error details
                onError(errorInfo)
            },
            modifier = modifier,
        )
    } else {
        content()
    }
}

/**
 * Default fallback UI for error boundary.
 */
@Composable
fun ErrorFallbackUI(
    errorInfo: ErrorInfo,
    onRetry: () -> Unit,
    onReport: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // Error icon
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(64.dp),
        )

        Spacer(Modifier.height(24.dp))

        // Error title
        Text(
            text = "Something went wrong",
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.error,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(12.dp))

        // User-friendly error message
        Text(
            text = errorInfo.getUserFriendlyMessage(),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(8.dp))

        // Technical details (collapsed by default)
        var showDetails by remember { mutableStateOf(false) }

        OutlinedButton(
            onClick = { showDetails = !showDetails },
        ) {
            Text(if (showDetails) "Hide Details" else "Show Details")
        }

        if (showDetails) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = errorInfo.getTechnicalDetails(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Start,
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                modifier = Modifier.padding(12.dp),
            )
        }

        Spacer(Modifier.height(24.dp))

        // Action buttons
        Button(
            onClick = onRetry,
            modifier = Modifier.padding(horizontal = 16.dp),
        ) {
            Text("Try Again")
        }

        Spacer(Modifier.height(12.dp))

        OutlinedButton(
            onClick = onReport,
            modifier = Modifier.padding(horizontal = 16.dp),
        ) {
            Text("Report Error")
        }
    }
}

/**
 * Compact error view for inline error display.
 */
@Composable
fun CompactErrorView(
    errorMessage: String,
    onRetry: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(48.dp),
        )

        Spacer(Modifier.height(16.dp))

        Text(
            text = errorMessage,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )

        onRetry?.let { retryAction ->
            Spacer(Modifier.height(16.dp))
            Button(onClick = retryAction) {
                Text("Retry")
            }
        }
    }
}
