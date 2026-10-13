package io.github.eseungjun.droidlens.sdk.internal;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** 최근 HTTP 요청 링 버퍼 (최대 500개) */
public final class NetworkStore {
    private static final NetworkStore INSTANCE = new NetworkStore();
    private static final int MAX = 500;

    public static NetworkStore get() {
        return INSTANCE;
    }

    public static final class Entry {
        public final long id;
        public final long startedAt = System.currentTimeMillis();
        public final String method;
        public final String url;
        public volatile String state = "pending"; // pending | done | failed
        public Map<String, List<String>> requestHeaders;
        public String requestContentType;
        public long requestSize = -1;
        public byte[] requestBody;
        public boolean requestTruncated;
        public int status;
        public String message;
        public String protocol;
        public Map<String, List<String>> responseHeaders;
        public String responseContentType;
        public long responseSize = -1;
        public byte[] responseBody;
        public boolean responseTruncated;
        public long durationMs = -1;
        public String error;

        Entry(long id, String method, String url) {
            this.id = id;
            this.method = method;
            this.url = url;
        }
    }

    private final AtomicLong seq = new AtomicLong();
    private final ArrayDeque<Entry> entries = new ArrayDeque<>();

    public Entry begin(String method, String url) {
        Entry e = new Entry(seq.incrementAndGet(), method, url);
        synchronized (entries) {
            entries.addLast(e);
            while (entries.size() > MAX) entries.removeFirst();
        }
        return e;
    }

    public void finish(Entry e, long durationMs) {
        e.durationMs = durationMs;
        e.state = "done";
    }

    public void fail(Entry e, long durationMs, String error) {
        e.durationMs = durationMs;
        e.error = error;
        e.state = "failed";
    }

    public void clear() {
        synchronized (entries) {
            entries.clear();
        }
    }

    public JSONArray list(long since, int limit, String filter) throws JSONException {
        JSONArray out = new JSONArray();
        synchronized (entries) {
            for (Entry e : entries) {
                if (e.id <= since) continue;
                if (filter != null && !e.url.toLowerCase().contains(filter.toLowerCase())) continue;
                out.put(summary(e));
                if (out.length() >= limit) break;
            }
        }
        return out;
    }

    public JSONObject detail(long id) throws JSONException {
        synchronized (entries) {
            for (Entry e : entries) {
                if (e.id != id) continue;
                JSONObject o = summary(e);
                o.put("requestHeaders", headers(e.requestHeaders));
                o.put("requestContentType", e.requestContentType);
                o.put("requestTruncated", e.requestTruncated);
                putBody(o, "requestBody", e.requestBody, e.requestContentType);
                o.put("message", e.message);
                o.put("protocol", e.protocol);
                o.put("responseHeaders", headers(e.responseHeaders));
                o.put("responseContentType", e.responseContentType);
                o.put("responseTruncated", e.responseTruncated);
                putBody(o, "responseBody", e.responseBody, e.responseContentType);
                return o;
            }
        }
        return null;
    }

    private static JSONObject summary(Entry e) throws JSONException {
        // volatile state를 먼저 읽어, 인터셉터 스레드가 그 전에 쓴 필드가 보이도록 한다 (happens-before)
        String state = e.state;
        JSONObject o = new JSONObject();
        o.put("id", e.id);
        o.put("startedAt", e.startedAt);
        o.put("method", e.method);
        o.put("url", e.url);
        o.put("state", state);
        o.put("status", e.status);
        o.put("durationMs", e.durationMs);
        o.put("requestSize", e.requestSize);
        o.put("responseSize", e.responseSize);
        o.put("responseContentType", e.responseContentType);
        if (e.error != null) o.put("error", e.error);
        return o;
    }

    private static JSONObject headers(Map<String, List<String>> h) throws JSONException {
        JSONObject o = new JSONObject();
        if (h == null) return o;
        for (Map.Entry<String, List<String>> en : h.entrySet()) o.put(en.getKey(), new JSONArray(en.getValue()));
        return o;
    }

    private static boolean isText(String contentType, byte[] body) {
        if (contentType != null) {
            String ct = contentType.toLowerCase();
            if (ct.startsWith("text/") || ct.contains("json") || ct.contains("xml") || ct.contains("javascript")
                    || ct.contains("x-www-form-urlencoded") || ct.contains("graphql")) return true;
            if (ct.startsWith("image/") || ct.contains("octet-stream") || ct.contains("protobuf")) return false;
        }
        // content-type이 없으면 앞부분에 NUL이 없는지로 판단
        for (int i = 0; i < Math.min(body.length, 512); i++) if (body[i] == 0) return false;
        return true;
    }

    private static void putBody(JSONObject o, String key, byte[] body, String contentType) throws JSONException {
        if (body == null) return;
        if (isText(contentType, body)) {
            o.put(key, new String(body, StandardCharsets.UTF_8));
        } else {
            o.put(key + "Base64", Base64.encodeToString(body, Base64.NO_WRAP));
        }
    }
}
