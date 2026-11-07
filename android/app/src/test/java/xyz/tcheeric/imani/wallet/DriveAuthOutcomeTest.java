package xyz.tcheeric.imani.wallet;

import static org.junit.Assert.assertEquals;

import android.app.Activity;
import com.google.android.gms.common.api.CommonStatusCodes;
import org.junit.Test;

public class DriveAuthOutcomeTest {

    @Test
    public void hasResolutionMeansShowConsent() {
        assertEquals(DriveAuthOutcome.Kind.RESOLVE, DriveAuthOutcome.afterAuthorize(true, null));
    }

    @Test
    public void noResolutionWithTokenIsGranted() {
        assertEquals(DriveAuthOutcome.Kind.GRANTED, DriveAuthOutcome.afterAuthorize(false, "ya29.x"));
    }

    @Test
    public void noResolutionNoTokenFails() {
        assertEquals(DriveAuthOutcome.Kind.FAILED, DriveAuthOutcome.afterAuthorize(false, null));
        assertEquals(DriveAuthOutcome.Kind.FAILED, DriveAuthOutcome.afterAuthorize(false, ""));
    }

    @Test
    public void consentCancelledIsCancelled() {
        assertEquals(DriveAuthOutcome.Kind.CANCELLED, DriveAuthOutcome.afterConsent(Activity.RESULT_CANCELED, false));
        assertEquals(DriveAuthOutcome.CANCELLED, DriveAuthOutcome.codeForStatus(CommonStatusCodes.CANCELED));
    }

    @Test
    public void consentOkNeedsData() {
        assertEquals(DriveAuthOutcome.Kind.GRANTED, DriveAuthOutcome.afterConsent(Activity.RESULT_OK, true));
        assertEquals(DriveAuthOutcome.Kind.FAILED, DriveAuthOutcome.afterConsent(Activity.RESULT_OK, false));
        assertEquals(DriveAuthOutcome.FAILED, DriveAuthOutcome.codeForStatus(CommonStatusCodes.DEVELOPER_ERROR));
    }
}
