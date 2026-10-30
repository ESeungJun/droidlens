package io.github.eseungjun.droidlens.sdk;

import java.io.IOException;

import io.github.eseungjun.droidlens.sdk.internal.NetworkStore;
import io.github.eseungjun.droidlens.sdk.internal.Redactor;
import okhttp3.Interceptor;
import okhttp3.MediaType;
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
 * OkHttpClient.Builder().addInterceptor(DroidLensInterceptor()).build()
 * </pre>
 * 요청·응답 헤더와 본문(각 최대 {@link #maxBodyBytes}, 바이너리는 더 작게), 상태 코드, 소요 시간, 실패 원인을 기록한다.
 * 요청 본문은 미리 써 보지 않고 실제 전송 때 흘러가는 바이트의 앞부분만 복사한다 (writeTo 는 한 번만 불린다).
 * 응답 본문도 앱이 읽는 만큼만 복사하고, 다 읽거나 닫을 때 기록을 마친다 (스트리밍·롱폴링 응답을 막지 않는다).
 * 인증 헤더·토큰 같은 민감 정보는 저장하기 전에 가린다 ({@link DroidLens#redactHeaders}, {@link DroidLens#redactKeys}).
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
                    TeeRequestBody t = new TeeRequestBody(body, NetworkStore.captureLimit(e.requestContentType, e.requestSize, maxBodyBytes));
                    request = request.newBuilder().method(request.method(), t).build();
                    tee = t;
                }
            }
        } catch (Throwable ignored) {
            // 본문 없이 기록만 하고 요청은 원래대로 보낸다
        }

        long t0 = System.nanoTime();
        Response response;
        try {
            response = chain.proceed(request);
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
