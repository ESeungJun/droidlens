package io.github.eseungjun.droidlens.sdk.internal;

/**
 * adb forward 로 열린 호스트 포트(127.0.0.1:N)로 들어온 요청이 DroidLens 가 보낸 것인지 헤더로 가린다.
 * 접속 UID 검사는 forward 를 거친 연결을 전부 shell 로 보므로, 브라우저에 열린 웹 페이지가 보낸 요청을 여기서 막는다.
 * android 클래스를 쓰지 않는다 (JVM 단위 테스트 대상).
 */
final class RequestGuard {
    /** DroidLens 데스크톱·MCP 가 모든 요청에 붙이는 헤더. 브라우저는 사전 요청(OPTIONS) 없이는 붙일 수 없다 */
    static final String HEADER = "X-DroidLens";

    private RequestGuard() {}

    /**
     * 거부할 이유. 받아도 되면 null.
     *
     * @param method 요청 메서드
     * @param headerLines 요청 줄을 뺀 헤더 줄들 ("이름: 값")
     */
    static String reject(String method, String[] headerLines) {
        // 사전 요청에 답하지 않아야 브라우저가 커스텀 헤더를 붙인 요청을 보내지 못한다
        if ("OPTIONS".equalsIgnoreCase(method)) return "OPTIONS 요청은 받지 않습니다";
        boolean host = false;
        boolean marker = false;
        for (String line : headerLines) {
            int idx = line.indexOf(':');
            if (idx <= 0) continue;
            String name = line.substring(0, idx).trim();
            String value = line.substring(idx + 1).trim();
            if (name.equalsIgnoreCase("host")) {
                // DNS 리바인딩: 다른 이름으로 127.0.0.1 에 닿은 요청은 Host 가 그 이름이다
                if (!isLocalHost(value)) return "Host 가 127.0.0.1·localhost 가 아닙니다";
                host = true;
            } else if (name.equalsIgnoreCase("origin")) {
                return "브라우저에서 온 요청(Origin 헤더)은 받지 않습니다";
            } else if (name.equalsIgnoreCase(HEADER)) {
                if (value.equals("1")) marker = true;
            }
        }
        if (!host) return "Host 헤더가 없습니다";
        if (!marker) return HEADER + ": 1 헤더가 없습니다. DroidLens 데스크톱·MCP 를 최신 버전으로 올리세요";
        return null;
    }

    /** 127.0.0.1 또는 localhost (포트는 있어도 없어도 된다, 대소문자 무시) */
    static boolean isLocalHost(String value) {
        String h = value.toLowerCase(java.util.Locale.ROOT);
        int colon = h.lastIndexOf(':');
        if (colon >= 0) {
            String port = h.substring(colon + 1);
            if (port.isEmpty() || port.length() > 5) return false;
            for (int i = 0; i < port.length(); i++) if (port.charAt(i) < '0' || port.charAt(i) > '9') return false;
            h = h.substring(0, colon);
        }
        return h.equals("127.0.0.1") || h.equals("localhost");
    }
}
