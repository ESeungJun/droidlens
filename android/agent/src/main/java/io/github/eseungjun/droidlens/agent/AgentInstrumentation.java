package io.github.eseungjun.droidlens.agent;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.util.Log;

/**
 * 기기 안에서 계속 실행되는 DroidLens 에이전트.
 * 호스트가 `am instrument -w io.github.eseungjun.droidlens.agent/.AgentInstrumentation`으로 띄우고
 * `adb forward tcp:N localabstract:droidlens_agent`로 HTTP 요청을 보낸다 (adb 경유 연결만 허용).
 *
 * uiautomator dump는 매번 새 프로세스로 UiAutomation에 연결해 1.5~3초가 걸리지만,
 * 여기서는 연결을 유지하므로 뷰 계층을 수백 ms 안에 돌려준다.
 */
public class AgentInstrumentation extends Instrumentation {
    static final String TAG = "DroidLensAgent";
    static final int VERSION = 3;
    static final String SOCKET_NAME = "droidlens_agent";

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override
    public void onStart() {
        super.onStart();
        UiAutomation ui = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        // getWindows()(allWindows 뷰 계층)는 이 플래그를 켜야 창 목록을 돌려준다 (API 21+, minSdk 24)
        AccessibilityServiceInfo info = ui.getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            ui.setServiceInfo(info);
        }
        ActivityTracker tracker = new ActivityTracker(getContext());
        ui.setOnAccessibilityEventListener(tracker);
        try {
            new AgentServer(this, ui, tracker, SOCKET_NAME).serveForever();
        } catch (Exception e) {
            Log.e(TAG, "server stopped: " + e.getMessage(), e);
            Bundle result = new Bundle();
            result.putString("error", String.valueOf(e));
            finish(1, result);
        }
    }
}
