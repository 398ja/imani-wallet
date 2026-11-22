package xyz.tcheeric.imani.wallet;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Reproduces the "approve notifications, app crashes" bug with the real plugin. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class PushRegisterCrashReproTest {

    @Test
    public void registerThrowsWithoutFirebase() throws Exception {
        PushNotificationsPlugin plugin = new PushNotificationsPlugin();
        PluginCall call = new PluginCall(null, "PushNotifications", "cb", "register", new JSObject());
        Method register = PushNotificationsPlugin.class.getMethod("register", PluginCall.class);
        try {
            // Exactly what PluginHandle.invoke does. Bridge.callPluginMethod catches the result and
            // rethrows it as a RuntimeException on its handler thread, which kills the process.
            register.invoke(plugin, call);
            fail("register() returned; expected it to throw");
        } catch (InvocationTargetException e) {
            System.out.println("REPRO: " + e.getCause());
            assertTrue(e.getCause() instanceof IllegalStateException);
            assertTrue(e.getCause().getMessage().contains("FirebaseApp is not initialized"));
        }
    }
}
