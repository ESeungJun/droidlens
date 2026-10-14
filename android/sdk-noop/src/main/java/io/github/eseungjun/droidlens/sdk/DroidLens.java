package io.github.eseungjun.droidlens.sdk;

import android.content.Context;

import org.json.JSONObject;

/** release 빌드용: sdk와 같은 API, 아무 동작 없음 */
public final class DroidLens {
    private DroidLens() {}

    public static void init(Context context) {}

    public static boolean isRunning() {
        return false;
    }

    public static void event(String name) {}

    public static void event(String name, JSONObject data) {}

    public static void redactHeaders(String... names) {}

    public static void redactKeys(String... keys) {}

    public static void clearDefaultRedaction() {}
}
