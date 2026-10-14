package io.github.eseungjun.droidlens.sdk.internal;

import java.net.URLDecoder;
import java.nio.charset.Charset;
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
 * 네트워크 기록·커스텀 이벤트에서 민감 정보를 가린다. 기기 안에서 저장하기 전에 적용하므로 가린 값은 메모리에도 남지 않고
 * DroidLens 데스크톱·cURL 복사·MCP 로도 나가지 않는다.
 *
 * <p>키 판정: 이름을 소문자 + 영숫자만 남긴 뒤 비교한다 (access_token = accessToken = access-token).
 * password·token·secret 처럼 흔한 단어는 키 이름에 들어 있기만 하면 가리고 (newPassword, fcmToken, X-Refresh-Token),
 * jwt·otp·pin 처럼 짧은 단어는 오탐을 줄이려고 정확히 같을 때만 가린다.
 *
 * <p>본문: JSON 은 파싱하지 않고 직접 훑어 값 범위(문자열·객체·배열·숫자)를 통째로 바꾼다 (잘린 본문도 처리).
 * 문자열 값 안에 다시 들어 있는 JSON 과 GraphQL 인자, 폼, multipart 텍스트 파트, XML 요소·속성도 가린다.
 */
public final class Redactor {
    public static final String MASK = "[REDACTED]";

    /** 키 이름에 들어 있으면 가린다 */
    private static final List<String> DEFAULT_CONTAINS = Arrays.asList(
            "password", "passwd", "passphrase", "secret", "token", "apikey", "accesskey", "privatekey",
            "credential", "authorization", "sessionid", "sessionkey", "cardnumber", "cookie");
    /** 짧아서 다른 단어 안에 흔히 들어가는 이름은 정확히 같을 때만 */
    private static final List<String> DEFAULT_EXACT = Arrays.asList("jwt", "otp", "pin", "pwd", "cvc", "cvv", "ssn", "auth");
    /** 헤더 이름에 들어 있으면 가린다 */
    private static final List<String> DEFAULT_HEADERS = Arrays.asList(
            "authorization", "cookie", "token", "secret", "apikey", "session", "password", "credential", "signature");

    private static final Redactor INSTANCE = new Redactor();

    public static Redactor get() {
        return INSTANCE;
    }

    private volatile boolean defaults = true;
    private final Set<String> userKeys = new CopyOnWriteArraySet<>();
    private final Set<String> userHeaders = new CopyOnWriteArraySet<>();

    private Redactor() {}

    /** 비교용 이름: 소문자 + 영숫자만 */
    static String norm(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = Character.toLowerCase(s.charAt(i));
            if (Character.isLetterOrDigit(c)) b.append(c);
        }
        return b.toString();
    }

    public void addHeaders(String... names) {
        for (String n : names) if (n != null && !norm(n).isEmpty()) userHeaders.add(norm(n));
    }

    public void addKeys(String... names) {
        for (String n : names) if (n != null && !norm(n).isEmpty()) userKeys.add(norm(n));
    }

    /** 기본 규칙을 끄고 앱이 직접 추가한 항목만 가린다 (직접 추가한 항목은 호출 순서와 상관없이 유지) */
    public void clearDefaults() {
        defaults = false;
    }

    /** 사용자 항목은 4글자 이상이면 포함 여부로, 더 짧으면 정확히 같을 때만 */
    private static boolean userMatch(Set<String> set, String n) {
        for (String u : set) if (u.length() >= 4 ? n.contains(u) : n.equals(u)) return true;
        return false;
    }

    private boolean keyMatch(String n) {
        if (n.isEmpty()) return false;
        if (userMatch(userKeys, n)) return true;
        if (!defaults) return false;
        if (DEFAULT_EXACT.contains(n)) return true;
        for (String c : DEFAULT_CONTAINS) if (n.contains(c)) return true;
        return false;
    }

    /** 키 이름이 민감한지. 폼의 user[password][] 처럼 대괄호로 감싼 하위 키도 하나씩 본다 */
    boolean sensitiveKey(String raw) {
        if (raw == null) return false;
        if (keyMatch(norm(raw))) return true;
        for (String part : raw.split("[\\[\\]]+")) if (!part.isEmpty() && keyMatch(norm(part))) return true;
        return false;
    }

    boolean sensitiveHeader(String name) {
        if (name == null) return false;
        String n = norm(name);
        if (userMatch(userHeaders, n)) return true;
        if (!defaults) return false;
        for (String c : DEFAULT_HEADERS) if (n.contains(c)) return true;
        return false;
    }

    public Map<String, List<String>> headers(Map<String, List<String>> in) {
        if (in == null) return null;
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> e : in.entrySet()) {
            String name = e.getKey();
            List<String> values = new ArrayList<>();
            boolean hide = sensitiveHeader(name);
            // 리다이렉트 주소의 쿼리에 토큰이 들어가는 경우가 있다
            boolean urlish = name != null && ("location".equalsIgnoreCase(name) || "content-location".equalsIgnoreCase(name));
            for (String v : e.getValue()) values.add(hide ? MASK : urlish ? url(v) : v);
            out.put(name, values);
        }
        return out;
    }

    public String url(String url) {
        if (url == null) return null;
        int q = url.indexOf('?');
        if (q < 0) return url;
        int hash = url.indexOf('#', q);
        int end = hash < 0 ? url.length() : hash;
        return url.substring(0, q + 1) + pairs(url.substring(q + 1, end)) + url.substring(end);
    }

    private static final Pattern URL_IN_TEXT = Pattern.compile("https?://[^\\s\"'<>]+");

    /** 오류 메시지처럼 URL 이 섞인 자유 텍스트 */
    public String text(String s) {
        if (s == null) return null;
        Matcher m = URL_IN_TEXT.matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) m.appendReplacement(out, Matcher.quoteReplacement(url(m.group())));
        m.appendTail(out);
        return json(out.toString());
    }

    /** key=value&... 에서 민감 키의 값을 가린다 (키는 URL 디코딩해서 비교) */
    String pairs(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        while (true) {
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

    private static final Pattern CHARSET = Pattern.compile("charset=\"?([\\w.:-]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern BOUNDARY = Pattern.compile("boundary=\"?([^\";]+)", Pattern.CASE_INSENSITIVE);

    /** 본문을 가린다. 이미지 같은 바이너리와 알 수 없는 형식은 그대로 둔다 */
    public byte[] body(byte[] body, String contentType) {
        if (body == null || body.length == 0) return body;
        String ct = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        if (ct.startsWith("multipart/")) {
            Matcher b = BOUNDARY.matcher(contentType);
            return b.find() ? multipart(body, b.group(1)) : body;
        }
        boolean form = ct.contains("x-www-form-urlencoded");
        boolean xml = ct.contains("xml");
        boolean text = ct.isEmpty() || ct.contains("json") || ct.startsWith("text/") || ct.contains("javascript") || ct.contains("graphql");
        if (!form && !xml && !text) return body;
        if (looksBinary(body)) return body;
        Charset cs = charset(contentType);
        String s = new String(body, cs);
        String out;
        if (form) out = pairs(s);
        else if (xml) out = xml(s);
        else {
            out = json(s);
            if (out.trim().startsWith("<")) out = xml(out);
            if (looksLikeForm(out)) out = pairs(out);
        }
        return out.equals(s) ? body : out.getBytes(cs);
    }

    private static Charset charset(String contentType) {
        if (contentType != null) {
            Matcher m = CHARSET.matcher(contentType);
            if (m.find()) {
                try {
                    return Charset.forName(m.group(1));
                } catch (Exception ignored) {
                    // 모르는 charset 은 UTF-8 로
                }
            }
        }
        return StandardCharsets.UTF_8;
    }

    /** 앞부분에 NUL 바이트가 있으면 바이너리로 본다 (큰 바이너리를 문자열로 바꿔 훑는 비용을 피한다) */
    private static boolean looksBinary(byte[] b) {
        for (int i = 0, n = Math.min(b.length, 1024); i < n; i++) if (b[i] == 0) return true;
        return false;
    }

    private static boolean looksLikeForm(String s) {
        if (s.isEmpty() || s.indexOf('=') < 0) return false;
        for (int i = 0; i < s.length(); i++) if (Character.isWhitespace(s.charAt(i)) || s.charAt(i) == '{') return false;
        return true;
    }

    // ---------- multipart ----------

    private static final Pattern PART_NAME = Pattern.compile("name=\"([^\"]*)\"", Pattern.CASE_INSENSITIVE);

    /** 텍스트 파트 중 이름이 민감한 것의 값을 가린다. 파일 파트는 건드리지 않는다 (바이트 보존을 위해 ISO-8859-1 로 다룸) */
    byte[] multipart(byte[] body, String boundary) {
        String s = new String(body, StandardCharsets.ISO_8859_1);
        String delim = "--" + boundary;
        String[] parts = s.split(Pattern.quote(delim), -1);
        StringBuilder out = new StringBuilder(s.length());
        boolean changed = false;
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) out.append(delim);
            String p = parts[i];
            int head = p.indexOf("\r\n\r\n");
            if (head < 0) {
                out.append(p);
                continue;
            }
            String headers = p.substring(0, head);
            Matcher m = PART_NAME.matcher(headers);
            boolean file = headers.toLowerCase(Locale.ROOT).contains("filename=");
            if (!file && m.find() && sensitiveKey(m.group(1))) {
                int end = p.endsWith("\r\n") ? p.length() - 2 : p.length();
                out.append(p, 0, head + 4).append(MASK).append(p, end, p.length());
                changed = true;
            } else out.append(p);
        }
        return changed ? out.toString().getBytes(StandardCharsets.ISO_8859_1) : body;
    }

    // ---------- XML ----------

    private static final Pattern XML_ELEMENT = Pattern.compile("<([\\w:.-]+)(\\s[^>]*)?>([^<]*)</\\1\\s*>");
    private static final Pattern XML_ATTR = Pattern.compile("([\\w:.-]+)(\\s*=\\s*)(\"[^\"]*\"|'[^']*')");

    String xml(String s) {
        Matcher m = XML_ELEMENT.matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String name = m.group(1);
            String local = name.substring(name.lastIndexOf(':') + 1);
            String rep = sensitiveKey(local) ? "<" + name + (m.group(2) == null ? "" : m.group(2)) + ">" + MASK + "</" + name + ">" : m.group();
            m.appendReplacement(out, Matcher.quoteReplacement(rep));
        }
        m.appendTail(out);
        Matcher a = XML_ATTR.matcher(out.toString());
        StringBuffer out2 = new StringBuffer();
        while (a.find()) {
            String local = a.group(1).substring(a.group(1).lastIndexOf(':') + 1);
            String q = a.group(3).substring(0, 1);
            String rep = sensitiveKey(local) ? a.group(1) + a.group(2) + q + MASK + q : a.group();
            a.appendReplacement(out2, Matcher.quoteReplacement(rep));
        }
        a.appendTail(out2);
        return out2.toString();
    }

    // ---------- JSON ----------

    /** JSON(또는 JSON 이 섞인 텍스트)을 훑어 민감 키의 값 범위를 통째로 바꾼다 */
    public String json(String s) {
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
            i = strEnd;
            int j = skipSpace(s, i);
            if (j < n && s.charAt(j) == ':') {
                // 키
                out.append(token);
                if (!sensitiveKey(unquote(token))) continue;
                int v = skipSpace(s, j + 1);
                out.append(s, i, v).append('"').append(MASK).append('"');
                i = skipValue(s, v);
            } else {
                // 값: 문자열 안에 JSON 이나 GraphQL 이 다시 들어 있으면 풀어서 훑는다
                out.append(nested(token));
            }
        }
        return out.toString();
    }

    private static final Pattern GRAPHQL_ARG = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)(\\s*:\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|[^\\s,)}\\]]+)");
    private static final Pattern GRAPHQL_DOC = Pattern.compile("^\\s*(query|mutation|subscription|fragment)?\\b[^{]*\\{", Pattern.CASE_INSENSITIVE);

    private String nested(String token) {
        if (token.length() < 4 || !token.endsWith("\"")) return token;
        String raw = unquote(token);
        String trimmed = raw.trim();
        String out = raw;
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) out = json(raw);
        if (GRAPHQL_DOC.matcher(raw).find()) out = graphql(out);
        return out.equals(raw) ? token : quote(out);
    }

    /** GraphQL 문서의 인자 login(password: "x") */
    String graphql(String s) {
        Matcher m = GRAPHQL_ARG.matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String rep = sensitiveKey(m.group(1)) && m.group(3).startsWith("\"") ? m.group(1) + m.group(2) + "\"" + MASK + "\"" : m.group();
            m.appendReplacement(out, Matcher.quoteReplacement(rep));
        }
        m.appendTail(out);
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

    /** JSON 문자열 토큰의 이스케이프를 푼다 (\\uXXXX 포함) */
    static String unquote(String token) {
        int end = token.length() >= 2 && token.endsWith("\"") ? token.length() - 1 : token.length();
        StringBuilder b = new StringBuilder(end);
        for (int i = 1; i < end; i++) {
            char c = token.charAt(i);
            if (c != '\\' || i + 1 >= end) {
                b.append(c);
                continue;
            }
            char e = token.charAt(++i);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u':
                    if (i + 4 < end) {
                        try {
                            b.append((char) Integer.parseInt(token.substring(i + 1, i + 5), 16));
                            i += 4;
                            break;
                        } catch (NumberFormatException ignored) {
                            // 잘못된 이스케이프는 그대로
                        }
                    }
                    b.append('u');
                    break;
                default: b.append(e);
            }
        }
        return b.toString();
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
