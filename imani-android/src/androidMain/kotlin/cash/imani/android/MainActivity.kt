package cash.imani.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

/**
 * Main Activity for Imani Wallet Android.
 *
 * TODO: Implement full UI navigation in Phase 4.3
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ImaniTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Greeting("Imani Wallet")
                }
            }
        }
    }
}

@Composable
fun ImaniTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        content = content
    )
}

@Composable
fun Greeting(name: String) {
    Text(text = "Welcome to $name")
}

@Preview(showBackground = true)
@Composable
fun DefaultPreview() {
    ImaniTheme {
        Greeting("Imani Wallet")
    }
}
