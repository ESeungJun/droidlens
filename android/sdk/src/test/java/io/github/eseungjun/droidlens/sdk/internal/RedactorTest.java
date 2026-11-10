package io.github.eseungjun.droidlens.sdk.internal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 네트워크 기록 가리기 규칙. 이름 사례는 packages/core/test/redact.test.mjs 와 같은 표에서 두 쪽이 같게 판정하는 것만 쓴다
 * (리포트용 TS 규칙은 auth_code·휴대폰번호 같은 이름과 URL 의 모든 쿼리 값을 더 넓게 가린다).
 * Redactor 는 프로세스에 하나라 기본 규칙을 끄는 시험은 두지 않는다.
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
    public void 헤더는_이름으로_가리고_리다이렉트_주소는_쿼리만_가린다() {
        Map<String, List<String>> in = new LinkedHashMap<>();
        in.put("Authorization", Collections.singletonList("Bearer abc"));
        in.put("Set-Cookie", Arrays.asList("a=1", "b=2"));
        in.put("Accept", Collections.singletonList("application/json"));
        in.put("Location", Collections.singletonList("https://a.com/cb?code=1&token=abc"));
        Map<String, List<String>> out = r.headers(in);
        assertEquals(Collections.singletonList(M), out.get("Authorization"));
        assertEquals(Arrays.asList(M, M), out.get("Set-Cookie"));
        assertEquals(Collections.singletonList("application/json"), out.get("Accept"));
        assertEquals(Collections.singletonList("https://a.com/cb?code=1&token=" + M), out.get("Location"));
    }

    @Test
    public void url_은_비밀_키의_쿼리_값만_가리고_구조는_남긴다() {
        assertEquals("https://a.com/p?q=1&access_token=" + M + "#frag", r.url("https://a.com/p?q=1&access_token=abc#frag"));
        assertEquals("https://a.com/p?user%5Bpassword%5D=" + M, r.url("https://a.com/p?user%5Bpassword%5D=x"));
        assertEquals("myapp://home/detail/42", r.url("myapp://home/detail/42"));
        assertEquals("https://a.com/p?flag&q=1", r.url("https://a.com/p?flag&q=1"));
    }

    @Test
    public void 자유_텍스트_안의_URL_쿼리도_가린다() {
        assertEquals("failed https://a.com/x?token=" + M + " end", r.text("failed https://a.com/x?token=abc end"));
    }

    @Test
    public void json_은_비밀_키의_값_범위를_통째로_바꾼다() {
        assertEquals("{\"theme\":\"dark\",\"auth_token\":\"" + M + "\"}", r.json("{\"theme\":\"dark\",\"auth_token\":\"abc\"}"));
        assertEquals("{\"token\": \"" + M + "\",\"x\":2}", r.json("{\"token\": {\"a\":[1,\"}\"]},\"x\":2}"));
        assertEquals("{\"pin\":\"" + M + "\",\"n\":1}", r.json("{\"pin\":1234,\"n\":1}"));
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
