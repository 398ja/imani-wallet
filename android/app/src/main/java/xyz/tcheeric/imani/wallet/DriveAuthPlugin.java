package xyz.tcheeric.imani.wallet;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

/**
 * Google authorization (not sign-in) for one OAuth scope, so the WebView can call Drive with a
 * bearer token. Wraps Play services {@code AuthorizationClient.authorize()}: no Credential Manager,
 * no account sheet, no client id in code (Google matches the package name and signing SHA-1 against
 * the Android OAuth client in the Cloud console). The token goes back to JS and from there only to
 * googleapis.com.
 */
@CapacitorPlugin(name = "DriveAuth")
public class DriveAuthPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall pending;

    @Override
    public void load() {
        // load() runs inside BridgeActivity.onCreate, before STARTED, which is when registering
        // an activity result launcher is allowed.
        consent = getActivity()
            .registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onConsent);
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        List<Scope> scopes = new ArrayList<>();
        try {
            JSArray requested = call.getArray("scopes");
            if (requested != null) {
                for (String s : requested.<String>toList()) scopes.add(new Scope(s));
            }
        } catch (JSONException e) {
            call.reject("scopes must be a list of strings", "invalid");
            return;
        }
        if (scopes.isEmpty()) {
            call.reject("no scopes requested", "invalid");
            return;
        }
        if (pending != null) {
            call.reject("authorization already in progress", "busy");
            return;
        }

        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Activity activity = getActivity();
        Identity.getAuthorizationClient(activity)
            .authorize(request)
            .addOnSuccessListener(result -> {
                switch (DriveAuthOutcome.afterAuthorize(result.hasResolution(), result.getAccessToken())) {
                    case RESOLVE:
                        pending = call;
                        consent.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                        break;
                    case GRANTED:
                        resolveWith(call, result);
                        break;
                    default:
                        call.reject("Google returned no access token", DriveAuthOutcome.FAILED);
                }
            })
            .addOnFailureListener(e -> call.reject(e.getMessage(), codeFor(e), e));
    }

    private void onConsent(ActivityResult activityResult) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;

        Intent data = activityResult.getData();
        switch (DriveAuthOutcome.afterConsent(activityResult.getResultCode(), data != null)) {
            case CANCELLED:
                call.reject("cancelled", DriveAuthOutcome.CANCELLED);
                return;
            case FAILED:
                call.reject("Google authorization failed", DriveAuthOutcome.FAILED);
                return;
            default:
                try {
                    AuthorizationResult result =
                        Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(data);
                    if (DriveAuthOutcome.afterAuthorize(false, result.getAccessToken()) == DriveAuthOutcome.Kind.GRANTED) {
                        resolveWith(call, result);
                    } else {
                        call.reject("Google returned no access token", DriveAuthOutcome.FAILED);
                    }
                } catch (ApiException e) {
                    call.reject(e.getMessage(), codeFor(e), e);
                }
        }
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("accessToken");
        if (token == null || token.isEmpty()) {
            call.reject("accessToken required", "invalid");
            return;
        }
        Identity.getAuthorizationClient(getActivity())
            .clearToken(ClearTokenRequest.builder().setToken(token).build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage(), DriveAuthOutcome.FAILED, e));
    }

    private static void resolveWith(PluginCall call, AuthorizationResult result) {
        JSObject out = new JSObject();
        out.put("accessToken", result.getAccessToken());
        out.put("grantedScopes", new JSArray(result.getGrantedScopes()));
        call.resolve(out);
    }

    private static String codeFor(Exception e) {
        int status = e instanceof ApiException ? ((ApiException) e).getStatusCode() : CommonStatusCodes.ERROR;
        return DriveAuthOutcome.codeForStatus(status);
    }
}
