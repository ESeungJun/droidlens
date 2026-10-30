package io.github.eseungjun.droidlens.sdk.internal;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.github.eseungjun.droidlens.sdk.BuildConfig;

/**
 * localabstract:droidlens_sdk_&lt;패키지&gt; 에서 동작하는 최소 HTTP/1.1 서버.
 * 호스트는 `adb forward tcp:N localabstract:droidlens_sdk_&lt;패키지&gt;`로 연결한다.
 * 유닉스 소켓이라 INTERNET 권한이 필요 없다. 접속 UID를 검사해 adb 경유(shell)·root·앱 자신만 받는다.
 */
public final class SdkServer {
    public static final String SOCKET_PREFIX = "droidlens_sdk_";
    private static final String TAG = "DroidLens";
    /** 헤더를 보내지 않는 연결이 작업 스레드를 붙잡지 않도록 (에이전트와 같은 값) */
    private static final int SO_TIMEOUT_MS = 15_000;
    /** accept 가 이만큼 연달아 실패하면 서버 소켓이 망가진 것으로 보고 멈춘다 */
    private static final int MAX_ACCEPT_FAILURES = 10;

    private final Context context;
    private final String socketName;
    private final PrefsPlugin prefs;
    private final DbPlugin db;
    private final ExecutorService pool = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "droidlens-sdk");
        t.setDaemon(true);
        return t;
    });

    public SdkServer(Context context) {
        this.context = context;
        this.socketName = SOCKET_PREFIX + context.getPackageName();
        this.prefs = new PrefsPlugin(context);
        this.db = new DbPlugin(context);
    }

    public String socketName() {
        return socketName;
    }

    private volatile boolean running;

    /** accept 루프가 살아 있는지. 서버 소켓이 망가져 멈추면 false */
    public boolean isRunning() {
        return running;
    }

    public void start() throws Exception {
        final LocalServerSocket server = new LocalServerSocket(socketName);
        running = true;
        Thread t = new Thread(() -> {
            int failures = 0;
            while (true) {
                LocalSocket s;
                try {
                    s = server.accept();
                    failures = 0;
                } catch (Exception e) {
                    // 일시적인 실패로 루프 전체가 끝나지 않게 한다. 연달아 실패할 때만 멈춘다
                    failures++;
                    Log.w(TAG, "accept failed (" + failures + "/" + MAX_ACCEPT_FAILURES + ")", e);
                    if (failures >= MAX_ACCEPT_FAILURES) {
                        Log.e(TAG, "DroidLens SDK 서버를 멈춥니다: accept 가 계속 실패합니다");
                        running = false;
                        closeQuietly(server);
                        return;
                    }
                    SystemClock.sleep(200);
                    continue;
                }
                try {
                    // 같은 기기의 다른 앱도 abstract 소켓에 연결할 수 있으므로 adb(shell)·root·자기 자신만 허용
                    int uid = s.getPeerCredentials().getUid();
                    if (uid != 0 && uid != 2000 && uid != Process.myUid()) {
                        Log.w(TAG, "rejected connection from uid " + uid);
                        closeQuietly(s);
                        continue;
                    }
                    s.setSoTimeout(SO_TIMEOUT_MS);
                    pool.execute(() -> handle(s));
                } catch (Exception e) {
                    Log.w(TAG, "connection setup failed", e);
                    closeQuietly(s);
                }
            }
        }, "droidlens-sdk-accept");
        t.setDaemon(true);
        t.start();
    }

    // LocalServerSocket 은 오래된 API 레벨에서 Closeable 이 아니라 타입별로 둔다
    private static void closeQuietly(LocalSocket s) {
        try {
            s.close();
        } catch (Exception ignored) {
            // 닫기 실패는 무시
        }
    }

    private static void closeQuietly(LocalServerSocket s) {
        try {
            s.close();
        } catch (Exception ignored) {
            // 닫기 실패는 무시
        }
    }

    private void handle(LocalSocket s) {
        try (LocalSocket sock = s) {
            InputStream in = sock.getInputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            String method = req[0];
            String target = req.length > 1 ? req[1] : "/";
            int contentLength = 0;
            for (int i = 1; i < lines.length; i++) {
                int idx = lines[i].indexOf(':');
                if (idx > 0 && lines[i].substring(0, idx).trim().equalsIgnoreCase("content-length")) {
                    contentLength = Math.min(Integer.parseInt(lines[i].substring(idx + 1).trim()), 1 << 20);
                }
            }
            byte[] body = new byte[contentLength];
            int read = 0;
            while (read < contentLength) {
                int n = in.read(body, read, contentLength - read);
                if (n < 0) break;
                read += n;
            }

            String path = target;
            Map<String, String> q = new HashMap<>();
            int qi = target.indexOf('?');
            if (qi >= 0) {
                path = target.substring(0, qi);
                for (String kv : target.substring(qi + 1).split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq > 0) q.put(kv.substring(0, eq), URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
                }
            }

            int status = 200;
            String response;
            try {
                Object r = route(method, path, q, new String(body, 0, read, StandardCharsets.UTF_8));
                if (r == null) {
                    status = 404;
                    response = "{\"error\":\"not found\"}";
                } else {
                    response = r.toString();
                }
            } catch (Throwable t) {
                status = 500;
                response = new JSONObject().put("error", String.valueOf(t)).toString();
            }
            write(sock.getOutputStream(), status, response);
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    private Object route(String method, String path, Map<String, String> q, String body) throws Exception {
        switch (method + " " + path) {
            case "GET /info": return info();
            case "GET /network":
                return new JSONObject().put("entries", NetworkStore.get().list(num(q.get("since"), 0), (int) num(q.get("limit"), 500), q.get("filter")));
            case "GET /network/detail":
                return NetworkStore.get().detail(num(q.get("id"), -1));
            case "POST /network/clear":
                NetworkStore.get().clear();
                return new JSONObject().put("ok", true);
            case "GET /events":
                return new JSONObject().put("events", EventStore.get().list(num(q.get("since"), 0)));
            case "GET /prefs": return prefs.list();
            case "POST /prefs/set": return prefs.set(req(q, "file"), req(q, "key"), req(q, "type"), q.containsKey("value") ? q.get("value") : body);
            case "POST /prefs/remove": return prefs.remove(req(q, "file"), req(q, "key"));
            case "GET /db": return db.list();
            case "POST /db/query": return db.query(req(q, "db"), body.isEmpty() ? req(q, "sql") : body, "1".equals(q.get("write")));
            default: return null;
        }
    }

    private JSONObject info() throws Exception {
        PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        boolean okhttp;
        try {
            Class.forName("okhttp3.Interceptor");
            okhttp = true;
        } catch (ClassNotFoundException e) {
            okhttp = false;
        }
        return new JSONObject()
                .put("sdkVersion", BuildConfig.SDK_VERSION)
                .put("package", context.getPackageName())
                .put("versionName", pi.versionName)
                .put("pid", Process.myPid())
                .put("okhttp", okhttp)
                .put("plugins", new JSONArray().put("network").put("prefs").put("db").put("events"));
    }

    private static String req(Map<String, String> q, String key) {
        String v = q.get(key);
        if (v == null) throw new IllegalArgumentException(key + " 파라미터가 필요합니다");
        return v;
    }

    private static long num(String v, long def) {
        try {
            return v == null ? def : Long.parseLong(v);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** 빈 줄(\r\n\r\n)까지 헤더를 읽는다 */
    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        int b;
        while ((b = in.read()) != -1) {
            buf.write(b);
            state = (b == '\r' && (state == 0 || state == 2)) ? state + 1 : (b == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return buf.toString("UTF-8");
            if (buf.size() > 64 * 1024) throw new IllegalStateException("헤더가 너무 큽니다");
        }
        return null;
    }

    private static void write(OutputStream out, int status, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " ERR") + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }
}
