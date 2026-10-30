package io.github.eseungjun.droidlens.sdk.internal;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** SharedPreferences 조회·편집. 앱 프로세스 안에서 Editor로 쓰므로 리스너·캐시가 그대로 반영된다. */
final class PrefsPlugin {
    private final Context context;

    PrefsPlugin(Context context) {
        this.context = context;
    }

    JSONObject list() throws JSONException {
        JSONArray files = new JSONArray();
        File dir = new File(context.getApplicationInfo().dataDir, "shared_prefs");
        String[] names = dir.list();
        if (names != null) {
            java.util.Arrays.sort(names);
            for (String f : names) {
                if (!f.endsWith(".xml")) continue;
                String name = f.substring(0, f.length() - 4);
                JSONObject entries = new JSONObject();
                for (Map.Entry<String, ?> e : context.getSharedPreferences(name, Context.MODE_PRIVATE).getAll().entrySet()) {
                    entries.put(e.getKey(), typed(e.getValue()));
                }
                files.put(new JSONObject().put("name", name).put("entries", entries));
            }
        }
        return new JSONObject().put("files", files);
    }

    private static JSONObject typed(Object v) throws JSONException {
        JSONObject o = new JSONObject();
        if (v instanceof String) o.put("type", "string").put("value", v);
        else if (v instanceof Integer) o.put("type", "int").put("value", v);
        else if (v instanceof Long) o.put("type", "long").put("value", v);
        else if (v instanceof Float) o.put("type", "float").put("value", ((Float) v).doubleValue());
        else if (v instanceof Boolean) o.put("type", "boolean").put("value", v);
        else if (v instanceof Set) o.put("type", "stringSet").put("value", new JSONArray((Set<?>) v));
        else o.put("type", "unknown").put("value", String.valueOf(v));
        return o;
    }

    JSONObject set(String file, String key, String type, String value) throws JSONException {
        SharedPreferences.Editor ed = context.getSharedPreferences(file, Context.MODE_PRIVATE).edit();
        switch (type) {
            case "string": ed.putString(key, value); break;
            case "int": ed.putInt(key, Integer.parseInt(value)); break;
            case "long": ed.putLong(key, Long.parseLong(value)); break;
            case "float": ed.putFloat(key, Float.parseFloat(value)); break;
            case "boolean": ed.putBoolean(key, Boolean.parseBoolean(value)); break;
            case "stringSet": {
                JSONArray arr = new JSONArray(value);
                Set<String> set = new HashSet<>();
                for (int i = 0; i < arr.length(); i++) set.add(arr.getString(i));
                ed.putStringSet(key, set);
                break;
            }
            default: throw new IllegalArgumentException("지원하지 않는 타입: " + type);
        }
        boolean ok = ed.commit();
        return withWarning(new JSONObject().put("ok", ok));
    }

    JSONObject remove(String file, String key) throws JSONException {
        boolean ok = context.getSharedPreferences(file, Context.MODE_PRIVATE).edit().remove(key).commit();
        return withWarning(new JSONObject().put("ok", ok));
    }

    /**
     * SharedPreferences 는 프로세스마다 따로 캐시한다. 앱이 여러 프로세스로 떠 있으면 이 프로세스에서 쓴 값을
     * 다른 프로세스가 모르고, 그쪽이 나중에 저장하면 덮어쓸 수 있으니 알려 준다.
     */
    private JSONObject withWarning(JSONObject o) throws JSONException {
        if (runningProcessCount() > 1) {
            o.put("warning", "앱이 여러 프로세스로 실행 중입니다. 이 값은 DroidLens 가 붙은 프로세스(pid " + Process.myPid()
                    + ")에만 반영되고, 다른 프로세스가 같은 파일을 저장하면 덮어쓸 수 있습니다");
        }
        return o;
    }

    private int runningProcessCount() {
        try {
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            List<ActivityManager.RunningAppProcessInfo> list = am != null ? am.getRunningAppProcesses() : null;
            if (list == null) return 1;
            int n = 0;
            for (ActivityManager.RunningAppProcessInfo p : list) if (p.uid == Process.myUid()) n++;
            return n;
        } catch (Exception e) {
            return 1;
        }
    }
}
