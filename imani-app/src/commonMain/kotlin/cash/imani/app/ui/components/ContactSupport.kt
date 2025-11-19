package cash.imani.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * Support request data.
 */
data class SupportRequest(
    val userDescription: String,
    val errorDetails: String? = null,
    val userEmail: String? = null,
    val timestamp: Long = kotlinx.datetime.Clock.System.now().toEpochMilliseconds(),
) {
    /**
     * Format as email body.
     */
    fun toEmailBody(): String =
        buildString {
            appendLine("User Description:")
            appendLine(userDescription)
            appendLine()

            userEmail?.let {
                appendLine("Contact Email: $it")
                appendLine()
            }

            errorDetails?.let {
                appendLine("Technical Details:")
                appendLine(it)
                appendLine()
            }

            appendLine("Timestamp: ${kotlinx.datetime.Instant.fromEpochMilliseconds(timestamp)}")
            appendLine("App: Imani Wallet")
            appendLine("Version: 1.0.0")
        }

    /**
     * Format as GitHub issue body.
     */
    fun toGitHubIssueBody(): String =
        buildString {
            appendLine("## Description")
            appendLine(userDescription)
            appendLine()

            userEmail?.let {
                appendLine("**Contact:** $it")
                appendLine()
            }

            errorDetails?.let {
                appendLine("## Error Details")
                appendLine("```")
                appendLine(it)
                appendLine("```")
                appendLine()
            }

            appendLine("## Environment")
            appendLine("- App: Imani Wallet")
            appendLine("- Version: 1.0.0")
            appendLine("- Timestamp: ${kotlinx.datetime.Instant.fromEpochMilliseconds(timestamp)}")
        }
}

/**
 * Contact Support dialog.
 *
 * Provides a user-friendly form for reporting issues with pre-filled
 * error details and multiple submission options.
 */
@Composable
fun ContactSupportDialog(
    errorInfo: ErrorInfo? = null,
    onDismiss: () -> Unit,
    onSubmit: (SupportRequest) -> Unit,
) {
    var userDescription by remember { mutableStateOf("") }
    var userEmail by remember { mutableStateOf("") }
    var includeErrorDetails by remember { mutableStateOf(errorInfo != null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("Contact Support")
        },
        text = {
            Column(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState()),
            ) {
                Text(
                    text = "We're here to help! Please describe the issue you're experiencing.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(16.dp))

                // User description
                OutlinedTextField(
                    value = userDescription,
                    onValueChange = { userDescription = it },
                    label = { Text("Describe the issue") },
                    placeholder = { Text("What happened? What were you trying to do?") },
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    maxLines = 5,
                )

                Spacer(Modifier.height(12.dp))

                // Optional email
                OutlinedTextField(
                    value = userEmail,
                    onValueChange = { userEmail = it },
                    label = { Text("Email (optional)") },
                    placeholder = { Text("your@email.com") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )

                // Error details (if available)
                errorInfo?.let { error ->
                    Spacer(Modifier.height(16.dp))

                    Row {
                        androidx.compose.material3.Checkbox(
                            checked = includeErrorDetails,
                            onCheckedChange = { includeErrorDetails = it },
                        )
                        Text(
                            text = "Include error details",
                            modifier = Modifier.padding(start = 8.dp),
                        )
                    }

                    if (includeErrorDetails) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = error.getTechnicalDetails(),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .padding(8.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val request =
                        SupportRequest(
                            userDescription = userDescription,
                            errorDetails =
                                if (includeErrorDetails && errorInfo != null) {
                                    errorInfo.getTechnicalDetails()
                                } else {
                                    null
                                },
                            userEmail = userEmail.ifBlank { null },
                        )
                    onSubmit(request)
                    onDismiss()
                },
                enabled = userDescription.isNotBlank(),
            ) {
                Text("Submit")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
    )
}

/**
 * Contact Support button component.
 */
@Composable
fun ContactSupportButton(
    errorInfo: ErrorInfo? = null,
    onSubmit: (SupportRequest) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var showDialog by remember { mutableStateOf(false) }

    OutlinedButton(
        onClick = { showDialog = true },
        modifier = modifier,
    ) {
        Text("Contact Support")
    }

    if (showDialog) {
        ContactSupportDialog(
            errorInfo = errorInfo,
            onDismiss = { showDialog = false },
            onSubmit = onSubmit,
        )
    }
}

/**
 * Support options for different submission methods.
 */
object SupportHelper {
    /**
     * Submit support request via email (opens default mail client).
     */
    fun submitViaEmail(request: SupportRequest) {
        val subject = "Imani Wallet Support Request"
        val body = request.toEmailBody().replace("\n", "%0D%0A")
        val mailto = "mailto:support@imani-wallet.com?subject=$subject&body=$body"

        // Platform-specific email opening will be handled by the platform
        println("[Support] Email: $mailto")
    }

    /**
     * Submit support request via GitHub Issues.
     */
    fun submitViaGitHub(request: SupportRequest) {
        val title = "User-reported issue"
        val body = request.toGitHubIssueBody()
        val url = "https://github.com/anthropics/imani-wallet/issues/new?title=$title&body=${encodeURIComponent(body)}"

        // Platform-specific URL opening will be handled by the platform
        println("[Support] GitHub: $url")
    }

    /**
     * Copy support request to clipboard.
     */
    fun copyToClipboard(request: SupportRequest): String {
        return request.toGitHubIssueBody()
    }

    /**
     * Simple URL encoding for GitHub URLs.
     */
    private fun encodeURIComponent(str: String): String {
        return str
            .replace("%", "%25")
            .replace(" ", "%20")
            .replace("\n", "%0A")
            .replace("!", "%21")
            .replace("'", "%27")
            .replace("(", "%28")
            .replace(")", "%29")
            .replace("*", "%2A")
    }
}
