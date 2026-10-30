package io.github.eseungjun.droidlens.sdk;

import android.app.Application;
import android.content.Context;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import org.json.JSONObject;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

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

    /**
     * 수동 초기화. 자동 초기화를 끈 경우(매니페스트에서 provider 제거)에만 호출하면 된다. 여러 번 불러도 안전하다.
     * 소켓 이름이 패키지 단위라 한 앱에서 서버는 한 프로세스만 열 수 있다. 보조 프로세스에서 부르면 열지 못하고
     * 그 프로세스의 네트워크는 기록되지 않는다.
     */
    public static synchronized void init(Context context) {
        if (server != null && server.isRunning()) return;
        server = null;
        SdkServer s = null;
        try {
            s = new SdkServer(context.getApplicationContext());
            s.start();
            server = s;
            Log.i(TAG, "DroidLens SDK " + BuildConfig.SDK_VERSION + " listening on " + s.socketName() + " (" + processLabel() + ")");
        } catch (Exception e) {
            if (s != null && e instanceof IOException) {
                // LocalServerSocket 바인드 실패: 같은 이름을 다른 프로세스가 이미 열었다
                Log.e(TAG, "DroidLens SDK 소켓 localabstract:" + s.socketName() + " 을 열지 못했습니다. "
                        + "같은 앱의 다른 프로세스(주 프로세스 등)가 이미 열었거나 다른 앱이 선점했을 수 있습니다. "
                        + "이 프로세스(" + processLabel() + ")에서는 DroidLens 가 꺼집니다", e);
            } else {
                Log.w(TAG, "DroidLens SDK를 시작하지 못했습니다 (" + processLabel() + ")", e);
            }
        }
    }

    private static String processLabel() {
        String name = null;
        if (Build.VERSION.SDK_INT >= 28) {
            name = Application.getProcessName();
        } else {
            try (FileInputStream in = new FileInputStream("/proc/self/cmdline")) {
                byte[] buf = new byte[256];
                int n = in.read(buf);
                int end = 0;
                while (end < n && buf[end] != 0) end++;
                name = new String(buf, 0, end, StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                // 이름을 못 읽으면 pid 만 쓴다
            }
        }
        return "pid " + Process.myPid() + (name != null && !name.isEmpty() ? ", " + name : "");
    }

    /** SDK 버전. release 의 sdk-noop 은 "noop" 을 돌려주므로 BuildConfig 대신 이것을 쓰면 두 빌드 모두 컴파일된다 */
    public static String version() {
        return BuildConfig.SDK_VERSION;
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
