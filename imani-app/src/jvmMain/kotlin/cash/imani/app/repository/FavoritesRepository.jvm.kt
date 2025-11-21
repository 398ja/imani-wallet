package cash.imani.app.repository

/**
 * JVM implementation uses in-memory storage (non-persistent).
 * For desktop apps, could use java.util.prefs.Preferences.
 */
actual fun createFavoritesRepository(): FavoritesRepository = InMemoryFavoritesRepository()
