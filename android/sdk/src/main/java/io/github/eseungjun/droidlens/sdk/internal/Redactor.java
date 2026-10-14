package io.github.eseungjun.droidlens.sdk.internal;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * 네트워크 기록에서 민감 정보를 가린다. 기기 안에서 저장하기 전에 적용하므로 가린 값은 메모리에도 남지 않고
 * DroidLens 데스크톱·cURL 복사로도 나가지 않는다.
 *
 * <p>키 이름은 소문자로 바꾸고 기호를 뺀 형태로 비교한다 (access_token · accessToken · access-token 을 같은 키로 본다).
 * JSON 은 파싱하지 않고 직접 훑어 값의 범위(문자열·객체·배열·숫자)를 통째로 바꾼다.
 * 최대 크기에서 잘린 본문처럼 구조가 깨진 JSON 도 놓치지 않기 위해서다.
 */
public final class Redactor {
    public static final String MASK = "[REDACTED]";

    private static final List<String> DEFAULT_HEADERS = Arrays.asList(
            "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
            "x-access-token", "x-csrf-token", "x-xsrf-token");
    private static final List<String> DEFAULT_KEYS = Arrays.asList(
            "password", "passwd", "pwd", "pin", "token", "access_token", "refresh_token", "id_token", "auth_token",
            "secret", "client_secret", "api_key", "authorization", "session_id", "session_token", "private_key",
            "otp", "card_number", "cvc", "cvv");

    private static final Redactor INSTANCE = new Redactor();

    public static Redactor get() {
        return INSTANCE;
    }

    private final Set<String> headers = new CopyOnWriteArraySet<>();
    private final Set<String> keys = new CopyOnWriteArraySet<>();

    private Redactor() {
        for (String h : DEFAULT_HEADERS) headers.add(norm(h));
        for (String k : DEFAULT_KEYS) keys.add(norm(k));
    }

    /** 비교용 키: 소문자 + 영숫자만 */
    static String norm(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = Character.toLowerCase(s.charAt(i));
            if (Character.isLetterOrDigit(c)) b.append(c);
        }
        return b.toString();
    }

    public void addHeaders(String... names) {
        for (String n : names) if (n != null && !norm(n).isEmpty()) headers.add(norm(n));
    }

    public void addKeys(String... names) {
        for (String n : names) if (n != null && !norm(n).isEmpty()) keys.add(norm(n));
    }

    /** 기본 규칙을 지우고 앱이 직접 추가한 항목만 가린다 */
    public void clearDefaults() {
        for (String h : DEFAULT_HEADERS) headers.remove(norm(h));
        for (String k : DEFAULT_KEYS) keys.remove(norm(k));
    }

    private boolean sensitiveKey(String raw) {
        if (raw == null) return false;
        if (keys.contains(norm(raw))) return true;
        // 폼의 user[password] 처럼 대괄호로 감싼 하위 키
        int open = raw.lastIndexOf('[');
        int close = raw.lastIndexOf(']');
        return open >= 0 && close > open && keys.contains(norm(raw.substring(open + 1, close)));
    }

    public Map<String, List<String>> headers(Map<String, List<String>> in) {
        if (in == null || headers.isEmpty()) return in;
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> e : in.entrySet()) {
            if (e.getKey() == null || !headers.contains(norm(e.getKey()))) {
                out.put(e.getKey(), e.getValue());
                continue;
            }
            List<String> masked = new ArrayList<>();
            for (int i = 0; i < e.getValue().size(); i++) masked.add(MASK);
            out.put(e.getKey(), masked);
        }
        return out;
    }

    public String url(String url) {
        if (url == null || keys.isEmpty()) return url;
        int q = url.indexOf('?');
        if (q < 0) return url;
        int hash = url.indexOf('#', q);
        int end = hash < 0 ? url.length() : hash;
        return url.substring(0, q + 1) + pairs(url.substring(q + 1, end)) + url.substring(end);
    }

    /** key=value&... 에서 민감 키의 값을 가린다 (키는 URL 디코딩해서 비교) */
    private String pairs(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        while (i <= s.length()) {
            int amp = s.indexOf('&', i);
            int stop = amp < 0 ? s.length() : amp;
            String part = s.substring(i, stop);
            int eq = part.indexOf('=');
            if (eq > 0 && sensitiveKey(decode(part.substring(0, eq)))) out.append(part, 0, eq + 1).append(MASK);
            else out.append(part);
            if (amp < 0) break;
            out.append('&');
            i = amp + 1;
        }
        return out.toString();
    }

    private static String decode(String s) {
        try {
            return URLDecoder.decode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    /** 텍스트 본문(JSON·폼)만 가린다. 이미지 같은 바이너리는 그대로 둔다 */
    public byte[] body(byte[] body, String contentType) {
        if (body == null || body.length == 0 || keys.isEmpty()) return body;
        String ct = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        boolean form = ct.contains("x-www-form-urlencoded");
        boolean text = ct.isEmpty() || ct.contains("json") || ct.startsWith("text/") || ct.contains("javascript");
        if (!form && !text) return body;
        String s = new String(body, StandardCharsets.UTF_8);
        String out = form ? pairs(s) : json(s);
        return out.equals(s) ? body : out.getBytes(StandardCharsets.UTF_8);
    }

    /** JSON(또는 JSON 이 섞인 텍스트)을 훑어 민감 키의 값 범위를 통째로 바꾼다 */
    String json(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        int n = s.length();
        while (i < n) {
            char c = s.charAt(i);
            if (c != '"') {
                out.append(c);
                i++;
                continue;
            }
            int strEnd = skipString(s, i);
            String token = s.substring(i, strEnd);
            out.append(token);
            i = strEnd;
            // 문자열 뒤에 ':' 가 오면 키
            int j = skipSpace(s, i);
            if (j >= n || s.charAt(j) != ':') continue;
            String key = unquote(token);
            if (!sensitiveKey(key)) continue;
            int v = skipSpace(s, j + 1);
            out.append(s, i, v).append('"').append(MASK).append('"');
            i = skipValue(s, v);
        }
        return out.toString();
    }

    private static int skipSpace(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    /** 따옴표로 시작하는 문자열의 끝(닫는 따옴표 다음). 잘렸으면 본문 끝 */
    private static int skipString(String s, int i) {
        int j = i + 1;
        while (j < s.length()) {
            char c = s.charAt(j);
            if (c == '\\') j += 2;
            else if (c == '"') return j + 1;
            else j++;
        }
        return s.length();
    }

    /** 값 하나(문자열·객체·배열·숫자·리터럴)의 끝. 잘렸으면 본문 끝 */
    private static int skipValue(String s, int i) {
        if (i >= s.length()) return i;
        char c = s.charAt(i);
        if (c == '"') return skipString(s, i);
        if (c == '{' || c == '[') {
            int depth = 0;
            int j = i;
            while (j < s.length()) {
                char d = s.charAt(j);
                if (d == '"') {
                    j = skipString(s, j);
                    continue;
                }
                if (d == '{' || d == '[') depth++;
                else if (d == '}' || d == ']') {
                    depth--;
                    if (depth == 0) return j + 1;
                }
                j++;
            }
            return s.length();
        }
        int j = i;
        while (j < s.length() && ",}] \t\r\n".indexOf(s.charAt(j)) < 0) j++;
        return j;
    }

    private static String unquote(String token) {
        String t = token.length() >= 2 && token.endsWith("\"") ? token.substring(1, token.length() - 1) : token.substring(1);
        return t.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
