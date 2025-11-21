package cash.imani.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * Merchant profile card component.
 *
 * Displays merchant information for:
 * - Merchant discovery screen
 * - Merchant detail screen
 * - Favorite merchants list
 *
 * Features:
 * - Merchant logo (optional)
 * - Name and description
 * - Truncated npub identifier
 * - Favorite toggle button
 * - Quick actions (copy npub, view offers)
 *
 * TODO Phase 1.2 Enhancement: Add merchant logo support
 *   Currently logo display is commented out.
 *   Need to implement image loading library.
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.2
 * See: project/web-client-ui-design.md lines 1446-1544
 *
 * @param name Merchant business name
 * @param description Merchant description/tagline
 * @param npub Merchant Nostr public key (npub...)
 * @param logo URL to merchant logo (optional, not yet implemented)
 * @param isFavorite Whether merchant is favorited by user
 * @param onFavoriteClick Callback when favorite button is clicked
 * @param onViewProfile Callback when "View Offers" or card is clicked
 * @param modifier Modifier for styling
 */
@Composable
fun MerchantProfileCard(
    name: String,
    description: String,
    npub: String,
    @Suppress("UNUSED_PARAMETER") logo: String? = null,
    isFavorite: Boolean = false,
    onFavoriteClick: () -> Unit = {},
    onViewProfile: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth().clickable(onClick = onViewProfile),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Header: Logo + Name + Favorite
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Logo + Name section
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f),
                ) {
                    // TODO Phase 1.2 Enhancement: Implement merchant logo
                    // if (logo != null) {
                    //     AsyncImage(
                    //         model = logo,
                    //         contentDescription = null,
                    //         modifier = Modifier.size(48.dp).clip(CircleShape)
                    //     )
                    //     Spacer(modifier = Modifier.width(12.dp))
                    // }

                    Column {
                        Text(
                            text = name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )

                        Spacer(modifier = Modifier.height(2.dp))

                        Text(
                            text = if (npub.length > 12) npub.take(12) + "..." else npub,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                // Favorite button
                IconButton(onClick = onFavoriteClick) {
                    Icon(
                        imageVector = Icons.Default.Star,
                        contentDescription = if (isFavorite) "Unfavorite" else "Favorite",
                        tint =
                            if (isFavorite) {
                                Color(0xFFF59E0B) // Imani Gold
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Description
            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Copy npub button
                OutlinedButton(
                    onClick = {
                        // TODO Phase 1.2: Implement clipboard copy
                        println("[MerchantProfileCard] Copy npub: $npub")
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("Copy")
                }

                // View Offers button
                Button(
                    onClick = onViewProfile,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("View Offers")
                }
            }
        }
    }
}
