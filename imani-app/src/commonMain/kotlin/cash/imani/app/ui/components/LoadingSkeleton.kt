package cash.imani.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Shimmer effect modifier for loading skeletons.
 *
 * Creates an animated gradient that sweeps across the component
 * to indicate loading state.
 */
fun Modifier.shimmer(): Modifier =
    composed {
        val shimmerColors =
            listOf(
                Color.LightGray.copy(alpha = 0.6f),
                Color.LightGray.copy(alpha = 0.2f),
                Color.LightGray.copy(alpha = 0.6f),
            )

        val transition = rememberInfiniteTransition()
        val translateAnim by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1000f,
            animationSpec =
                infiniteRepeatable(
                    animation = tween(durationMillis = 1200, easing = LinearEasing),
                    repeatMode = RepeatMode.Restart,
                ),
        )

        background(
            brush =
                Brush.linearGradient(
                    colors = shimmerColors,
                    start = Offset(translateAnim - 1000f, 0f),
                    end = Offset(translateAnim, 0f),
                ),
        )
    }

/**
 * Generic skeleton box with shimmer effect.
 */
@Composable
fun SkeletonBox(
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(4.dp),
) {
    Box(
        modifier =
            modifier
                .clip(shape)
                .shimmer(),
    )
}

/**
 * Skeleton for identity list item.
 */
@Composable
fun IdentityListItemSkeleton(modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Avatar
            SkeletonBox(
                modifier = Modifier.size(40.dp),
                shape = CircleShape,
            )

            Spacer(Modifier.width(16.dp))

            Column(modifier = Modifier.weight(1f)) {
                // Label
                SkeletonBox(
                    modifier = Modifier.fillMaxWidth(0.6f).height(16.dp),
                )

                Spacer(Modifier.height(8.dp))

                // Public key
                SkeletonBox(
                    modifier = Modifier.fillMaxWidth(0.4f).height(12.dp),
                )
            }
        }
    }
}

/**
 * Skeleton for voucher list item.
 */
@Composable
fun VoucherListItemSkeleton(modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    // Amount
                    SkeletonBox(
                        modifier = Modifier.fillMaxWidth(0.4f).height(20.dp),
                    )

                    Spacer(Modifier.height(8.dp))

                    // Status
                    SkeletonBox(
                        modifier = Modifier.fillMaxWidth(0.3f).height(14.dp),
                    )
                }

                // Icon
                SkeletonBox(
                    modifier = Modifier.size(32.dp),
                    shape = CircleShape,
                )
            }

            Spacer(Modifier.height(12.dp))

            // Date
            SkeletonBox(
                modifier = Modifier.fillMaxWidth(0.5f).height(12.dp),
            )

            // Memo (optional)
            Spacer(Modifier.height(8.dp))
            SkeletonBox(
                modifier = Modifier.fillMaxWidth(0.8f).height(12.dp),
            )
        }
    }
}

/**
 * Full-screen loading skeleton with multiple items.
 */
@Composable
fun ListLoadingSkeleton(
    itemCount: Int = 3,
    itemContent: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
    ) {
        repeat(itemCount) {
            itemContent()
            if (it < itemCount - 1) {
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}
