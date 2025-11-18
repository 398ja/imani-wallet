package cash.imani.app.ui.theme

/**
 * Imani Wallet Brand Theme
 *
 * Based on the seven principles of Kwanzaa (Nguzo Saba), Imani Wallet's visual identity
 * embodies trust, community, and cultural heritage through its color palette and design system.
 *
 * ## Brand Identity
 * - **Imani** (ee-MAH-nee): Swahili for "faith" and "trust"
 * - **Tagline**: "Built on Trust, Secured by Math"
 * - **Logo Concept**: Interlocking hands forming a shield, symbolizing trust and protection
 *
 * ## Color Psychology
 * - **Deep Purple**: Trust, wisdom, royalty - represents the foundational principle of faith
 * - **Gold**: Value, warmth, African heritage - honors cultural roots and economic empowerment
 * - **Deep Blue**: Security, stability - reinforces cryptographic protection
 * - **Cream**: Clarity, openness - promotes transparency and accessibility
 *
 * @see <a href="https://github.com/yourusername/imani-wallet">Imani Wallet Project</a>
 */
object ImaniColors {
    /**
     * Primary brand color - Deep Purple (#6B46C1)
     * Represents trust, wisdom, and the Imani (faith) principle
     */
    const val Primary = 0xFF6B46C1

    /**
     * Accent color - Gold (#F59E0B)
     * Represents value, warmth, and African heritage
     */
    const val Accent = 0xFFF59E0B

    /**
     * Secondary color - Deep Blue (#1E40AF)
     * Represents security and stability
     */
    const val Secondary = 0xFF1E40AF

    /**
     * Background color - Cream (#FFFBEB)
     * Represents clarity and openness
     */
    const val Background = 0xFFFFFBEB

    /**
     * Surface color - White (#FFFFFF)
     * For cards and elevated surfaces
     */
    const val Surface = 0xFFFFFFFF

    /**
     * Error color - Red (#DC2626)
     * For error states and warnings
     */
    const val Error = 0xFFDC2626

    /**
     * Success color - Green (#059669)
     * For success states and confirmations
     */
    const val Success = 0xFF059669

    /**
     * On-primary color - White (#FFFFFF)
     * Text and icons on primary color
     */
    const val OnPrimary = 0xFFFFFFFF

    /**
     * On-background color - Dark Gray (#1F2937)
     * Text on background
     */
    const val OnBackground = 0xFF1F2937

    /**
     * On-surface color - Dark Gray (#1F2937)
     * Text on surface
     */
    const val OnSurface = 0xFF1F2937
}

/**
 * Typography constants for Imani Wallet
 *
 * ## Font Families
 * - **Headers**: Inter Bold - modern, accessible
 * - **Body**: Inter Regular - clean, readable
 * - **Code/Tokens**: JetBrains Mono - technical precision
 */
object ImaniTypography {
    /**
     * Font family for headers and titles
     */
    const val HeaderFont = "Inter"

    /**
     * Font family for body text
     */
    const val BodyFont = "Inter"

    /**
     * Font family for code, tokens, and technical data
     */
    const val MonoFont = "JetBrains Mono"

    /**
     * Font weight for headers (bold)
     */
    const val HeaderWeight = 700

    /**
     * Font weight for body text (regular)
     */
    const val BodyWeight = 400

    /**
     * Font weight for emphasis (semi-bold)
     */
    const val EmphasisWeight = 600
}

/**
 * Spacing constants following 8px grid system
 */
object ImaniSpacing {
    const val XSmall = 4
    const val Small = 8
    const val Medium = 16
    const val Large = 24
    const val XLarge = 32
    const val XXLarge = 48
}

/**
 * Border radius constants
 */
object ImaniBorderRadius {
    const val Small = 4
    const val Medium = 8
    const val Large = 16
    const val XLarge = 24
}

/**
 * Shadow/elevation constants
 */
object ImaniElevation {
    const val None = 0
    const val Low = 2
    const val Medium = 4
    const val High = 8
    const val VeryHigh = 16
}
