package xyz.tcheeric.imani.wallet;

import static org.junit.Assert.assertFalse;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class NativePushSupportPluginTest {

    /** This build has no google-services.json, so the web layer must be told not to register. */
    @Test
    public void reportsUnconfiguredWithoutGoogleServicesJson() {
        Context context = ApplicationProvider.getApplicationContext();
        assertFalse(NativePushSupportPlugin.isFirebaseConfigured(context));
    }
}
