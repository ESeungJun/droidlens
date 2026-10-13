package io.github.eseungjun.droidlens.agent;

import android.app.UiAutomation;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.view.accessibility.AccessibilityEvent;

import java.util.HashMap;
import java.util.Map;

/**
 * TYPE_WINDOW_STATE_CHANGED 이벤트의 className으로 패키지별 현재 Activity를 추적한다.
 * 다이얼로그·팝업도 같은 이벤트를 내므로 PackageManager에 실제 Activity로 등록된 클래스만 받아들인다.
 * dumpsys(기기 부하에 따라 1~7초) 없이 즉시 현재 Activity를 알 수 있다.
 */
final class ActivityTracker implements UiAutomation.OnAccessibilityEventListener {
    private final PackageManager pm;
    private final Map<String, String> activityByPackage = new HashMap<>();
    private final Map<String, Boolean> isActivityCache = new HashMap<>();
    private volatile String lastWindowClass = "";

    ActivityTracker(Context context) {
        this.pm = context.getPackageManager();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        CharSequence cls = event.getClassName();
        if (pkg == null || cls == null) return;
        lastWindowClass = cls.toString();
        if (isActivity(pkg.toString(), cls.toString())) {
            synchronized (activityByPackage) {
                activityByPackage.put(pkg.toString(), cls.toString());
            }
        }
    }

    String activityOf(String pkg) {
        synchronized (activityByPackage) {
            return activityByPackage.get(pkg);
        }
    }

    String lastWindowClass() {
        return lastWindowClass;
    }

    private boolean isActivity(String pkg, String cls) {
        String key = pkg + "/" + cls;
        Boolean cached = isActivityCache.get(key);
        if (cached != null) return cached;
        boolean ok;
        try {
            pm.getActivityInfo(new ComponentName(pkg, cls), 0);
            ok = true;
        } catch (PackageManager.NameNotFoundException e) {
            ok = false;
        }
        isActivityCache.put(key, ok);
        return ok;
    }
}
