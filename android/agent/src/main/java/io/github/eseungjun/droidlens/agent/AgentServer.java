package io.github.eseungjun.droidlens.agent;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/** 의존성 없는 최소 HTTP/1.1 서버. 요청 하나씩 순차 처리한다 (UiAutomation은 스레드 안전하지 않다). */
final class AgentServer {
    private final Instrumentation instrumentation;
    private final UiAutomation ui;
    private final ActivityTracker tracker;
    private final String socketName;

    AgentServer(Instrumentation instrumentation, UiAutomation ui, ActivityTracker tracker, String socketName) {
        this.instrumentation = instrumentation;
        this.ui = ui;
        this.tracker = tracker;
        this.socketName = socketName;
    }

    /**
     * localabstract 유닉스 소켓으로만 연다. TCP(127.0.0.1)로 열면 기기의 다른 앱이 접속해
     * UiAutomation 권한(화면 읽기·텍스트 주입)을 빌려 쓸 수 있으므로, 접속한 상대의 UID를 확인해
     * adb를 거친 연결(shell 2000 / root 0)만 받는다.
     */
    void serveForever() throws Exception {
        LocalServerSocket server = new LocalServerSocket(socketName);
        Log.i(AgentInstrumentation.TAG, "listening on localabstract:" + socketName);
        while (true) {
            try (LocalSocket s = server.accept()) {
                int uid = s.getPeerCredentials().getUid();
                if (uid != 0 && uid != 2000) {
                    Log.w(AgentInstrumentation.TAG, "rejected connection from uid " + uid);
                    continue;
                }
                s.setSoTimeout(15_000);
                handle(s);
            } catch (Exception e) {
                Log.w(AgentInstrumentation.TAG, "request failed", e);
            }
        }
    }

    private void handle(LocalSocket s) throws Exception {
        InputStream in = s.getInputStream();
        String head = readHead(in);
        if (head == null) return;
        String[] lines = head.split("\r\n");
        String[] parts = lines[0].split(" ");
        String method = parts[0];
        String target = parts.length > 1 ? parts[1] : "/";
        int contentLength = 0;
        for (int i = 1; i < lines.length; i++) {
            int idx = lines[i].indexOf(':');
            if (idx > 0 && lines[i].substring(0, idx).trim().equalsIgnoreCase("content-length")) {
                contentLength = Math.min(Integer.parseInt(lines[i].substring(idx + 1).trim()), 1 << 20);
            }
        }
        byte[] bodyBytes = new byte[contentLength];
        int read = 0;
        while (read < contentLength) {
            int n = in.read(bodyBytes, read, contentLength - read);
            if (n < 0) break;
            read += n;
        }
        String body = new String(bodyBytes, 0, read, StandardCharsets.UTF_8);

        String path = target;
        Map<String, String> query = new HashMap<>();
        int q = target.indexOf('?');
        if (q >= 0) {
            path = target.substring(0, q);
            for (String kv : target.substring(q + 1).split("&")) {
                int eq = kv.indexOf('=');
                if (eq > 0) query.put(kv.substring(0, eq), URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            }
        }

        int status = 200;
        String contentType = "application/json; charset=utf-8";
        String response;
        try {
            switch (method + " " + path) {
                case "GET /ping":
                    response = "{\"ok\":true,\"version\":" + AgentInstrumentation.VERSION + ",\"pid\":" + Process.myPid() + "}";
                    break;
                case "GET /state":
                    response = state();
                    break;
                case "GET /hierarchy":
                    contentType = "text/xml; charset=utf-8";
                    response = dumpHierarchy("1".equals(query.get("allWindows")));
                    break;
                case "POST /text":
                    response = setText(query.containsKey("text") ? query.get("text") : body, "append".equals(query.get("mode")));
                    break;
                case "POST /idle":
                    response = waitIdle(parseLong(query.get("quietMs"), 300), parseLong(query.get("timeoutMs"), 3000));
                    break;
                case "POST /shutdown":
                    response = "{\"ok\":true}";
                    write(s.getOutputStream(), 200, contentType, response);
                    instrumentation.finish(0, new Bundle());
                    return;
                default:
                    status = 404;
                    response = "{\"error\":\"not found\"}";
            }
        } catch (Throwable t) {
            status = 500;
            response = "{\"error\":" + json(String.valueOf(t)) + "}";
        }
        write(s.getOutputStream(), status, contentType, response);
    }

    /** 빈 줄(\r\n\r\n)까지 헤더를 바이트 단위로 읽는다 (본문은 Content-Length 바이트만큼 따로 읽음) */
    private static String readHead(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
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

    private static long parseLong(String v, long def) {
        try {
            return v == null ? def : Long.parseLong(v);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static void write(OutputStream out, int status, String contentType, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " ERR") + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    // ---------- 뷰 계층 ----------

    /** uiautomator dump와 같은 XML 형식이라 호스트의 파서를 그대로 쓴다 */
    private String dumpHierarchy(boolean allWindows) throws Exception {
        StringBuilder sb = new StringBuilder(64 * 1024);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        if (allWindows) {
            List<AccessibilityWindowInfo> windows = ui.getWindows();
            // 빈 hierarchy 를 성공처럼 돌려주면 호스트가 "화면에 아무것도 없음"으로 오해한다
            if (windows.isEmpty()) throw new IllegalStateException("창 목록을 가져오지 못했습니다 (getWindows 가 비어 있음)");
            for (int i = windows.size() - 1; i >= 0; i--) {
                AccessibilityNodeInfo root = windows.get(i).getRoot();
                if (root != null) appendNode(sb, root, 0);
            }
        } else {
            AccessibilityNodeInfo root = null;
            for (int i = 0; i < 10 && root == null; i++) {
                root = ui.getRootInActiveWindow();
                if (root == null) Thread.sleep(100);
            }
            if (root == null) throw new IllegalStateException("활성 윈도우의 루트 노드를 가져오지 못했습니다");
            appendNode(sb, root, 0);
        }
        sb.append("</hierarchy>");
        return sb.toString();
    }

    private final Rect rect = new Rect();

    private void appendNode(StringBuilder sb, AccessibilityNodeInfo n, int index) {
        if (!n.isVisibleToUser()) return;
        n.getBoundsInScreen(rect);
        sb.append("<node index=\"").append(index).append('"');
        attr(sb, "text", n.getText());
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName());
        attr(sb, "package", n.getPackageName());
        attr(sb, "content-desc", n.getContentDescription());
        bool(sb, "checkable", n.isCheckable());
        bool(sb, "checked", n.isChecked());
        bool(sb, "clickable", n.isClickable());
        bool(sb, "enabled", n.isEnabled());
        bool(sb, "focusable", n.isFocusable());
        bool(sb, "focused", n.isFocused());
        bool(sb, "scrollable", n.isScrollable());
        bool(sb, "long-clickable", n.isLongClickable());
        bool(sb, "password", n.isPassword());
        bool(sb, "selected", n.isSelected());
        sb.append(" bounds=\"[").append(rect.left).append(',').append(rect.top).append("][")
                .append(rect.right).append(',').append(rect.bottom).append("]\"");
        int count = n.getChildCount();
        if (count == 0) {
            sb.append("/>");
            return;
        }
        sb.append('>');
        int childIndex = 0;
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null) continue;
            appendNode(sb, c, childIndex++);
        }
        sb.append("</node>");
    }

    private static void attr(StringBuilder sb, String name, CharSequence value) {
        sb.append(' ').append(name).append("=\"");
        if (value != null) escapeXml(sb, value);
        sb.append('"');
    }

    private static void bool(StringBuilder sb, String name, boolean v) {
        sb.append(' ').append(name).append("=\"").append(v).append('"');
    }

    private static void escapeXml(StringBuilder sb, CharSequence s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '&': sb.append("&amp;"); break;
                case '"': sb.append("&quot;"); break;
                case '\n': sb.append("&#10;"); break;
                default:
                    // XML 1.0에서 허용되지 않는 제어 문자 제거
                    if (c >= 0x20 || c == '\t') sb.append(c);
            }
        }
    }

    // ---------- 현재 화면 ----------

    /** 활성 윈도우의 패키지와, 접근성 이벤트로 추적한 그 패키지의 마지막 Activity */
    private String state() {
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        String pkg = root != null && root.getPackageName() != null ? root.getPackageName().toString() : "";
        String activity = tracker.activityOf(pkg);
        return "{\"package\":" + json(pkg) + ",\"activity\":" + json(activity == null ? "" : activity)
                + ",\"lastWindowClass\":" + json(tracker.lastWindowClass()) + "}";
    }

    // ---------- 입력 ----------

    /** 포커스된 입력창에 ACTION_SET_TEXT. adb input text와 달리 한글 등 유니코드를 지원한다 */
    private String setText(String text, boolean append) {
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("활성 윈도우가 없습니다");
        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null || !focused.isEditable()) throw new IllegalStateException("포커스된 입력창이 없습니다. 입력창을 먼저 탭하세요");
        String value = text;
        if (append && focused.getText() != null && !isShowingHint(focused)) value = focused.getText() + text;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (!ok) throw new IllegalStateException("ACTION_SET_TEXT 실패");
        return "{\"ok\":true,\"length\":" + value.length() + "}";
    }

    private static boolean isShowingHint(AccessibilityNodeInfo n) {
        return android.os.Build.VERSION.SDK_INT >= 26 && n.isShowingHintText();
    }

    // ---------- 대기 ----------

    private String waitIdle(long quietMs, long timeoutMs) {
        long t0 = System.currentTimeMillis();
        try {
            ui.waitForIdle(quietMs, timeoutMs);
            return "{\"ok\":true,\"idle\":true,\"ms\":" + (System.currentTimeMillis() - t0) + "}";
        } catch (TimeoutException e) {
            return "{\"ok\":true,\"idle\":false,\"ms\":" + (System.currentTimeMillis() - t0) + "}";
        }
    }

    private static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

}
