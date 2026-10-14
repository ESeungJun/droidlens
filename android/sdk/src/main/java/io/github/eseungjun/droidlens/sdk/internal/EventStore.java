package io.github.eseungjun.droidlens.sdk.internal;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicLong;

/** DroidLens.event()로 남긴 커스텀 이벤트 링 버퍼 (최대 1000개) */
public final class EventStore {
    private static final EventStore INSTANCE = new EventStore();
    private static final int MAX = 1000;

    public static EventStore get() {
        return INSTANCE;
    }

    private final AtomicLong seq = new AtomicLong();
    private final ArrayDeque<JSONObject> events = new ArrayDeque<>();

    public void add(String name, JSONObject data) {
        try {
            JSONObject e = new JSONObject();
            e.put("id", seq.incrementAndGet());
            e.put("at", System.currentTimeMillis());
            e.put("name", name);
            e.put("thread", Thread.currentThread().getName());
            // 커스텀 이벤트에 토큰 같은 값이 들어와도 네트워크 기록과 같은 규칙으로 가린다
            if (data != null) e.put("data", new JSONObject(Redactor.get().json(data.toString())));
            synchronized (events) {
                events.addLast(e);
                while (events.size() > MAX) events.removeFirst();
            }
        } catch (JSONException ignored) {
            // 이벤트 기록 실패는 무시
        }
    }

    public JSONArray list(long since) throws JSONException {
        JSONArray out = new JSONArray();
        synchronized (events) {
            for (JSONObject e : events) if (e.getLong("id") > since) out.put(e);
        }
        return out;
    }
}
