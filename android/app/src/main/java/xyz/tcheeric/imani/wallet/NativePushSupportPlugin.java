package xyz.tcheeric.imani.wallet;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the WebView whether this APK can register for push at all, before it tries.
 *
 * {@code @capacitor/push-notifications} calls {@code FirebaseMessaging.getInstance()} in
 * {@code register()} and {@code unregister()}. With no {@code google-services.json} at build time
 * there is no default FirebaseApp, that call throws {@code IllegalStateException}, and Capacitor's
 * Bridge rethrows a plugin exception as a RuntimeException on its handler thread: the app dies the
 * moment the user approves the notification prompt. The JS promise never rejects, so the web layer
 * cannot catch it; it has to ask first, which is what this plugin is for.
 *
 * Detection reads the {@code google_app_id} string the google-services Gradle plugin generates,
 * which is the same resource FirebaseInitProvider initialises the default app from. No Firebase
 * dependency is needed here, and the answer is fixed for the life of the APK.
 */
@CapacitorPlugin(name = "NativePushSupport")
public class NativePushSupportPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", isFirebaseConfigured(getContext()));
        call.resolve(result);
    }

    static boolean isFirebaseConfigured(Context context) {
        int id = context.getResources().getIdentifier("google_app_id", "string", context.getPackageName());
        if (id == 0) return false;
        String value = context.getString(id);
        return value != null && !value.trim().isEmpty();
    }
}
