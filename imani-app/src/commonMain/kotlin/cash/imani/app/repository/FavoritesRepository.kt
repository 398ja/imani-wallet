package cash.imani.app.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Repository for managing favorite merchants.
 *
 * Stores favorites as a list of npub strings, persisted to platform storage.
 *
 * Phase 4.2: Favorite Merchants
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.2
 */
interface FavoritesRepository {
    /**
     * Observable list of favorite merchant npubs.
     */
    val favorites: StateFlow<List<String>>

    /**
     * Adds a merchant to favorites.
     *
     * @param npub Nostr public key of the merchant
     */
    fun addFavorite(npub: String)

    /**
     * Removes a merchant from favorites.
     *
     * @param npub Nostr public key of the merchant
     */
    fun removeFavorite(npub: String)

    /**
     * Toggles favorite status for a merchant.
     *
     * @param npub Nostr public key of the merchant
     * @return true if now favorited, false if removed
     */
    fun toggleFavorite(npub: String): Boolean

    /**
     * Checks if a merchant is in favorites.
     *
     * @param npub Nostr public key of the merchant
     * @return true if favorited
     */
    fun isFavorite(npub: String): Boolean

    /**
     * Clears all favorites.
     */
    fun clearFavorites()
}

/**
 * In-memory implementation for testing and JVM.
 */
class InMemoryFavoritesRepository : FavoritesRepository {
    private val _favorites = MutableStateFlow<List<String>>(emptyList())
    override val favorites: StateFlow<List<String>> = _favorites.asStateFlow()

    override fun addFavorite(npub: String) {
        if (!_favorites.value.contains(npub)) {
            _favorites.value = _favorites.value + npub
            println("[FavoritesRepository] Added favorite: ${npub.take(20)}...")
        }
    }

    override fun removeFavorite(npub: String) {
        _favorites.value = _favorites.value - npub
        println("[FavoritesRepository] Removed favorite: ${npub.take(20)}...")
    }

    override fun toggleFavorite(npub: String): Boolean {
        return if (isFavorite(npub)) {
            removeFavorite(npub)
            false
        } else {
            addFavorite(npub)
            true
        }
    }

    override fun isFavorite(npub: String): Boolean = _favorites.value.contains(npub)

    override fun clearFavorites() {
        _favorites.value = emptyList()
        println("[FavoritesRepository] Cleared all favorites")
    }
}

/**
 * Platform-specific factory function.
 */
expect fun createFavoritesRepository(): FavoritesRepository
