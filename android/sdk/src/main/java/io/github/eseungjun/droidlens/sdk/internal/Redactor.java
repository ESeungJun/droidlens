package io.github.eseungjun.droidlens.sdk.internal;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 네트워크 기록에서 민감 정보를 가린다. 기기 안에서 저장하기 전에 적용하므로 가린 값은 메모리에도 남지 않고
 * DroidLens 데스크톱·cURL 복사로도 나가지 않는다.
 *
 * <p>본문은 JSON 을 파싱하지 않고 키 패턴으로 바꾼다. 최대 크기에서 잘린 본문처럼 구조가 깨진 JSON 도 놓치지 않기 위해서다.
 */
public final class Redactor {
    public static final String MASK = "[REDACTED]";

    private static final List<String> DEFAULT_HEADERS = Arrays.asList(
            "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token");
    private static final List<String> DEFAULT_KEYS = Arrays.asList(
            "password", "passwd", "pwd", "token", "access_token", "accesstoken", "refresh_token", "refreshtoken",
            "id_token", "secret", "client_secret", "api_key", "apikey", "authorization", "session_id", "sessionid");

    private static final Redactor INSTANCE = new Redactor();

    public static Redactor get() {
        return INSTANCE;
    }

    private final Set<String> headers = new CopyOnWriteArraySet<>(DEFAULT_HEADERS);
    private final Set<String> keys = new CopyOnWriteArraySet<>(DEFAULT_KEYS);
    private volatile Pattern jsonPattern;
    private volatile Pattern pairPattern;

    private Redactor() {
        rebuild();
    }

    public void addHeaders(String... names) {
        for (String n : names) if (n != null && !n.isEmpty()) headers.add(n.toLowerCase(Locale.ROOT));
    }

    public void addKeys(String... names) {
        for (String n : names) if (n != null && !n.isEmpty()) keys.add(n.toLowerCase(Locale.ROOT));
        rebuild();
    }

    /** 기본 규칙을 지우고 앱이 직접 추가한 항목만 가린다 */
    public void clearDefaults() {
        headers.removeAll(DEFAULT_HEADERS);
        keys.removeAll(DEFAULT_KEYS);
        rebuild();
    }

    private void rebuild() {
        if (keys.isEmpty()) {
            jsonPattern = null;
            pairPattern = null;
            return;
        }
        StringBuilder alt = new StringBuilder();
        for (String k : keys) {
            if (alt.length() > 0) alt.append('|');
            alt.append(Pattern.quote(k));
        }
        // "key" : "문자열" 또는 숫자·true·null
        jsonPattern = Pattern.compile(
                "(\"(?:" + alt + ")\"\\s*:\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"?|[^,}\\]\\s]+)", Pattern.CASE_INSENSITIVE);
        // URL 쿼리·폼 본문의 key=value
        pairPattern = Pattern.compile("((?:^|[?&])(?:" + alt + ")=)([^&#]*)", Pattern.CASE_INSENSITIVE);
    }

    public Map<String, List<String>> headers(Map<String, List<String>> in) {
        if (in == null || headers.isEmpty()) return in;
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> e : in.entrySet()) {
            boolean hide = e.getKey() != null && headers.contains(e.getKey().toLowerCase(Locale.ROOT));
            if (!hide) {
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
        Pattern p = pairPattern;
        if (url == null || p == null || url.indexOf('?') < 0) return url;
        return p.matcher(url).replaceAll("$1" + Matcher.quoteReplacement(MASK));
    }

    /** 텍스트 본문(JSON·폼)만 가린다. 이미지 같은 바이너리는 그대로 둔다 */
    public byte[] body(byte[] body, String contentType) {
        if (body == null || body.length == 0) return body;
        String ct = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        boolean json = ct.contains("json");
        boolean form = ct.contains("x-www-form-urlencoded");
        if (!json && !form && !ct.isEmpty() && !ct.startsWith("text/")) return body;
        String s = new String(body, StandardCharsets.UTF_8);
        String out = s;
        Pattern jp = jsonPattern;
        Pattern pp = pairPattern;
        if (jp != null && (json || ct.isEmpty() || ct.startsWith("text/"))) {
            out = jp.matcher(out).replaceAll("$1\"" + Matcher.quoteReplacement(MASK) + "\"");
        }
        if (pp != null && form) out = pp.matcher(out).replaceAll("$1" + Matcher.quoteReplacement(MASK));
        return out.equals(s) ? body : out.getBytes(StandardCharsets.UTF_8);
    }
}
