package io.github.eseungjun.droidlens.sample;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 웹뷰 검증 확인용 화면 (#132): 앱 안 HTML 을 띄운다. 본문 글자를 접근성 덤프로 읽는지,
 * 웹뷰 디버깅(CDP)으로 콘솔 오류·요청을 보는지 확인한다. 페이지는 일부러 콘솔 오류와 실패하는 요청을 낸다.
 */
public class WebActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("웹뷰 샘플");
        WebView web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        web.loadUrl("file:///android_asset/web/index.html");
    }
}
