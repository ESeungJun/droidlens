package io.github.eseungjun.droidlens.sdk;

import android.util.Log;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import io.github.eseungjun.droidlens.sdk.internal.MockStore;
import io.github.eseungjun.droidlens.sdk.internal.NetworkStore;
import io.github.eseungjun.droidlens.sdk.internal.Redactor;
import okhttp3.FormBody;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSink;
import okio.BufferedSource;
import okio.ForwardingSink;
import okio.ForwardingSource;
import okio.Okio;

/**
 * OkHttp 네트워크 인스펙터.
 * <pre>
 * OkHttpClient.Builder()
 *     .addInterceptor(공통파라미터Interceptor())   // 앱 인터셉터를 먼저
 *     .addInterceptor(DroidLensInterceptor())      // 마지막에 두기를 권장
 *     .build()
 * </pre>
 * 요청·응답 헤더와 본문(각 최대 {@link #maxBodyBytes}, 바이너리는 더 작게), 상태 코드, 소요 시간, 실패 원인을 기록한다.
 * 요청 본문은 다시 써도 부작용이 없는 것만 미리 복사하고, 나머지는 실제 전송 때 흘러가는 바이트의 앞부분만 복사한다
 * (기준은 {@link #isReplayable}). 뒤쪽 인터셉터는 대부분 원래 요청을 그대로 받지만, 감싸는 경우에는 본문 타입이 바뀌므로
 * 마지막에 addInterceptor 하는 것을 권장한다.
 * 응답 본문도 앱이 읽는 만큼만 복사하고, 다 읽거나 닫을 때 기록을 마친다 (스트리밍·롱폴링 응답을 막지 않는다).
 * 인증 헤더·토큰 같은 민감 정보는 저장하기 전에 가린다 ({@link DroidLens#redactHeaders}, {@link DroidLens#redactKeys}).
 * DroidLens 에서 켠 네트워크 목 규칙({@link MockStore})과 맞는 요청은 서버에 보내지 않고 정해 둔 응답·실패로 끝내거나 늦춰 보낸다.
 */
public final class DroidLensInterceptor implements Interceptor {
    private final long maxBodyBytes;

    public DroidLensInterceptor() {
        this(256 * 1024);
    }

    public DroidLensInterceptor(long maxBodyBytes) {
        this.maxBodyBytes = maxBodyBytes;
    }

    @Override
    public Response intercept(Chain chain) throws IOException {
        Request request = chain.request();
        // 서버가 없는 프로세스(provider 가 뜨지 않는 :remote 같은 보조 프로세스 등)에서는 아무도 읽지 않으니 쌓지 않는다
        if (!DroidLens.isRunning()) return chain.proceed(request);
        Redactor redact = Redactor.get();
        NetworkStore.Entry e;
        // 기록 준비는 어떤 이유로 실패해도(오래된 OkHttp 의 NoSuchMethodError 포함) 앱 요청을 그대로 보낸다
        try {
            e = NetworkStore.get().begin(request.method(), redact.url(request.url().toString()));
        } catch (Throwable ignored) {
            return chain.proceed(request);
        }
        MockStore.Rule mock = null;
        try {
            mock = MockStore.get().match(request.method(), request.url().toString());
            if (mock != null) e.mockId = mock.id;
        } catch (Throwable ignored) {
            // 목 확인에 실패하면 실제로 보낸다
        }
        TeeRequestBody tee = null;
        try {
            e.requestHeaders = redact.headers(request.headers().toMultimap());
            RequestBody body = request.body();
            if (body != null) {
                MediaType ct = body.contentType();
                e.requestContentType = ct != null ? ct.toString() : null;
                e.requestSize = body.contentLength();
                // duplex 본문은 응답과 동시에 계속 쓰이므로 기록하지 않는다
                if (!isDuplex(body) && !compressed(request.header("Content-Encoding"))) {
                    long limit = NetworkStore.captureLimit(e.requestContentType, e.requestSize, maxBodyBytes);
                    if (isReplayable(body)) {
                        // 요청 객체는 그대로 넘긴다. 뒤 인터셉터가 FormBody·MultipartBody 로 형변환해도 깨지지 않는다
                        copyRequestBody(e, body, limit, redact);
                    } else if (!(body instanceof MultipartBody) && !(body instanceof FormBody)) {
                        // 한 번만 쓸 수 있거나 크기를 모르는 본문은 전송 때 흐르는 바이트를 복사한다.
                        // 이때 뒤 인터셉터에는 TeeRequestBody 가 보이므로 원래 타입으로 instanceof·형변환할 수 없다
                        TeeRequestBody t = new TeeRequestBody(body, limit);
                        request = request.newBuilder().method(request.method(), t).build();
                        tee = t;
                    }
                    // 파일·스트림 part 가 섞인 multipart 와 {@link #PRECOPY_MAX} 를 넘는 폼은 미리 쓰지도 감싸지도 않는다 (형변환하는 인터셉터가 흔하다).
                    // 형식·크기만 기록하고 본문은 비워 둔다
                }
            }
        } catch (Throwable ignored) {
            // 본문 없이 기록만 하고 요청은 원래대로 보낸다
        }

        long t0 = System.nanoTime();
        Response response;
        try {
            response = mock != null ? mocked(chain, request, mock) : chain.proceed(request);
        } catch (Throwable ex) {
            // IOException 뿐 아니라 RuntimeException 으로 끝나도 항목이 pending 으로 남지 않게 한다
            try {
                recordRequestBody(e, tee, redact);
                NetworkStore.get().fail(e, (System.nanoTime() - t0) / 1_000_000, redact.text(ex.toString()));
            } catch (Throwable ignored) {
                // 기록 실패가 원래 예외를 가리지 않도록 무시
            }
            throw ex;
        }
        long tookMs = (System.nanoTime() - t0) / 1_000_000;
        try {
            recordRequestBody(e, tee, redact);
            e.status = response.code();
            e.message = response.message();
            e.protocol = response.protocol().toString();
            e.responseHeaders = redact.headers(response.headers().toMultimap());
            ResponseBody original = response.body();
            if (original != null) {
                MediaType ct = original.contentType();
                e.responseContentType = ct != null ? ct.toString() : null;
                e.responseSize = original.contentLength();
                // 앱이 Accept-Encoding 을 직접 지정해 압축된 채 받은 본문은 가릴 수 없고,
                // SSE 는 끝나지 않는 스트림이며 101 은 웹소켓 업그레이드라 본문을 감싸지 않는다
                if (!compressed(response.header("Content-Encoding")) && !isEventStream(e.responseContentType) && response.code() != 101) {
                    long limit = NetworkStore.captureLimit(e.responseContentType, e.responseSize, maxBodyBytes);
                    CapturingSource src = new CapturingSource(original.source(), e, limit, redact);
                    response = response.newBuilder()
                            .body(ResponseBody.create(ct, original.contentLength(), Okio.buffer(src)))
                            .build();
                }
            }
        } catch (Throwable ignored) {
            // 본문 기록 실패는 무시
        }
        NetworkStore.get().finish(e, tookMs);
        return response;
    }

    /**
     * 목 규칙대로 늦추고, 실패시키거나 만든 응답을 돌려준다. 응답을 만들지 않는 규칙이면 늦춘 뒤 실제로 보낸다.
     * 지연이 앱의 readTimeout 보다 길면 실제 서버가 느릴 때처럼 그 시간 뒤 SocketTimeoutException 으로 끝낸다
     */
    private static Response mocked(Chain chain, Request request, MockStore.Rule mock) throws IOException {
        // addNetworkInterceptor 로 달린 경우 proceed 를 꼭 한 번 불러야 해서(안 부르면 OkHttp 가 예외) 응답 목은 할 수 없다
        if (mock.status != 0 && isNetworkInterceptor(chain)) {
            Log.w(DroidLens.TAG, "DroidLensInterceptor 가 addNetworkInterceptor 로 달려 있어 응답 목을 건너뜁니다. addInterceptor 로 다세요");
            return chain.proceed(request);
        }
        long timeout = readTimeoutMillis(chain);
        boolean timesOut = timeout > 0 && mock.delayMs > timeout;
        long until = System.currentTimeMillis() + (timesOut ? timeout : mock.delayMs);
        while (System.currentTimeMillis() < until) {
            if (isCanceled(chain)) throw new IOException("Canceled");
            try {
                Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis())));
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", ie);
            }
        }
        if (timesOut) throw new SocketTimeoutException("timeout (DroidLens 네트워크 목: 지연 " + mock.delayMs + "ms > readTimeout " + timeout + "ms)");
        if (mock.fail) throw new IOException("DroidLens 네트워크 목: 연결 실패 (규칙 " + mock.id + ")");
        if (mock.status == 0) return chain.proceed(request);
        try {
            return mockResponse(request, mock);
        } catch (RuntimeException e) {
            // 저장할 때 검사하지만, 응답을 만들다 실패해도 앱이 죽지 않고 요청 실패로 처리하게 한다
            throw new IOException("DroidLens 네트워크 목: 응답을 만들지 못했습니다 (규칙 " + mock.id + ")", e);
        }
    }

    private static Response mockResponse(Request request, MockStore.Rule mock) {
        String type = mock.contentType != null ? mock.contentType : "application/json; charset=utf-8";
        byte[] bytes = mock.body != null ? mock.body.getBytes(StandardCharsets.UTF_8) : new byte[0];
        long now = System.currentTimeMillis();
        Response.Builder b = new Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(mock.status)
                .message("DroidLens Mock")
                .sentRequestAtMillis(now)
                .receivedResponseAtMillis(now)
                .header("Content-Type", type)
                .header("X-DroidLens-Mock", mock.id)
                .body(ResponseBody.create(MediaType.parse(type), bytes));
        for (Map.Entry<String, String> h : mock.headers.entrySet()) b.header(h.getKey(), h.getValue());
        return b.build();
    }

    /** 네트워크 인터셉터에는 연결이 있다 (애플리케이션 인터셉터는 null) */
    private static boolean isNetworkInterceptor(Chain chain) {
        try {
            return chain.connection() != null;
        } catch (LinkageError e) {
            return false;
        }
    }

    /** Chain.readTimeoutMillis 는 OkHttp 3.9 에 생겼다. 모르면 0 (타임아웃을 흉내 내지 않음) */
    private static long readTimeoutMillis(Chain chain) {
        try {
            return chain.readTimeoutMillis();
        } catch (LinkageError e) {
            return 0;
        }
    }

    /** Chain.call 은 OkHttp 3.9 에 생겼다. 그보다 오래된 버전은 취소를 확인하지 못한다 */
    private static boolean isCanceled(Chain chain) {
        try {
            return chain.call().isCanceled();
        } catch (LinkageError e) {
            return false;
        }
    }

    /** 미리 써서 복사할 본문의 최대 크기. 이보다 크면 메모리에 한 번 더 올리지 않는다 */
    private static final long PRECOPY_MAX = 1024 * 1024;

    /**
     * 요청을 보내기 전에 Buffer 에 한 번 더 써도 되는 본문인지.
     * <ul>
     * <li>FormBody: 필드가 이미 메모리에 있다 (그래도 크기 상한은 지킨다)</li>
     * <li>OkHttp 의 RequestBody.create(String·byte[]·ByteString·File) 로 만든 본문: 몇 번을 써도 같은 바이트가 나온다.
     *     클래스가 okhttp3.RequestBody 안에 있는 것으로 구분한다. 앱이 만든 본문은 크기를 알아도 진행률 콜백·스트림일 수 있어 제외</li>
     * <li>MultipartBody: 모든 part 가 위 조건을 만족할 때만</li>
     * </ul>
     * 크기를 모르거나 {@link #PRECOPY_MAX} 를 넘거나 oneShot 이면 미리 쓰지 않는다 (스트림 소비·큰 파일 OOM 방지).
     * 앱이 OkHttp 를 난독화해 클래스 이름이 바뀌었으면 안전한 쪽(감싸기)으로 떨어진다.
     */
    private static boolean isReplayable(RequestBody body) throws IOException {
        long length = body.contentLength();
        if (length < 0 || length > PRECOPY_MAX) return false;
        if (body instanceof FormBody) return true;
        if (isOneShot(body)) return false;
        if (body instanceof MultipartBody) {
            for (MultipartBody.Part part : ((MultipartBody) body).parts()) {
                if (!isReplayable(part.body())) return false;
            }
            return true;
        }
        return body.getClass().getName().startsWith("okhttp3.RequestBody$");
    }

    /** 다시 써도 되는 본문을 Buffer 에 써서 앞 limit 바이트를 기록한다 */
    private static void copyRequestBody(NetworkStore.Entry e, RequestBody body, long limit, Redactor redact) throws IOException {
        Buffer buf = new Buffer();
        body.writeTo(buf);
        long size = buf.size();
        byte[] raw = buf.readByteArray(Math.min(size, Math.max(0, limit)));
        NetworkStore.get().setRequestBody(e, redact.body(raw, e.requestContentType), size, size > raw.length);
    }

    /** RequestBody.isOneShot 은 OkHttp 3.14 에 생겼다. 그보다 오래된 버전은 false */
    private static boolean isOneShot(RequestBody body) {
        try {
            return body.isOneShot();
        } catch (LinkageError e) {
            return false;
        }
    }

    /** RequestBody.isDuplex 는 OkHttp 3.14 에 생겼다. 그보다 오래된 버전에는 duplex 가 없으니 false */
    private static boolean isDuplex(RequestBody body) {
        try {
            return body.isDuplex();
        } catch (LinkageError e) {
            return false;
        }
    }

    /** 전송이 끝난 뒤 복사해 둔 요청 본문을 기록한다. 본문이 쓰이지 않았으면(캐시 응답·전송 전 실패) 비워 둔다 */
    private static void recordRequestBody(NetworkStore.Entry e, TeeRequestBody tee, Redactor redact) {
        if (tee == null || tee.written < 0) return;
        try {
            byte[] raw = tee.captured.readByteArray();
            NetworkStore.get().setRequestBody(e, redact.body(raw, e.requestContentType), tee.written, tee.written > raw.length);
        } catch (Throwable ignored) {
            // 본문 기록 실패는 무시
        }
    }

    private static boolean isEventStream(String contentType) {
        return contentType != null && contentType.toLowerCase().startsWith("text/event-stream");
    }

    private static boolean compressed(String encoding) {
        return encoding != null && !encoding.isEmpty() && !"identity".equalsIgnoreCase(encoding);
    }

    /**
     * 원래 본문을 그대로 위임하면서, 실제로 쓰이는 바이트 중 앞 limit 바이트만 복사해 둔다.
     * 재시도·리다이렉트로 다시 쓰이면 마지막 전송 기준으로 새로 복사한다.
     */
    private static final class TeeRequestBody extends RequestBody {
        private final RequestBody delegate;
        private final long limit;
        final Buffer captured = new Buffer();
        /** 실제로 쓴 바이트 수. writeTo 가 불리지 않았으면 -1 */
        long written = -1;

        TeeRequestBody(RequestBody delegate, long limit) {
            this.delegate = delegate;
            this.limit = limit;
        }

        @Override
        public MediaType contentType() {
            return delegate.contentType();
        }

        @Override
        public long contentLength() throws IOException {
            return delegate.contentLength();
        }

        // isOneShot·isDuplex 는 OkHttp 3.14+ 에서만 불린다 (그 전 버전엔 메서드가 없어 호출되지 않음)
        @Override
        public boolean isOneShot() {
            return delegate.isOneShot();
        }

        @Override
        public boolean isDuplex() {
            return delegate.isDuplex();
        }

        @Override
        public void writeTo(BufferedSink sink) throws IOException {
            captured.clear();
            written = 0;
            BufferedSink out = Okio.buffer(new ForwardingSink(sink) {
                @Override
                public void write(Buffer source, long byteCount) throws IOException {
                    try {
                        long n = Math.min(byteCount, limit - captured.size());
                        if (n > 0) source.copyTo(captured, 0, n);
                        written += byteCount;
                    } catch (Throwable ignored) {
                        // 복사 실패가 전송을 막지 않도록 무시
                    }
                    super.write(source, byteCount);
                }
            });
            delegate.writeTo(out);
            // 닫지 않고 남은 바이트만 원래 sink 로 넘긴다 (닫기는 OkHttp 가 원래 sink 에 한다)
            out.emit();
        }
    }

    /**
     * 앱이 응답 본문을 읽을 때 지나가는 바이트 중 앞 limit 바이트만 복사한다.
     * 끝(EOF)에 닿거나 닫히면 그때까지 읽은 만큼으로 기록을 마친다.
     */
    private static final class CapturingSource extends ForwardingSource {
        private final NetworkStore.Entry entry;
        private final long limit;
        private final Redactor redact;
        private final Buffer captured = new Buffer();
        private long read;
        private boolean done;

        CapturingSource(BufferedSource delegate, NetworkStore.Entry entry, long limit, Redactor redact) {
            super(delegate);
            this.entry = entry;
            this.limit = limit;
            this.redact = redact;
        }

        @Override
        public long read(Buffer sink, long byteCount) throws IOException {
            long n = super.read(sink, byteCount);
            if (n < 0) {
                complete(true);
                return n;
            }
            try {
                long copy = Math.min(n, limit - captured.size());
                if (copy > 0) sink.copyTo(captured, sink.size() - n, copy);
                read += n;
            } catch (Throwable ignored) {
                // 복사 실패가 앱의 읽기를 막지 않도록 무시
            }
            return n;
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                complete(false);
            }
        }

        private void complete(boolean eof) {
            if (done) return;
            done = true;
            try {
                byte[] raw = captured.readByteArray();
                // 길이를 모르는 응답은 실제로 읽은 만큼을 크기로 쓰고, 끝까지 읽지 않고 닫았으면 잘린 것으로 본다
                long size = entry.responseSize;
                boolean truncated = size >= 0 ? size > raw.length : !eof || read > raw.length;
                NetworkStore.get().setResponseBody(entry, redact.body(raw, entry.responseContentType), size >= 0 ? size : read, truncated);
            } catch (Throwable ignored) {
                // 본문 기록 실패는 무시
            }
        }
    }
}
