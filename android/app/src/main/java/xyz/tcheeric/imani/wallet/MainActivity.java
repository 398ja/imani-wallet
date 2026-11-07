package xyz.tcheeric.imani.wallet;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are not in capacitor.plugins.json; register before the bridge starts.
        registerPlugin(DriveAuthPlugin.class);
        super.onCreate(savedInstanceState);
        // targetSdk 36 forces edge-to-edge on Android 15+. Enabling it here as
        // well makes older releases match, so the web layer has one inset model
        // (env(safe-area-inset-*), see capacitor.config.ts SystemBars) everywhere.
        EdgeToEdge.enable(this);
    }
}
