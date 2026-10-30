package io.github.eseungjun.droidlens.sdk.internal;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 네트워크 목 규칙. URL 에 url 문자열이 들어 있고 method 가 맞는(비어 있으면 아무 메서드) 첫 규칙을 적용한다.
 * <ul>
 * <li>status 가 있으면 서버에 보내지 않고 그 응답(status·headers·body)을 돌려준다</li>
 * <li>fail 이면 네트워크 오류(IOException)로 끝낸다</li>
 * <li>둘 다 없으면 delayMs 만큼 늦춘 뒤 실제로 보낸다</li>
 * </ul>
 * 앱을 다시 시작해도 남도록 앱 내부 저장소(noBackupFilesDir)에 둔다 (시작 직후 요청도 목으로 확인할 수 있게).
 * 켜 둔 규칙이 잊히지 않게 앱이 뜰 때와 규칙이 적용될 때 logcat 에 경고를 남긴다.
 */
public final class MockStore {
    private static final String TAG = "DroidLens";
    private static final MockStore INSTANCE = new MockStore();
    private static final String FILE = "droidlens_mocks.json";
    public static final int MAX_RULES = 50;
    public static final long MAX_DELAY_MS = 60_000;
    /** 규칙 하나의 응답 본문 상한 (글자 수). 규칙은 앱이 뜰 때 메인 스레드에서 읽으므로 작게 둔다 */
    public static final int MAX_BODY_CHARS = 256 * 1024;
    /** 저장 파일 전체 상한. 넘는 파일은 읽지 않고 지운다 */
    private static final long MAX_FILE_BYTES = 2L * 1024 * 1024;
    private static final int MAX_HEADERS = 50;

    public static MockStore get() {
        return INSTANCE;
    }

    public static final class Rule {
        public final String id;
        public final boolean enabled;
        public final String url;
        public final String method;
        /** 0 이면 응답을 만들지 않는다 */
        public final int status;
        public final String contentType;
        public final String body;
        public final Map<String, String> headers;
        public final long delayMs;
        public final boolean fail;
        final AtomicInteger hits = new AtomicInteger();

        Rule(JSONObject o, String id) throws JSONException {
            this.id = id;
            this.enabled = o.optBoolean("enabled", true);
            this.url = o.optString("url", "");
            if (url.isEmpty()) throw new IllegalArgumentException("url 이 필요합니다 (요청 URL 에 들어 있는 문자열)");
            String m = o.optString("method", "").trim().toUpperCase();
            this.method = m.isEmpty() ? null : m;
            this.status = o.optInt("status", 0);
            if (status != 0 && (status < 200 || status > 599)) throw new IllegalArgumentException("status 는 200~599 입니다");
            this.fail = o.optBoolean("fail", false);
            if (fail && status != 0) throw new IllegalArgumentException("fail 과 status 는 함께 쓸 수 없습니다");
            this.delayMs = Math.max(0, o.optLong("delayMs", 0));
            if (delayMs > MAX_DELAY_MS) throw new IllegalArgumentException("delayMs 는 " + MAX_DELAY_MS + " 까지입니다");
            if (status == 0 && !fail && delayMs == 0) throw new IllegalArgumentException("status, fail, delayMs 중 하나는 필요합니다");
            this.contentType = o.isNull("contentType") ? null : o.optString("contentType", null);
            // OkHttp 는 헤더에 ASCII 가 아닌 글자·줄바꿈이 있으면 예외를 던져 앱이 죽는다. 저장할 때 미리 거절한다
            if (contentType != null && !(isHeaderValue(contentType) && contentType.matches("[\\w.+-]+/[\\w.+-]+\\s*(;.*)?"))) {
                throw new IllegalArgumentException("contentType 형식이 아닙니다 (예: application/json; charset=utf-8)");
            }
            this.body = o.isNull("body") ? null : o.optString("body", null);
            if (body != null && body.length() > MAX_BODY_CHARS) throw new IllegalArgumentException("body 는 " + MAX_BODY_CHARS + "자까지입니다");
            Map<String, String> h = new LinkedHashMap<>();
            JSONObject hs = o.optJSONObject("headers");
            if (hs != null) {
                if (hs.length() > MAX_HEADERS) throw new IllegalArgumentException("headers 는 " + MAX_HEADERS + "개까지입니다");
                for (Iterator<String> it = hs.keys(); it.hasNext(); ) {
                    String k = it.next();
                    String v = hs.getString(k);
                    if (!isHeaderName(k) || !isHeaderValue(v)) {
                        throw new IllegalArgumentException("헤더 " + k + ": 이름과 값은 ASCII 로만 쓸 수 있습니다 (한글·줄바꿈 불가)");
                    }
                    h.put(k, v);
                }
            }
            this.headers = h;
        }

        /** OkHttp Headers 의 이름 규칙: 비어 있지 않고 0x21~0x7e 글자만 */
        private static boolean isHeaderName(String s) {
            if (s.isEmpty()) return false;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c <= ' ' || c >= 0x7f) return false;
            }
            return true;
        }

        /** OkHttp Headers 의 값 규칙: 탭과 0x20~0x7e 글자만 */
        private static boolean isHeaderValue(String s) {
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c != '\t' && (c < ' ' || c >= 0x7f)) return false;
            }
            return true;
        }

        boolean matches(String m, String u) {
            return enabled && (method == null || method.equalsIgnoreCase(m)) && u.contains(url);
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject()
                    .put("id", id)
                    .put("enabled", enabled)
                    .put("url", url)
                    .put("delayMs", delayMs)
                    .put("fail", fail)
                    .put("hits", hits.get());
            if (method != null) o.put("method", method);
            if (status != 0) o.put("status", status);
            if (contentType != null) o.put("contentType", contentType);
            if (body != null) o.put("body", body);
            if (!headers.isEmpty()) o.put("headers", new JSONObject(headers));
            return o;
        }
    }

    private final List<Rule> rules = new CopyOnWriteArrayList<>();
    private File file;

    /** 저장해 둔 규칙을 읽는다. 서버를 열 때 한 번 */
    public synchronized void load(Context context) {
        file = new File(context.getNoBackupFilesDir(), FILE);
        rules.clear();
        if (!file.exists()) return;
        if (file.length() > MAX_FILE_BYTES) {
            Log.w(TAG, "저장된 네트워크 목 규칙 파일이 너무 커서(" + file.length() + "B) 읽지 않고 지웁니다");
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            JSONArray arr = new JSONArray(buf.toString("UTF-8"));
            for (int i = 0; i < arr.length() && i < MAX_RULES; i++) {
                JSONObject o = arr.getJSONObject(i);
                Rule r = new Rule(o, o.getString("id"));
                r.hits.set(o.optInt("hits", 0));
                rules.add(r);
            }
        } catch (Exception e) {
            Log.w(TAG, "저장된 네트워크 목 규칙을 읽지 못해 비웁니다", e);
            rules.clear();
        }
        int on = 0;
        for (Rule r : rules) if (r.enabled) on++;
        if (on > 0) Log.w(TAG, "네트워크 목 규칙 " + on + "개가 켜져 있습니다. 일치하는 요청은 실제 서버 대신 목으로 처리됩니다");
    }

    private final AtomicBoolean warnedNetworkInterceptor = new AtomicBoolean();

    /**
     * 요청에 적용할 규칙. 없으면 null.
     * canRespond 가 false 면(네트워크 인터셉터) 응답을 만드는 규칙은 건너뛴다. 적용 횟수·로그에도 남기지 않는다
     */
    public Rule match(String method, String url, boolean canRespond) {
        for (Rule r : rules) {
            if (r.matches(method, url)) {
                if (!canRespond && r.status != 0) {
                    if (warnedNetworkInterceptor.compareAndSet(false, true)) {
                        Log.w(TAG, "DroidLensInterceptor 가 addNetworkInterceptor 로 달려 있어 응답 목(status)을 적용하지 않습니다. addInterceptor 로 다세요");
                    }
                    continue;
                }
                r.hits.incrementAndGet();
                // 쿼리의 토큰 같은 값이 logcat 에 남지 않게 가린 URL 로 적는다
                Log.w(TAG, "네트워크 목 적용: " + method + " " + Redactor.get().url(url) + " → " + describe(r));
                return r;
            }
        }
        return null;
    }

    private static String describe(Rule r) {
        if (r.fail) return "네트워크 실패" + (r.delayMs > 0 ? " (" + r.delayMs + "ms 뒤)" : "");
        if (r.status != 0) return r.status + " 응답" + (r.delayMs > 0 ? " (" + r.delayMs + "ms 뒤)" : "");
        return r.delayMs + "ms 지연";
    }

    public JSONArray list() throws JSONException {
        JSONArray out = new JSONArray();
        for (Rule r : rules) out.put(r.toJson());
        return out;
    }

    /** id 가 있으면 그 규칙을 바꾸고, 없으면 새로 추가한다 */
    public synchronized JSONObject set(JSONObject o) throws Exception {
        String id = o.optString("id", "");
        int at = -1;
        if (!id.isEmpty()) {
            for (int i = 0; i < rules.size(); i++) if (rules.get(i).id.equals(id)) at = i;
            if (at < 0) throw new IllegalArgumentException("목 규칙 " + id + " 이 없습니다");
        } else {
            if (rules.size() >= MAX_RULES) throw new IllegalArgumentException("목 규칙은 " + MAX_RULES + "개까지입니다");
            id = UUID.randomUUID().toString().substring(0, 8);
        }
        Rule r = new Rule(o, id);
        Rule old = at >= 0 ? rules.get(at) : null;
        if (at >= 0) {
            // 고친 규칙도 적용 횟수는 이어서 센다
            r.hits.set(rules.get(at).hits.get());
            rules.set(at, r);
        } else {
            rules.add(r);
        }
        try {
            save();
        } catch (IOException | RuntimeException e) {
            // 너무 커서 저장하지 못한 규칙은 메모리에서도 되돌린다
            if (at >= 0) rules.set(at, old); else rules.remove(r);
            throw e;
        }
        return r.toJson();
    }

    public synchronized boolean remove(String id) throws IOException, JSONException {
        boolean removed = false;
        for (Rule r : new ArrayList<>(rules)) {
            if (r.id.equals(id)) removed = rules.remove(r);
        }
        if (removed) save();
        return removed;
    }

    public synchronized void clear() throws IOException, JSONException {
        rules.clear();
        save();
    }

    private void save() throws IOException, JSONException {
        if (file == null) return;
        if (rules.isEmpty()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }
        // 쓰다 끊겨도 이전 파일이 남도록 임시 파일에 쓴 뒤 바꾼다
        byte[] bytes = list().toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_FILE_BYTES) throw new IllegalArgumentException("목 규칙 전체가 " + MAX_FILE_BYTES / 1024 + "KB 를 넘습니다. 본문이 큰 규칙을 지우세요");
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
        }
        if (!tmp.renameTo(file)) throw new IOException("목 규칙을 저장하지 못했습니다");
    }
}
