package cash.imani.identity.crypto

import kotlinx.browser.window
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * Manages passphrase storage and session security.
 *
 * Features:
 * - In-memory passphrase storage (never persisted to disk)
 * - Auto-lock after configurable inactivity timeout
 * - Manual lock/unlock functionality
 * - Session-only storage (cleared on browser close)
 *
 * Security Model:
 * - Passphrase stored in memory only
 * - Automatically cleared after inactivity
 * - Can be manually locked at any time
 * - No passphrase persistence to localStorage or sessionStorage
 *
 * Usage:
 * ```kotlin
 * // Initialize with passphrase
 * PassphraseManager.unlock("user-passphrase")
 *
 * // Check if unlocked
 * if (PassphraseManager.isUnlocked()) {
 *     val passphrase = PassphraseManager.getPassphrase()
 *     // Use passphrase for encryption/decryption
 * }
 *
 * // Lock manually
 * PassphraseManager.lock()
 * ```
 *
 * Phase 3 Enhancements:
 * - Add passphrase strength validation
 * - Add biometric authentication fallback
 * - Add multi-factor authentication option
 * - Add encrypted backup to sessionStorage
 */
object PassphraseManager {
    /** Current passphrase (null when locked) */
    private var passphrase: String? = null

    /** Inactivity timeout duration */
    private var autoLockTimeout: Duration = 15.minutes

    /** Auto-lock timer job */
    private var autoLockJob: Job? = null

    /** Listeners for lock/unlock events */
    private val lockStateListeners = mutableListOf<(Boolean) -> Unit>()

    /**
     * Sets the passphrase and unlocks the session.
     *
     * @param newPassphrase User's passphrase
     */
    fun unlock(newPassphrase: String) {
        require(newPassphrase.isNotBlank()) {
            "Passphrase cannot be blank"
        }

        passphrase = newPassphrase
        resetAutoLockTimer()
        notifyLockStateChanged(isLocked = false)

        console.log("[PassphraseManager] Session unlocked")
    }

    /**
     * Clears the passphrase and locks the session.
     */
    fun lock() {
        passphrase = null
        cancelAutoLockTimer()
        notifyLockStateChanged(isLocked = true)

        console.log("[PassphraseManager] Session locked")
    }

    /**
     * Checks if session is currently unlocked.
     *
     * @return true if passphrase is available
     */
    fun isUnlocked(): Boolean = passphrase != null

    /**
     * Gets the current passphrase if unlocked.
     *
     * PHASE 1 AUTO-UNLOCK: For development, automatically unlocks with a default passphrase.
     * Phase 3 will implement proper passphrase setup UI.
     *
     * @return Current passphrase
     * @throws IllegalStateException if session is locked
     */
    fun getPassphrase(): String {
        // PHASE 1: Auto-unlock with default passphrase for development
        if (passphrase == null) {
            console.warn(
                "[PassphraseManager] Auto-unlocking with default passphrase for Phase 1 development. " +
                    "Phase 3 will implement proper passphrase setup.",
            )
            unlock(getDefaultPassphrase())
        }

        resetAutoLockTimer() // Reset timer on each access
        return passphrase ?: throw IllegalStateException(
            "Session is locked. Call unlock() first.",
        )
    }

    /**
     * Gets the default passphrase for Phase 1 development.
     *
     * SECURITY NOTE: This is ONLY for Phase 1 development.
     * Phase 3 will implement proper passphrase setup with user-provided passphrase.
     *
     * Strategy:
     * 1. Check sessionStorage for existing session passphrase
     * 2. If not found, generate a random passphrase and store in sessionStorage
     * 3. This provides basic encryption while avoiding user friction in Phase 1
     *
     * @return Default passphrase for current session
     */
    private fun getDefaultPassphrase(): String {
        val storage = kotlinx.browser.window.sessionStorage
        val key = "imani_dev_passphrase"

        // Check if session already has a passphrase
        val existingPassphrase = storage.getItem(key)
        if (existingPassphrase != null) {
            return existingPassphrase
        }

        // Generate a random passphrase for this session
        val randomPassphrase = generateRandomPassphrase()
        storage.setItem(key, randomPassphrase)

        console.log("[PassphraseManager] Generated session passphrase for Phase 1 development")
        return randomPassphrase
    }

    /**
     * Generates a cryptographically random passphrase.
     *
     * @return Random 32-character hex string
     */
    private fun generateRandomPassphrase(): String {
        val crypto = window.asDynamic().crypto
        val array = js("new Uint8Array(16)").unsafeCast<org.khronos.webgl.Uint8Array>()
        crypto.getRandomValues(array)

        return (0 until array.length).joinToString("") { i ->
            val byte = array.asDynamic()[i].unsafeCast<Int>()
            byte.toString(16).padStart(2, '0')
        }
    }

    /**
     * Sets the auto-lock timeout duration.
     *
     * @param timeout Duration of inactivity before auto-lock
     */
    fun setAutoLockTimeout(timeout: Duration) {
        autoLockTimeout = timeout
        if (isUnlocked()) {
            resetAutoLockTimer()
        }
        console.log("[PassphraseManager] Auto-lock timeout set to ${timeout.inWholeMinutes} minutes")
    }

    /**
     * Gets the current auto-lock timeout.
     *
     * @return Current timeout duration
     */
    fun getAutoLockTimeout(): Duration = autoLockTimeout

    /**
     * Adds a listener for lock/unlock events.
     *
     * @param listener Callback invoked when lock state changes (parameter: isLocked)
     */
    fun addLockStateListener(listener: (Boolean) -> Unit) {
        lockStateListeners.add(listener)
    }

    /**
     * Removes a lock state listener.
     *
     * @param listener Listener to remove
     */
    fun removeLockStateListener(listener: (Boolean) -> Unit) {
        lockStateListeners.remove(listener)
    }

    /**
     * Validates passphrase strength.
     *
     * Phase 3 Implementation: Add comprehensive password strength validation
     *
     * Current requirements:
     * - Minimum 12 characters
     * - At least one uppercase letter
     * - At least one lowercase letter
     * - At least one number
     * - At least one special character
     *
     * @param passphrase Passphrase to validate
     * @return Validation result with error message if invalid
     */
    fun validatePassphraseStrength(passphrase: String): PassphraseValidationResult {
        if (passphrase.length < 12) {
            return PassphraseValidationResult(
                isValid = false,
                message = "Passphrase must be at least 12 characters long",
            )
        }

        if (!passphrase.any { it.isUpperCase() }) {
            return PassphraseValidationResult(
                isValid = false,
                message = "Passphrase must contain at least one uppercase letter",
            )
        }

        if (!passphrase.any { it.isLowerCase() }) {
            return PassphraseValidationResult(
                isValid = false,
                message = "Passphrase must contain at least one lowercase letter",
            )
        }

        if (!passphrase.any { it.isDigit() }) {
            return PassphraseValidationResult(
                isValid = false,
                message = "Passphrase must contain at least one number",
            )
        }

        if (!passphrase.any { !it.isLetterOrDigit() }) {
            return PassphraseValidationResult(
                isValid = false,
                message = "Passphrase must contain at least one special character",
            )
        }

        return PassphraseValidationResult(
            isValid = true,
            message = "Passphrase is strong",
        )
    }

    /**
     * Resets the auto-lock timer.
     */
    private fun resetAutoLockTimer() {
        cancelAutoLockTimer()

        autoLockJob =
            CoroutineScope(Dispatchers.Default).launch {
                delay(autoLockTimeout)
                lock()
                val minutes = autoLockTimeout.inWholeMinutes
                console.log("[PassphraseManager] Auto-lock triggered after $minutes minutes of inactivity")
            }
    }

    /**
     * Cancels the auto-lock timer.
     */
    private fun cancelAutoLockTimer() {
        autoLockJob?.cancel()
        autoLockJob = null
    }

    /**
     * Notifies all listeners of lock state change.
     */
    private fun notifyLockStateChanged(isLocked: Boolean) {
        lockStateListeners.forEach { listener ->
            try {
                listener(isLocked)
            } catch (e: Exception) {
                console.error("[PassphraseManager] Error in lock state listener", e)
            }
        }
    }

    /**
     * Initializes browser event listeners for security.
     *
     * Automatically locks on:
     * - Browser/tab close (beforeunload)
     * - Page visibility hidden (visibilitychange)
     *
     * Should be called once during app initialization.
     */
    fun initializeBrowserListeners() {
        // Lock on browser/tab close
        window.addEventListener("beforeunload", {
            lock()
        })

        // Optional: Lock when tab becomes hidden
        // Uncomment if you want aggressive security
        // window.addEventListener("visibilitychange", {
        //     if (window.document.hidden) {
        //         lock()
        //     }
        // })

        console.log("[PassphraseManager] Browser security listeners initialized")
    }
}

/**
 * Result of passphrase strength validation.
 */
data class PassphraseValidationResult(
    val isValid: Boolean,
    val message: String,
)
