package io.github.eseungjun.droidlens.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RequestGuardTest {
    private static String reject(String method, String... headers) {
        return RequestGuard.reject(method, headers);
    }

    @Test
    public void DroidLens_가_보낸_요청은_받는다() {
        assertNull(reject("GET", "Host: 127.0.0.1:54321", "X-DroidLens: 1"));
        assertNull(reject("POST", "host: localhost:8080", "x-droidlens: 1", "Content-Length: 3"));
        assertNull(reject("GET", "HOST: LocalHost", "X-DROIDLENS:1"));
    }

    @Test
    public void Host_가_없거나_로컬이_아니면_거부한다() {
        assertNotNull(reject("GET", "X-DroidLens: 1"));
        assertNotNull(reject("GET", "Host: evil.example:54321", "X-DroidLens: 1"));
        assertNotNull(reject("GET", "Host: 127.0.0.1.evil.example", "X-DroidLens: 1"));
        assertNotNull(reject("GET", "Host: localhost.evil.example:80", "X-DroidLens: 1"));
        // Host 가 둘이면 하나라도 로컬이 아닐 때 거부
        assertNotNull(reject("GET", "Host: 127.0.0.1:1", "Host: evil.example", "X-DroidLens: 1"));
    }

    @Test
    public void Origin_이_있으면_거부한다() {
        assertNotNull(reject("POST", "Host: 127.0.0.1:1", "Origin: https://evil.example", "X-DroidLens: 1"));
        assertNotNull(reject("POST", "Host: 127.0.0.1:1", "origin: null", "X-DroidLens: 1"));
    }

    @Test
    public void 표시_헤더가_없거나_값이_다르면_거부하고_올리라고_알린다() {
        String why = reject("GET", "Host: 127.0.0.1:1");
        assertNotNull(why);
        assertTrue(why, why.contains("최신 버전"));
        assertNotNull(reject("GET", "Host: 127.0.0.1:1", "X-DroidLens: 0"));
        assertNotNull(reject("GET", "Host: 127.0.0.1:1", "X-DroidLens-Other: 1"));
    }

    @Test
    public void OPTIONS_는_헤더가_맞아도_거부한다() {
        assertNotNull(reject("OPTIONS", "Host: 127.0.0.1:1", "X-DroidLens: 1"));
        assertNotNull(reject("options", "Host: 127.0.0.1:1", "X-DroidLens: 1"));
    }

    @Test
    public void isLocalHost_포트와_대소문자() {
        assertTrue(RequestGuard.isLocalHost("127.0.0.1"));
        assertTrue(RequestGuard.isLocalHost("127.0.0.1:65535"));
        assertTrue(RequestGuard.isLocalHost("LOCALHOST:1"));
        assertFalse(RequestGuard.isLocalHost("127.0.0.1:"));
        assertFalse(RequestGuard.isLocalHost("127.0.0.1:8080x"));
        assertFalse(RequestGuard.isLocalHost("127.0.0.2"));
        assertFalse(RequestGuard.isLocalHost("[::1]:80"));
        assertFalse(RequestGuard.isLocalHost(""));
        assertEquals("X-DroidLens", RequestGuard.HEADER);
    }
}
