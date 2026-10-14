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

/**
 * OkHttp 네트워크 인스펙터.
 * <pre>
 * OkHttpClient.Builder().addInterceptor(DroidLensInterceptor()).build()
 * </pre>
 * 요청·응답 헤더와 본문(각 최대 {@link #maxBodyBytes}), 상태 코드, 소요 시간, 실패 원인을 기록한다.
 * 응답 본문은 peekBody로 읽어 앱의 원래 스트림을 소비하지 않는다.
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
        Redactor redact = Redactor.get();
        NetworkStore.Entry e = NetworkStore.get().begin(request.method(), redact.url(request.url().toString()));
        e.requestHeaders = redact.headers(request.headers().toMultimap());
        RequestBody body = request.body();
        if (body != null) {
            try {
                MediaType ct = body.contentType();
                e.requestContentType = ct != null ? ct.toString() : null;
                e.requestSize = body.contentLength();
                if (!body.isOneShot() && !body.isDuplex() && !compressed(request.header("Content-Encoding"))) {
                    Buffer buf = new Buffer();
                    body.writeTo(buf);
                    e.requestSize = buf.size();
                    e.requestBody = redact.body(buf.readByteArray(Math.min(buf.size(), maxBodyBytes)), e.requestContentType);
                    e.requestTruncated = e.requestSize > maxBodyBytes;
                }
            } catch (Exception ignored) {
                // 기록 실패가 앱 요청을 막지 않도록 무시
            }
        }

        long t0 = System.nanoTime();
        Response response;
        try {
            response = chain.proceed(request);
        } catch (IOException ex) {
            NetworkStore.get().fail(e, (System.nanoTime() - t0) / 1_000_000, redact.text(ex.toString()));
            throw ex;
        }
        long tookMs = (System.nanoTime() - t0) / 1_000_000;
        try {
            e.status = response.code();
            e.message = response.message();
            e.protocol = response.protocol().toString();
            e.responseHeaders = redact.headers(response.headers().toMultimap());
            ResponseBody peek = response.peekBody(maxBodyBytes);
            MediaType ct = peek.contentType();
            e.responseContentType = ct != null ? ct.toString() : null;
            // 앱이 Accept-Encoding 을 직접 지정해 압축된 채 받은 본문은 가릴 수 없으니 기록하지 않는다
            byte[] raw = compressed(response.header("Content-Encoding")) ? new byte[0] : peek.bytes();
            ResponseBody original = response.body();
            long len = original != null ? original.contentLength() : -1;
            e.responseSize = len >= 0 ? len : raw.length;
            e.responseBody = redact.body(raw, e.responseContentType);
            e.responseTruncated = e.responseSize > maxBodyBytes;
        } catch (Exception ignored) {
            // 본문 기록 실패는 무시
        }
        NetworkStore.get().finish(e, tookMs);
        return response;
    }

    private static boolean compressed(String encoding) {
        return encoding != null && !encoding.isEmpty() && !"identity".equalsIgnoreCase(encoding);
    }
}
