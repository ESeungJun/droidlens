package io.github.eseungjun.droidlens.sdk.internal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 네트워크 기록 가리기 규칙. 이름·값 모양·URL 은 TS(packages/core/src/redact.ts)와 같은 사례표
 * (packages/core/test/fixtures/redact-cases.json)를 읽어 시험한다 — 두 구현이 갈리면 여기서 깨진다.
 * 그 밖은 자바 고유 규칙(헤더·본문 형식별 처리)이다. Redactor 는 프로세스에 하나라 기본 규칙을 끄는 시험은 두지 않는다.
 */
public class RedactorTest {
    private static final String M = Redactor.MASK;
    private final Redactor r = Redactor.get();

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private String body(String s, String contentType) {
        return new String(r.body(utf8(s), contentType), StandardCharsets.UTF_8);
    }

    /** 저장소 루트의 공유 사례표. 경로는 build.gradle 이 시스템 프로퍼티로 넘긴다 */
    private static JSONObject cases() throws Exception {
        String root = System.getProperty("droidlens.repoRoot");
        assertTrue("droidlens.repoRoot 가 없다 (build.gradle 의 testOptions 확인)", root != null && !root.isEmpty());
        byte[] raw = Files.readAllBytes(Paths.get(root, "packages", "core", "test", "fixtures", "redact-cases.json"));
        return new JSONObject(new String(raw, StandardCharsets.UTF_8));
    }

    private static List<String> strings(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    @Test
    public void 공유_사례표_이름_판정() throws Exception {
        JSONObject names = cases().getJSONObject("names");
        List<String> secret = strings(names.getJSONArray("secret"));
        List<String> plain = strings(names.getJSONArray("plain"));
        assertTrue(secret.size() >= 40 && plain.size() >= 20);
        for (String n : secret) assertTrue(n, r.sensitiveKey(n));
        for (String n : plain) assertFalse(n, r.sensitiveKey(n));
    }

    @Test
    public void 공유_사례표_값_모양() throws Exception {
        JSONObject looks = cases().getJSONObject("looksSecret");
        for (String v : strings(looks.getJSONArray("secret"))) assertTrue(v, Redactor.looksSecret(v));
        for (String v : strings(looks.getJSONArray("plain"))) assertFalse(v, Redactor.looksSecret(v));
    }

    @Test
    public void 공유_사례표_URL() throws Exception {
        JSONArray urls = cases().getJSONArray("urls");
        assertTrue(urls.length() >= 20);
        for (int i = 0; i < urls.length(); i++) {
            JSONArray c = urls.getJSONArray(i);
            assertEquals(c.getString(0), c.getString(1).replace("<MASK>", M), r.url(c.getString(0)));
        }
    }

    @Test
    public void 비밀_키_이름은_잡고_단어_안에_섞인_짧은_말은_잡지_않는다() {
        for (String n : new String[] {"password", "userPassword", "api-key", "pin", "session_id", "cardNumber", "access_token", "X-Refresh-Token", "user[password][]"}) {
            assertTrue(n, r.sensitiveKey(n));
        }
        for (String n : new String[] {"spinner", "keyword", "author", "theme", "nickname", "", null}) {
            assertFalse(String.valueOf(n), r.sensitiveKey(n));
        }
    }

    @Test
    public void 헤더는_이름으로_가리고_리다이렉트_주소는_URL_규칙으로_가린다() {
        Map<String, List<String>> in = new LinkedHashMap<>();
        in.put("Authorization", Collections.singletonList("Bearer abc"));
        in.put("Set-Cookie", Arrays.asList("a=1", "b=2"));
        in.put("Accept", Collections.singletonList("application/json"));
        in.put("Location", Collections.singletonList("https://a.com/cb?code=1&token=abc&page=2"));
        in.put("X-Auth-Code", Collections.singletonList("1234"));
        in.put("Content-Encoding", Collections.singletonList("gzip"));
        Map<String, List<String>> out = r.headers(in);
        assertEquals(Collections.singletonList(M), out.get("Authorization"));
        assertEquals(Arrays.asList(M, M), out.get("Set-Cookie"));
        assertEquals(Collections.singletonList("application/json"), out.get("Accept"));
        // OAuth 인가 코드(code)도 비밀 키다
        assertEquals(Collections.singletonList("https://a.com/cb?code=" + M + "&token=" + M + "&page=2"), out.get("Location"));
        assertEquals(Collections.singletonList(M), out.get("X-Auth-Code"));
        assertEquals(Collections.singletonList("gzip"), out.get("Content-Encoding"));
    }

    @Test
    public void url_쿼리는_비밀_키와_토큰_모양_값만_가리고_평범한_값은_남긴다() {
        // 요청을 구분해야 해서 평범한 쿼리 값은 남긴다 (리포트용 TS 는 쿼리 값을 전부 가린다 — 사례표에 넣지 않은 차이)
        assertEquals("https://a.com/p?q=1&access_token=" + M + "#" + M, r.url("https://a.com/p?q=1&access_token=abc#frag"));
        assertEquals("https://a.com/p?page=2&t=" + M, r.url("https://a.com/p?page=2&t=0123456789abcdef01234567"));
        assertEquals("https://a.com/p?auth_code=" + M + "&authCode=" + M + "&%ED%9C%B4%EB%8C%80%ED%8F%B0=" + M,
                r.url("https://a.com/p?auth_code=1&authCode=2&%ED%9C%B4%EB%8C%80%ED%8F%B0=010"));
        assertEquals("https://a.com/p?user%5Bpassword%5D=" + M, r.url("https://a.com/p?user%5Bpassword%5D=x"));
        assertEquals("myapp://home/detail/42", r.url("myapp://home/detail/42"));
        assertEquals("https://a.com/p?flag&q=1", r.url("https://a.com/p?flag&q=1"));
    }

    @Test
    public void 자유_텍스트_안의_URL_쿼리도_가린다() {
        assertEquals("failed https://a.com/x?token=" + M + " end", r.text("failed https://a.com/x?token=abc end"));
        assertEquals("GET https://" + M + "@a.com/reset/" + M + " 401", r.text("GET https://u:p@a.com/reset/eyJhbGciOiJIUzI1NiJ9.x.y 401"));
    }

    @Test
    public void json_은_비밀_키의_값_범위를_통째로_바꾼다() {
        assertEquals("{\"theme\":\"dark\",\"auth_token\":\"" + M + "\"}", r.json("{\"theme\":\"dark\",\"auth_token\":\"abc\"}"));
        assertEquals("{\"token\": \"" + M + "\",\"x\":2}", r.json("{\"token\": {\"a\":[1,\"}\"]},\"x\":2}"));
        assertEquals("{\"pin\":\"" + M + "\",\"n\":1}", r.json("{\"pin\":1234,\"n\":1}"));
        // 단어 단위 규칙: auth_code·authCode·한글 이름은 가리고 author·keyword 는 남긴다
        assertEquals("{\"auth_code\":\"" + M + "\",\"authCode\":\"" + M + "\",\"휴대폰번호\":\"" + M + "\",\"author\":\"kim\",\"keyword\":\"신발\"}",
                r.json("{\"auth_code\":\"1\",\"authCode\":\"2\",\"휴대폰번호\":\"010\",\"author\":\"kim\",\"keyword\":\"신발\"}"));
        // 잘린 본문
        assertEquals("{\"a\":1,\"password\":\"" + M + "\"", r.json("{\"a\":1,\"password\":\"abc"));
    }

    @Test
    public void 문자열_값_안의_JSON_과_GraphQL_인자도_가린다() {
        assertEquals("{\"payload\":\"{\\\"password\\\":\\\"" + M + "\\\"}\"}", r.json("{\"payload\":\"{\\\"password\\\":\\\"x\\\"}\"}"));
        assertEquals(
                "{\"query\":\"mutation { login(id: \\\"u\\\", password: \\\"" + M + "\\\") { id } }\"}",
                r.json("{\"query\":\"mutation { login(id: \\\"u\\\", password: \\\"x\\\") { id } }\"}"));
    }

    @Test
    public void 본문은_형식에_맞춰_가리고_바이너리는_그대로_둔다() {
        assertEquals("user=a&password=" + M, body("user=a&password=b", "application/x-www-form-urlencoded"));
        assertEquals("<r><password>" + M + "</password><a token=\"" + M + "\">v</a></r>",
                body("<r><password>x</password><a token=\"t\">v</a></r>", "application/xml"));
        assertEquals("{\"secret\":\"" + M + "\"}", body("{\"secret\":\"x\"}", "application/json; charset=utf-8"));
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2};
        assertSame(png, r.body(png, "image/png"));
        byte[] nul = {'{', '"', 'p', 'i', 'n', '"', ':', 0, '}'};
        assertSame(nul, r.body(nul, "application/json"));
        // 바뀐 것이 없으면 같은 배열
        byte[] plain = utf8("{\"theme\":\"dark\"}");
        assertSame(plain, r.body(plain, "application/json"));
    }

    @Test
    public void multipart_는_비밀_이름의_텍스트_파트만_가린다() {
        String in = "--B\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nhunter2\r\n"
                + "--B\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhello\r\n"
                + "--B\r\nContent-Disposition: form-data; name=\"token\"; filename=\"t.bin\"\r\n\r\nRAW\r\n--B--\r\n";
        String want = in.replace("hunter2", M);
        assertArrayEquals(utf8(want), r.body(utf8(in), "multipart/form-data; boundary=B"));
    }

    @Test
    public void 앱이_추가한_키는_4글자_이상이면_포함으로_본다() {
        r.addKeys("phone");
        assertTrue(r.sensitiveKey("phoneNumber"));
        assertEquals("{\"phone_number\":\"" + M + "\"}", r.json("{\"phone_number\":\"010\"}"));
    }
}
