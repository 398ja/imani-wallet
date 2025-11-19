package cash.imani.app.util

import kotlinx.coroutines.delay
import kotlin.math.pow
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * Retry policy for handling transient failures.
 *
 * Supports configurable retry strategies including exponential backoff,
 * maximum retry attempts, and custom retry conditions.
 *
 * Usage:
 * ```kotlin
 * val result = retryWithPolicy(
 *     policy = RetryPolicy.exponentialBackoff(maxAttempts = 3)
 * ) {
 *     // Network call that might fail
 *     apiClient.makeRequest()
 * }
 * ```
 */
data class RetryPolicy(
    /** Maximum number of retry attempts */
    val maxAttempts: Int = 3,

    /** Initial delay before first retry */
    val initialDelay: Duration = 1.seconds,

    /** Maximum delay between retries */
    val maxDelay: Duration = 30.seconds,

    /** Backoff multiplier (for exponential backoff) */
    val backoffMultiplier: Double = 2.0,

    /** Whether to add random jitter to delays */
    val useJitter: Boolean = true,

    /** Predicate to determine if an exception should trigger retry */
    val shouldRetry: (Throwable) -> Boolean = { isRetryableException(it) },
) {
    companion object {
        /**
         * Default retry policy with exponential backoff.
         */
        fun exponentialBackoff(
            maxAttempts: Int = 3,
            initialDelay: Duration = 1.seconds,
            maxDelay: Duration = 30.seconds,
        ): RetryPolicy =
            RetryPolicy(
                maxAttempts = maxAttempts,
                initialDelay = initialDelay,
                maxDelay = maxDelay,
                backoffMultiplier = 2.0,
                useJitter = true,
            )

        /**
         * Fixed delay retry policy.
         */
        fun fixedDelay(
            maxAttempts: Int = 3,
            delay: Duration = 2.seconds,
        ): RetryPolicy =
            RetryPolicy(
                maxAttempts = maxAttempts,
                initialDelay = delay,
                maxDelay = delay,
                backoffMultiplier = 1.0,
                useJitter = false,
            )

        /**
         * Linear backoff retry policy.
         */
        fun linearBackoff(
            maxAttempts: Int = 3,
            initialDelay: Duration = 1.seconds,
            increment: Duration = 1.seconds,
        ): RetryPolicy =
            RetryPolicy(
                maxAttempts = maxAttempts,
                initialDelay = initialDelay,
                maxDelay = initialDelay + (increment * (maxAttempts - 1)),
                backoffMultiplier = 1.0,
                useJitter = false,
            )

        /**
         * No retry policy (fail immediately).
         */
        fun noRetry(): RetryPolicy =
            RetryPolicy(
                maxAttempts = 1,
                initialDelay = 0.seconds,
                maxDelay = 0.seconds,
                backoffMultiplier = 1.0,
                useJitter = false,
            )

        /**
         * Determine if an exception is retryable.
         */
        private fun isRetryableException(exception: Throwable): Boolean {
            // Network-related exceptions that are typically transient
            return when {
                // Timeout exceptions
                exception.message?.contains("timeout", ignoreCase = true) == true -> true
                exception.message?.contains("timed out", ignoreCase = true) == true -> true

                // Connection exceptions
                exception.message?.contains("connection", ignoreCase = true) == true -> true
                exception.message?.contains("network", ignoreCase = true) == true -> true

                // Temporary server errors (5xx)
                exception.message?.contains("500", ignoreCase = true) == true -> true
                exception.message?.contains("502", ignoreCase = true) == true -> true
                exception.message?.contains("503", ignoreCase = true) == true -> true
                exception.message?.contains("504", ignoreCase = true) == true -> true

                // DNS resolution failures
                exception.message?.contains("dns", ignoreCase = true) == true -> true
                exception.message?.contains("resolve", ignoreCase = true) == true -> true

                // Default: don't retry
                else -> false
            }
        }
    }

    /**
     * Calculate delay for a given attempt.
     */
    fun calculateDelay(attempt: Int): Duration {
        val baseDelay =
            if (backoffMultiplier > 1.0) {
                // Exponential backoff
                initialDelay.inWholeMilliseconds * backoffMultiplier.pow(attempt.toDouble())
            } else {
                // Linear or fixed delay
                initialDelay.inWholeMilliseconds * (1 + (backoffMultiplier * attempt))
            }

        val delayMs = baseDelay.toLong().coerceAtMost(maxDelay.inWholeMilliseconds)

        // Add jitter to prevent thundering herd
        val jitterMs =
            if (useJitter) {
                (kotlin.random.Random.nextDouble() * delayMs * 0.3).toLong() // ±30% jitter
            } else {
                0L
            }

        return (delayMs + jitterMs).milliseconds
    }
}

/**
 * Execute a block with retry policy.
 *
 * @param policy Retry policy to use
 * @param block Suspending block to execute
 * @return Result of the block execution
 * @throws Exception Last exception if all retries fail
 */
suspend fun <T> retryWithPolicy(
    policy: RetryPolicy = RetryPolicy.exponentialBackoff(),
    block: suspend () -> T,
): T {
    var lastException: Throwable? = null
    var attempt = 0

    while (attempt < policy.maxAttempts) {
        try {
            return block()
        } catch (e: Throwable) {
            lastException = e

            // Check if we should retry
            if (!policy.shouldRetry(e)) {
                throw e
            }

            // Check if we have more attempts
            attempt++
            if (attempt >= policy.maxAttempts) {
                break
            }

            // Calculate and apply delay
            val delay = policy.calculateDelay(attempt)
            println("[Retry] Attempt $attempt failed: ${e.message}. Retrying in ${delay.inWholeMilliseconds}ms...")
            delay(delay)
        }
    }

    // All retries failed
    throw RetryException(
        message = "Operation failed after ${policy.maxAttempts} attempts",
        cause = lastException,
        attempts = attempt,
    )
}

/**
 * Execute a block with retry policy and return a Result.
 *
 * @param policy Retry policy to use
 * @param block Suspending block to execute
 * @return Result wrapping success or failure
 */
suspend fun <T> retryWithPolicyResult(
    policy: RetryPolicy = RetryPolicy.exponentialBackoff(),
    block: suspend () -> T,
): Result<T> =
    runCatching {
        retryWithPolicy(policy, block)
    }

/**
 * Exception thrown when all retry attempts fail.
 */
class RetryException(
    message: String,
    cause: Throwable?,
    val attempts: Int,
) : Exception(message, cause)

/**
 * Retry result with attempt information.
 */
sealed class RetryResult<out T> {
    data class Success<T>(
        val value: T,
        val attempts: Int,
    ) : RetryResult<T>()

    data class Failure(
        val exception: Throwable,
        val attempts: Int,
    ) : RetryResult<Nothing>()
}

/**
 * Execute a block with retry policy and return detailed retry result.
 *
 * @param policy Retry policy to use
 * @param block Suspending block to execute
 * @return RetryResult with attempt count
 */
suspend fun <T> retryWithPolicyDetailed(
    policy: RetryPolicy = RetryPolicy.exponentialBackoff(),
    block: suspend () -> T,
): RetryResult<T> {
    var lastException: Throwable? = null
    var attempt = 0

    while (attempt < policy.maxAttempts) {
        try {
            val result = block()
            return RetryResult.Success(result, attempt + 1)
        } catch (e: Throwable) {
            lastException = e

            if (!policy.shouldRetry(e)) {
                return RetryResult.Failure(e, attempt + 1)
            }

            attempt++
            if (attempt >= policy.maxAttempts) {
                break
            }

            val delay = policy.calculateDelay(attempt)
            delay(delay)
        }
    }

    return RetryResult.Failure(
        exception =
            RetryException(
                message = "Operation failed after ${policy.maxAttempts} attempts",
                cause = lastException,
                attempts = attempt,
            ),
        attempts = attempt,
    )
}
