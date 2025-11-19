# Error Handling & User Feedback Guide

**Document Version:** 1.0.0
**Last Updated:** 2025-11-19
**Target:** Phase 3, Task 3.3

## Overview

This document describes the comprehensive error handling and user feedback system
implemented in Imani Wallet, including toast notifications, retry logic, error
boundaries, and support request functionality.

---

## Toast Notifications

### Overview

Toast notifications provide non-intrusive feedback for user actions and system events.

**File:** `imani-app/src/commonMain/kotlin/cash/imani/app/ui/components/Toast.kt`

### Features

- **4 Toast Types:** Success, Error, Warning, Info
- **Auto-dismiss:** Configurable duration (default: 3-4 seconds)
- **Manual dismiss:** Close button on all toasts
- **Optional actions:** Add action buttons to toasts
- **Animated:** Slide-in from top with fade effect
- **Branded colors:** Consistent with Imani design system

### Usage

#### Basic Toast

```kotlin
@Composable
fun MyScreen() {
    val toastHost = rememberToastHostState()

    Scaffold(
        // Toast host at top of screen
        topBar = {
            ToastHost(toastHostState = toastHost)
        }
    ) {
        Button(onClick = {
            toastHost.showSuccess("Identity created successfully!")
        }) {
            Text("Create Identity")
        }
    }
}
```

#### Toast Types

```kotlin
// Success toast (green)
toastHost.showSuccess("Voucher issued successfully!")

// Error toast (red)
toastHost.showError("Failed to connect to mint")

// Warning toast (orange)
toastHost.showWarning("Your session will expire soon")

// Info toast (blue)
toastHost.showInfo("Syncing with Nostr relays...")
```

#### Custom Toast with Action

```kotlin
val message = ToastMessage(
    message = "New version available",
    type = ToastType.INFO,
    duration = 5000L,
    action = ToastAction(
        label = "Update",
        onClick = { /* Handle update */ }
    )
)
toastHost.showToast(message)
```

### Best Practices

1. **Keep messages concise** (<50 characters)
2. **Use appropriate types:**
   - Success: User action completed
   - Error: Operation failed
   - Warning: Potential issue
   - Info: System status
3. **Avoid toast spam:** Don't show multiple toasts rapidly
4. **Action buttons:** Only for quick actions (not navigation)

---

## Retry Logic

### Overview

Automatic retry mechanism for handling transient network failures.

**File:** `imani-app/src/commonMain/kotlin/cash/imani/app/util/RetryPolicy.kt`

### Features

- **Exponential backoff:** Smart retry delays
- **Configurable:** Max attempts, delays, backoff multiplier
- **Jitter:** Prevent thundering herd
- **Smart detection:** Automatically identifies retryable errors
- **Multiple strategies:** Exponential, linear, fixed delay

### Usage

#### Basic Retry

```kotlin
suspend fun fetchVouchers(): List<Voucher> {
    return retryWithPolicy(
        policy = RetryPolicy.exponentialBackoff(maxAttempts = 3)
    ) {
        apiClient.getVouchers()
    }
}
```

#### Custom Retry Policy

```kotlin
val customPolicy = RetryPolicy(
    maxAttempts = 5,
    initialDelay = 500.milliseconds,
    maxDelay = 10.seconds,
    backoffMultiplier = 2.0,
    useJitter = true,
    shouldRetry = { exception ->
        exception is NetworkException
    }
)

retryWithPolicy(policy = customPolicy) {
    // Network operation
}
```

#### Retry Strategies

```kotlin
// Exponential backoff (default)
// Delays: 1s, 2s, 4s, 8s, ...
RetryPolicy.exponentialBackoff(
    maxAttempts = 3,
    initialDelay = 1.seconds
)

// Fixed delay
// Delays: 2s, 2s, 2s, ...
RetryPolicy.fixedDelay(
    maxAttempts = 3,
    delay = 2.seconds
)

// Linear backoff
// Delays: 1s, 2s, 3s, 4s, ...
RetryPolicy.linearBackoff(
    maxAttempts = 4,
    initialDelay = 1.seconds,
    increment = 1.seconds
)

// No retry
RetryPolicy.noRetry()
```

#### With Result

```kotlin
val result: Result<Data> = retryWithPolicyResult(
    policy = RetryPolicy.exponentialBackoff()
) {
    apiClient.getData()
}

result
    .onSuccess { data -> /* Handle success */ }
    .onFailure { error -> /* Handle failure */ }
```

#### Detailed Retry Result

```kotlin
when (val result = retryWithPolicyDetailed(policy) { fetchData() }) {
    is RetryResult.Success -> {
        val data = result.value
        val attempts = result.attempts
        println("Success after $attempts attempts")
    }
    is RetryResult.Failure -> {
        val error = result.exception
        val attempts = result.attempts
        println("Failed after $attempts attempts: $error")
    }
}
```

### Retryable Errors

Automatically retried:
- Timeout exceptions
- Connection errors
- Network failures
- Server errors (500, 502, 503, 504)
- DNS resolution failures

Not retried:
- Client errors (400, 401, 403, 404)
- Validation errors
- Business logic errors

---

## Error Boundaries

### Overview

Catch and handle errors gracefully with fallback UI.

**File:** `imani-app/src/commonMain/kotlin/cash/imani/app/ui/components/ErrorBoundary.kt`

### Features

- **Catch all errors:** Prevents app crashes
- **Fallback UI:** User-friendly error display
- **Retry mechanism:** Allow users to retry failed operations
- **Error details:** Expandable technical details
- **Error reporting:** Integrated with support system

### Usage

#### Basic Error Boundary

```kotlin
@Composable
fun VoucherListScreen() {
    ErrorBoundary(
        componentName = "VoucherList",
        onError = { errorInfo ->
            // Log error
            println("Error in VoucherList: ${errorInfo.exception}")
        },
        onReset = {
            // Reset state when user retries
            viewModel.refreshVouchers()
        }
    ) {
        // Content that might throw errors
        VoucherListContent()
    }
}
```

#### With Custom Error Handling

```kotlin
ErrorBoundary(
    componentName = "MintConnection",
    onError = { errorInfo ->
        // Send to analytics
        analytics.logError(errorInfo)

        // Show toast
        toastHost.showError(errorInfo.getUserFriendlyMessage())

        // Report to error tracking service
        errorTracker.report(errorInfo)
    }
) {
    MintConnectionUI()
}
```

#### Compact Error View

For inline error display without full screen:

```kotlin
if (state is Error) {
    CompactErrorView(
        errorMessage = "Failed to load vouchers",
        onRetry = { viewModel.retry() }
    )
} else {
    VoucherList(vouchers)
}
```

### Error Info

```kotlin
data class ErrorInfo(
    val exception: Throwable,
    val componentName: String,
    val timestamp: Long
) {
    fun getUserFriendlyMessage(): String
    fun getTechnicalDetails(): String
}
```

**User-Friendly Messages:**
- Network errors → "Network connection issue..."
- Timeouts → "Request timed out..."
- Not found → "Resource not found..."
- Unauthorized → "Not authorized..."
- Default → "An unexpected error occurred..."

---

## Contact Support

### Overview

Allow users to easily report issues with pre-filled error details.

**File:** `imani-app/src/commonMain/kotlin/cash/imani/app/ui/components/ContactSupport.kt`

### Features

- **Pre-filled error details:** Automatically include technical information
- **User description:** Allow users to describe the issue
- **Optional email:** Users can provide contact info
- **Multiple submission methods:** Email, GitHub Issues, Clipboard
- **Privacy-respecting:** Users choose what details to include

### Usage

#### Contact Support Button

```kotlin
@Composable
fun SettingsScreen() {
    ContactSupportButton(
        errorInfo = null, // or provide ErrorInfo
        onSubmit = { request ->
            // Handle submission
            SupportHelper.submitViaEmail(request)
            // or
            SupportHelper.submitViaGitHub(request)
            // or
            val text = SupportHelper.copyToClipboard(request)
            clipboard.setText(text)
        }
    )
}
```

#### With Error Context

```kotlin
ErrorBoundary(
    componentName = "PaymentFlow",
    onError = { errorInfo ->
        // Store error for support dialog
        currentError = errorInfo
    }
) {
    PaymentFlowContent()
}

// In error UI
ContactSupportButton(
    errorInfo = currentError,
    onSubmit = { request ->
        SupportHelper.submitViaGitHub(request)
        toastHost.showSuccess("Error report submitted")
    }
)
```

#### Custom Dialog

```kotlin
var showSupportDialog by remember { mutableStateOf(false) }

if (showSupportDialog) {
    ContactSupportDialog(
        errorInfo = errorInfo,
        onDismiss = { showSupportDialog = false },
        onSubmit = { request ->
            handleSupportRequest(request)
        }
    )
}
```

### Support Request

```kotlin
data class SupportRequest(
    val userDescription: String,
    val errorDetails: String?,
    val userEmail: String?,
    val timestamp: Long
) {
    fun toEmailBody(): String
    fun toGitHubIssueBody(): String
}
```

### Submission Methods

```kotlin
// Email (opens default mail client)
SupportHelper.submitViaEmail(request)

// GitHub Issues (opens browser)
SupportHelper.submitViaGitHub(request)

// Clipboard (for manual submission)
val text = SupportHelper.copyToClipboard(request)
```

---

## Integration Examples

### Complete Screen Example

```kotlin
@Composable
fun VoucherScreen(viewModel: VoucherViewModel) {
    val toastHost = rememberToastHostState()
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            Column {
                TopAppBar(title = { Text("Vouchers") })
                ToastHost(toastHostState = toastHost)
            }
        }
    ) { padding ->
        ErrorBoundary(
            componentName = "VoucherScreen",
            onError = { errorInfo ->
                // Log error
                logger.error("VoucherScreen error", errorInfo.exception)

                // Show error toast
                toastHost.showError(errorInfo.getUserFriendlyMessage())
            },
            onReset = {
                viewModel.refresh()
            }
        ) {
            when (state) {
                is Loading -> LoadingSkeleton()
                is Success -> VoucherList(state.vouchers)
                is Error -> CompactErrorView(
                    errorMessage = state.message,
                    onRetry = { viewModel.retry() }
                )
            }
        }
    }
}
```

### ViewModel with Retry

```kotlin
class VoucherViewModel : ViewModel() {
    private val _state = MutableStateFlow<VoucherState>(Loading)
    val state = _state.asStateFlow()

    fun loadVouchers() {
        viewModelScope.launch {
            _state.value = Loading

            val result = retryWithPolicyResult(
                policy = RetryPolicy.exponentialBackoff(maxAttempts = 3)
            ) {
                repository.getVouchers()
            }

            result
                .onSuccess { vouchers ->
                    _state.value = Success(vouchers)
                }
                .onFailure { error ->
                    _state.value = Error(error.message ?: "Unknown error")
                }
        }
    }
}
```

---

## Best Practices

### Toast Notifications

1. ✅ **Do:**
   - Use for transient feedback
   - Keep messages short and clear
   - Use appropriate types (success, error, warning, info)
   - Allow manual dismissal

2. ❌ **Don't:**
   - Show multiple toasts simultaneously
   - Use for critical errors (use dialogs instead)
   - Use for navigation (use navigation APIs)
   - Show indefinitely (use banners instead)

### Retry Logic

1. ✅ **Do:**
   - Retry transient failures (network, timeout)
   - Use exponential backoff
   - Add jitter to prevent thundering herd
   - Log retry attempts
   - Set maximum attempts

2. ❌ **Don't:**
   - Retry client errors (400, 403, 404)
   - Retry indefinitely
   - Retry without delay
   - Retry destructive operations automatically

### Error Boundaries

1. ✅ **Do:**
   - Wrap top-level screens
   - Provide user-friendly error messages
   - Offer retry mechanism
   - Log errors for debugging
   - Allow error reporting

2. ❌ **Don't:**
   - Catch errors silently
   - Show stack traces to users
   - Prevent all retries
   - Ignore errors completely

### Contact Support

1. ✅ **Do:**
   - Make it easy to report issues
   - Pre-fill technical details
   - Respect user privacy
   - Provide multiple submission methods
   - Confirm submission

2. ❌ **Don't:**
   - Force users to provide email
   - Send reports without user consent
   - Include sensitive data automatically
   - Make process complicated

---

## Testing

### Toast Tests

```kotlin
@Test
fun testToastDisplay() {
    composeTestRule.setContent {
        val toastHost = rememberToastHostState()
        ToastHost(toastHostState = toastHost)

        LaunchedEffect(Unit) {
            toastHost.showSuccess("Test message")
        }
    }

    composeTestRule.onNodeWithText("Test message").assertIsDisplayed()
}
```

### Retry Tests

```kotlin
@Test
fun testRetryExponentialBackoff() = runTest {
    var attempts = 0

    val result = retryWithPolicy(
        policy = RetryPolicy.exponentialBackoff(maxAttempts = 3)
    ) {
        attempts++
        if (attempts < 3) throw IOException("Network error")
        "Success"
    }

    assertEquals("Success", result)
    assertEquals(3, attempts)
}
```

### Error Boundary Tests

```kotlin
@Test
fun testErrorBoundary() {
    var errorCaught = false

    composeTestRule.setContent {
        ErrorBoundary(
            componentName = "Test",
            onError = { errorCaught = true }
        ) {
            throw RuntimeException("Test error")
        }
    }

    assertTrue(errorCaught)
    composeTestRule.onNodeWithText("Something went wrong").assertIsDisplayed()
}
```

---

## Monitoring & Analytics

### Error Tracking

```kotlin
// Log errors to analytics
fun logError(errorInfo: ErrorInfo) {
    analytics.logEvent("error_occurred", mapOf(
        "component" to errorInfo.componentName,
        "error_type" to errorInfo.exception::class.simpleName,
        "message" to errorInfo.exception.message,
        "timestamp" to errorInfo.timestamp
    ))
}
```

### Retry Metrics

```kotlin
// Track retry attempts
fun trackRetry(attempts: Int, success: Boolean) {
    analytics.logEvent("network_retry", mapOf(
        "attempts" to attempts,
        "success" to success
    ))
}
```

### Support Requests

```kotlin
// Track support requests
fun trackSupportRequest(request: SupportRequest) {
    analytics.logEvent("support_request", mapOf(
        "has_error_details" to (request.errorDetails != null),
        "has_email" to (request.userEmail != null)
    ))
}
```

---

## Future Enhancements (Phase 4+)

1. **Offline Error Queue**
   - Queue errors when offline
   - Sync when connection restored

2. **Error Categorization**
   - Categorize errors by severity
   - Priority-based handling

3. **User Feedback Loop**
   - Follow-up on reported issues
   - Notify when fixed

4. **Advanced Retry Strategies**
   - Circuit breaker pattern
   - Fallback mechanisms
   - Adaptive retry policies

5. **Error Analytics Dashboard**
   - Real-time error monitoring
   - Error rate alerts
   - Crash reporting

---

## References

- [Material Design - Snackbars](https://m3.material.io/components/snackbar)
- [Error Handling Best Practices](https://www.nngroup.com/articles/error-message-guidelines/)
- [Retry Patterns](https://docs.microsoft.com/en-us/azure/architecture/patterns/retry)

---

## Maintenance

**Regular Tasks:**
- Review error logs weekly
- Update user-friendly error messages
- Monitor retry success rates
- Analyze support requests
- Update error handling documentation

**Version History:**
- v1.0.0 (2025-11-19): Initial error handling system implementation
