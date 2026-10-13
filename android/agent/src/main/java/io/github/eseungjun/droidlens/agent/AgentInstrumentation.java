package io.github.eseungjun.droidlens.agent;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.util.Log;

/**
 * 기기 안에서 계속 실행되는 DroidLens 에이전트.
 * 호스트가 `am instrument -w io.github.eseungjun.droidlens.agent/.AgentInstrumentation`으로 띄우고
 * `adb forward tcp:N tcp:7912`로 HTTP 요청을 보낸다.
 *
 * uiautomator dump는 매번 새 프로세스로 UiAutomation에 연결해 1.5~3초가 걸리지만,
 * 여기서는 연결을 유지하므로 뷰 계층을 수백 ms 안에 돌려준다.
 */
public class AgentInstrumentation extends Instrumentation {
    static final String TAG = "DroidLensAgent";
    static final int VERSION = 2;
    static final int DEFAULT_PORT = 7912;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override
    public void onStart() {
        super.onStart();
        int port = DEFAULT_PORT;
        UiAutomation ui = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        ActivityTracker tracker = new ActivityTracker(getContext());
        ui.setOnAccessibilityEventListener(tracker);
        try {
            new AgentServer(this, ui, tracker, port).serveForever();
        } catch (Exception e) {
            Log.e(TAG, "server stopped", e);
            Bundle result = new Bundle();
            result.putString("error", String.valueOf(e));
            finish(1, result);
        }
    }
}
