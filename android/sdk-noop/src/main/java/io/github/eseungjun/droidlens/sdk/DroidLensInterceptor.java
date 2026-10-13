package io.github.eseungjun.droidlens.sdk;

import java.io.IOException;

import okhttp3.Interceptor;
import okhttp3.Response;

/** release 빌드용: 요청을 그대로 통과시킨다 */
public final class DroidLensInterceptor implements Interceptor {
    public DroidLensInterceptor() {}

    public DroidLensInterceptor(long maxBodyBytes) {}

    @Override
    public Response intercept(Chain chain) throws IOException {
        return chain.proceed(chain.request());
    }
}
