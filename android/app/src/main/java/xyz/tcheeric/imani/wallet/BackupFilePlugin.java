package xyz.tcheeric.imani.wallet;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * A key backup file the app can open again later, without asking where it is.
 *
 * {@code create} opens the system "save as" screen (Storage Access Framework,
 * ACTION_CREATE_DOCUMENT), writes the backup to the document the person picked, and keeps a
 * persistable read grant on it. {@code read} opens that same document again through the grant:
 * no picker, no storage permission (SAF grants are per document, so the manifest needs none).
 * A document deleted or moved since rejects with code {@code gone}.
 */
@CapacitorPlugin(name = "BackupFile")
public class BackupFilePlugin extends Plugin {

    /** A backup is a few kilobytes. Anything far larger is not one, and is not read whole. */
    private static final int MAX_BYTES = 1024 * 1024;

    @PluginMethod
    public void create(PluginCall call) {
        String name = call.getString("fileName");
        String text = call.getString("text");
        if (name == null || name.isEmpty() || text == null) {
            call.reject("fileName and text are required", "invalid");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "onCreated");
    }

    @ActivityCallback
    private void onCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("cancelled", "cancelled");
            return;
        }
        Uri uri = data.getData();
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            // The provider offers no lasting grant. The file is still written; a later check
            // reports it cannot be opened, and the person can confirm it by picking it.
        }
        String text = call.getString("text");
        try (OutputStream out = resolver.openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("no output stream");
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException | SecurityException e) {
            call.reject("could not write the file", "failed");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void read(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null || raw.isEmpty()) {
            call.reject("uri is required", "invalid");
            return;
        }
        Uri uri = Uri.parse(raw);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) {
                call.reject("the file is gone", "gone");
                return;
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, n);
                if (buffer.size() > MAX_BYTES) {
                    call.reject("not a backup file", "too-large");
                    return;
                }
            }
            JSObject ret = new JSObject();
            ret.put("text", buffer.toString(StandardCharsets.UTF_8.name()));
            call.resolve(ret);
        } catch (FileNotFoundException e) {
            call.reject("the file is gone", "gone");
        } catch (SecurityException e) {
            // The grant was revoked (app data cleared, provider changed): not proof the file is gone.
            call.reject("no longer allowed to open the file", "denied");
        } catch (IOException e) {
            call.reject("could not read the file", "failed");
        }
    }
}
