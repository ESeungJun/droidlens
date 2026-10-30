package io.github.eseungjun.droidlens.sdk;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import io.github.eseungjun.droidlens.sdk.internal.EventStore;
import io.github.eseungjun.droidlens.sdk.internal.Redactor;
import io.github.eseungjun.droidlens.sdk.internal.SdkServer;

/**
 * DroidLens SDK 진입점.
 *
 * <p>debugImplementation으로 추가하면 앱 시작 시 {@link DroidLensInitProvider}가 자동으로 {@link #init}을 호출해
 * 기기 내부 유닉스 소켓(localabstract:droidlens_sdk_&lt;패키지&gt;)에 서버를 연다. DroidLens 데스크톱/MCP가
 * adb forward로 연결해 네트워크·SharedPreferences·DB·커스텀 이벤트를 조회한다.
 * INTERNET 권한이 필요 없고, release 빌드에는 같은 API의 sdk-noop을 쓴다.
 */
public final class DroidLens {
    static final String TAG = "DroidLens";
    private static volatile SdkServer server;

    private DroidLens() {}

    /** 수동 초기화. 자동 초기화를 끈 경우(매니페스트에서 provider 제거)에만 호출하면 된다. 여러 번 불러도 안전하다. */
    public static synchronized void init(Context context) {
        if (server != null && server.isRunning()) return;
        try {
            server = new SdkServer(context.getApplicationContext());
            server.start();
            Log.i(TAG, "DroidLens SDK " + BuildConfig.SDK_VERSION + " listening on " + server.socketName());
        } catch (Exception e) {
            Log.w(TAG, "DroidLens SDK를 시작하지 못했습니다", e);
            server = null;
        }
    }

    public static boolean isRunning() {
        SdkServer s = server;
        return s != null && s.isRunning();
    }

    /** DroidLens 이벤트 탭에 표시할 커스텀 이벤트 (분석 이벤트, 상태 변화 등) */
    public static void event(String name) {
        event(name, null);
    }

    public static void event(String name, JSONObject data) {
        EventStore.get().add(name, data);
    }

    /**
     * 네트워크 기록에서 값을 가릴 헤더를 추가한다. 대소문자·구분자는 무시하고, 4글자 이상이면 이름에 들어 있기만 해도 가린다.
     * 기본: 이름에 authorization, cookie, token, secret, apikey, session, password, credential, signature 가 들어간 헤더
     */
    public static void redactHeaders(String... names) {
        Redactor.get().addHeaders(names);
    }

    /**
     * 본문(JSON·폼·multipart·XML·GraphQL 인자)·URL 쿼리·커스텀 이벤트에서 값을 가릴 키를 추가한다.
     * 대소문자·구분자는 무시하고, 4글자 이상이면 키 이름에 들어 있기만 해도 가린다 (예: "phone" → phoneNumber).
     * 기본: 이름에 password, secret, token, apikey, privatekey, credential, sessionid, cardnumber 등이 들어간 키와
     * jwt, otp, pin, cvc 같은 짧은 이름(정확히 같을 때만)
     */
    public static void redactKeys(String... keys) {
        Redactor.get().addKeys(keys);
    }

    /** 기본 가리기 규칙을 끄고 redactHeaders·redactKeys 로 추가한 항목만 가린다 (호출 순서와 상관없이 추가한 항목은 유지) */
    public static void clearDefaultRedaction() {
        Redactor.get().clearDefaults();
    }
}
