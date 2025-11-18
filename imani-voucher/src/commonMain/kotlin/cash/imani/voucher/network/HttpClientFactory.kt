package cash.imani.voucher.network

import io.ktor.client.HttpClient
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.plugins.logging.SIMPLE
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * Factory function for creating configured Ktor HTTP client.
 *
 * Configures:
 * - JSON content negotiation with kotlinx.serialization
 * - Logging for debugging
 * - Default content type headers
 * - Lenient JSON parsing (ignores unknown fields)
 *
 * Phase 2: Basic configuration for Cashu Mint API
 * Phase 3+: Add timeout configuration, retry logic, error handling middleware
 */
fun createHttpClient(): HttpClient {
    return HttpClient {
        // JSON content negotiation
        install(ContentNegotiation) {
            json(
                Json {
                    // Ignore fields not in data classes (forward compatibility)
                    ignoreUnknownKeys = true

                    // Be lenient with JSON parsing
                    isLenient = true

                    // Don't require all fields to have default values
                    coerceInputValues = true

                    // Pretty print for debugging (disable in production)
                    prettyPrint = true
                },
            )
        }

        // Logging for debugging
        install(Logging) {
            logger = Logger.SIMPLE
            level = LogLevel.INFO
        }

        // Default request configuration
        defaultRequest {
            // Set JSON content type by default
            contentType(ContentType.Application.Json)
        }
    }
}
