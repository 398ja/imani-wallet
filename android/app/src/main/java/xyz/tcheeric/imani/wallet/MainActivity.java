package xyz.tcheeric.imani.wallet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are not in capacitor.plugins.json; register before the bridge starts.
        registerPlugin(DriveAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
