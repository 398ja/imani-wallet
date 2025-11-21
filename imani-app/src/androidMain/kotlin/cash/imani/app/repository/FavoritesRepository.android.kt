package cash.imani.app.repository

/**
 * Android implementation uses in-memory storage.
 * TODO: Use SharedPreferences for persistence.
 */
actual fun createFavoritesRepository(): FavoritesRepository = InMemoryFavoritesRepository()
