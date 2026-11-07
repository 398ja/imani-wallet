package xyz.tcheeric.imani.wallet;

import android.app.Activity;
import com.google.android.gms.common.api.CommonStatusCodes;

/**
 * The decisions in {@link DriveAuthPlugin}, kept free of Play services objects so a plain JVM unit
 * test can cover them without a device.
 */
final class DriveAuthOutcome {

    /** Rejection codes the JS side maps (src/lib/googleToken.ts). */
    static final String CANCELLED = "cancelled";
    static final String FAILED = "failed";

    enum Kind { RESOLVE, GRANTED, CANCELLED, FAILED }

    private DriveAuthOutcome() {}

    /** After authorize(): consent needed, a token in hand, or nothing usable. */
    static Kind afterAuthorize(boolean hasResolution, String accessToken) {
        if (hasResolution) return Kind.RESOLVE;
        return accessToken != null && !accessToken.isEmpty() ? Kind.GRANTED : Kind.FAILED;
    }

    /** After the consent activity returns. GRANTED means "read the result from the intent". */
    static Kind afterConsent(int resultCode, boolean hasData) {
        if (resultCode == Activity.RESULT_CANCELED) return Kind.CANCELLED;
        if (resultCode != Activity.RESULT_OK || !hasData) return Kind.FAILED;
        return Kind.GRANTED;
    }

    static String codeForStatus(int status) {
        return status == CommonStatusCodes.CANCELED ? CANCELLED : FAILED;
    }
}
