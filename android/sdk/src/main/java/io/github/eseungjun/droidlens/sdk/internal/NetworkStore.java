package io.github.eseungjun.droidlens.sdk.internal;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** 최근 HTTP 요청 링 버퍼 (최대 500개, 본문 합계 최대 32MB. 넘으면 오래된 항목부터 버린다) */
public final class NetworkStore {
    private static final NetworkStore INSTANCE = new NetworkStore();
    private static final int MAX = 500;
    private static final long MAX_BODY_TOTAL = 32L * 1024 * 1024;
    /** 이미지는 데스크톱 미리보기용으로 이 크기까지만 통째로 담는다 (잘린 이미지는 보여 줄 수 없으니 버림) */
    private static final long MAX_IMAGE = 128 * 1024;
    /** 그 밖의 바이너리(octet-stream·protobuf·영상 등)는 앞부분만 담는다 */
    private static final long MAX_BINARY = 4 * 1024;

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
        /** 저장소에 잡혀 있는 본문 바이트 수 (entries 락으로 보호) */
        private long bodyBytes;
        private boolean removed;

        Entry(long id, String method, String url) {
            this.id = id;
            this.method = method;
            this.url = url;
        }
    }

    private final AtomicLong seq = new AtomicLong();
    private final ArrayDeque<Entry> entries = new ArrayDeque<>();

    private long bodyTotal;

    public Entry begin(String method, String url) {
        Entry e = new Entry(seq.incrementAndGet(), method, url);
        synchronized (entries) {
            entries.addLast(e);
            while (entries.size() > MAX) removeOldest();
        }
        return e;
    }

    /**
     * 본문을 몇 바이트까지 복사할지. 이미지는 길이를 알고 너무 크면 아예 복사하지 않고,
     * 그 밖의 바이너리는 앞부분만 복사한다.
     */
    public static long captureLimit(String contentType, long contentLength, long max) {
        String ct = contentType == null ? "" : contentType.toLowerCase();
        if (ct.startsWith("image/")) return contentLength > MAX_IMAGE ? 0 : Math.min(max, MAX_IMAGE);
        if (isBinaryType(ct)) return Math.min(max, MAX_BINARY);
        return max;
    }

    public void setRequestBody(Entry e, byte[] body, long size, boolean truncated) {
        synchronized (entries) {
            e.requestSize = size;
            e.requestTruncated = truncated;
            e.requestBody = keep(e.requestContentType, body, truncated);
            account(e);
        }
    }

    public void setResponseBody(Entry e, byte[] body, long size, boolean truncated) {
        synchronized (entries) {
            e.responseSize = size;
            e.responseTruncated = truncated;
            e.responseBody = keep(e.responseContentType, body, truncated);
            account(e);
        }
    }

    /** 잘린 이미지는 미리보기가 안 되니 담지 않는다 */
    private static byte[] keep(String contentType, byte[] body, boolean truncated) {
        if (body != null && truncated && contentType != null && contentType.toLowerCase().startsWith("image/")) return null;
        return body;
    }

    /** entries 락 안에서 호출. 항목의 본문 크기를 다시 세고, 예산을 넘으면 오래된 항목부터 버린다 */
    private void account(Entry e) {
        if (e.removed) {
            // 이미 밀려난 항목이면 붙들고 있을 이유가 없다
            e.requestBody = null;
            e.responseBody = null;
            return;
        }
        long now = (e.requestBody != null ? e.requestBody.length : 0) + (e.responseBody != null ? e.responseBody.length : 0);
        bodyTotal += now - e.bodyBytes;
        e.bodyBytes = now;
        while (bodyTotal > MAX_BODY_TOTAL && entries.size() > 1) removeOldest();
    }

    private void removeOldest() {
        Entry old = entries.removeFirst();
        old.removed = true;
        bodyTotal -= old.bodyBytes;
        old.bodyBytes = 0;
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
            while (!entries.isEmpty()) removeOldest();
            bodyTotal = 0;
        }
    }

    /** 락 안에서는 목록만 복사하고, JSON 직렬화는 락 밖에서 한다 (앱의 요청 기록을 막지 않도록) */
    private List<Entry> snapshot() {
        synchronized (entries) {
            return new ArrayList<>(entries);
        }
    }

    public JSONArray list(long since, int limit, String filter) throws JSONException {
        JSONArray out = new JSONArray();
        String f = filter != null ? filter.toLowerCase() : null;
        for (Entry e : snapshot()) {
            if (e.id <= since) continue;
            if (f != null && !e.url.toLowerCase().contains(f)) continue;
            out.put(summary(e));
            if (out.length() >= limit) break;
        }
        return out;
    }

    public JSONObject detail(long id) throws JSONException {
        Entry e = null;
        byte[] requestBody;
        byte[] responseBody;
        synchronized (entries) {
            for (Entry x : entries) {
                if (x.id == id) {
                    e = x;
                    break;
                }
            }
            if (e == null) return null;
            requestBody = e.requestBody;
            responseBody = e.responseBody;
        }
        JSONObject o = summary(e);
        o.put("requestHeaders", headers(e.requestHeaders));
        o.put("requestContentType", e.requestContentType);
        o.put("requestTruncated", e.requestTruncated);
        putBody(o, "requestBody", requestBody, e.requestContentType);
        o.put("message", e.message);
        o.put("protocol", e.protocol);
        o.put("responseHeaders", headers(e.responseHeaders));
        o.put("responseContentType", e.responseContentType);
        o.put("responseTruncated", e.responseTruncated);
        putBody(o, "responseBody", responseBody, e.responseContentType);
        return o;
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
            if (ct.startsWith("image/") || isBinaryType(ct)) return false;
        }
        // content-type이 없으면 앞부분에 NUL이 없는지로 판단
        for (int i = 0; i < Math.min(body.length, 512); i++) if (body[i] == 0) return false;
        return true;
    }

    private static boolean isBinaryType(String ct) {
        return ct.contains("octet-stream") || ct.contains("protobuf") || ct.startsWith("video/") || ct.startsWith("audio/")
                || ct.startsWith("font/") || ct.contains("zip") || ct.contains("pdf");
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
