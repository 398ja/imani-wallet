package cash.imani.app.repository

import kotlinx.browser.localStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Browser localStorage-backed favorites repository.
 */
class BrowserFavoritesRepository : FavoritesRepository {
    private val storageKey = "imani_favorites"
    private val _favorites = MutableStateFlow<List<String>>(loadFromStorage())
    override val favorites: StateFlow<List<String>> = _favorites.asStateFlow()

    private fun loadFromStorage(): List<String> {
        return try {
            val stored = localStorage.getItem(storageKey) ?: "[]"
            JSON.parse<Array<String>>(stored).toList()
        } catch (e: Exception) {
            println("[FavoritesRepository] Error loading favorites: ${e.message}")
            emptyList()
        }
    }

    private fun saveToStorage() {
        try {
            val favoritesList = _favorites.value.toTypedArray()
            localStorage.setItem(storageKey, JSON.stringify(favoritesList))
        } catch (e: Exception) {
            println("[FavoritesRepository] Error saving favorites: ${e.message}")
        }
    }

    override fun addFavorite(npub: String) {
        if (!_favorites.value.contains(npub)) {
            _favorites.value = _favorites.value + npub
            saveToStorage()
            println("[FavoritesRepository] Added favorite: ${npub.take(20)}...")
        }
    }

    override fun removeFavorite(npub: String) {
        _favorites.value = _favorites.value - npub
        saveToStorage()
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
        saveToStorage()
        println("[FavoritesRepository] Cleared all favorites")
    }
}

actual fun createFavoritesRepository(): FavoritesRepository = BrowserFavoritesRepository()
