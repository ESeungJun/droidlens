package io.github.eseungjun.droidlens.sample;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 디자인 비교(design_compare) 시험 화면. 위치·크기는 시험용 합성 시안(360×640, packages/core/test/design.test.mjs)과 같다.
 * 인텐트 extra variant=changed 면 제목 색·글자 크기·문구·간격을 일부러 바꾸고 버튼 글자를 빼고 새 글자를 더한다.
 * 가격 글자 굵기(굵게 → 보통), 버튼 높이(48 → 56dp)·모서리(8 → 0dp)도 바꾼다 (#89):
 *   adb shell am start -n io.github.eseungjun.droidlens.sample/.DesignActivity --es variant changed
 */
public class DesignActivity extends Activity {
    private float density;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        boolean changed = "changed".equals(getIntent().getStringExtra("variant"));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(true);

        root.addView(text("설정", 20, Typeface.BOLD, changed ? 0xFF3366FF : 0xFF191919), at(20, 56, Gravity.START));
        root.addView(text("알림 받기", changed ? 17 : 15, Typeface.NORMAL, 0xFF191919), at(20, 120, Gravity.START));
        root.addView(text(changed ? "마케팅 소식을 받아요" : "마케팅 정보를 받아요", 13, Typeface.NORMAL, 0xFF888888), at(20, changed ? 155 : 145, Gravity.START));
        root.addView(text("9,900원", 15, changed ? Typeface.NORMAL : Typeface.BOLD, 0xFF191919), at(20, 120, Gravity.END));
        if (changed) root.addView(text("새 기능", 14, Typeface.NORMAL, 0xFF191919), at(20, 300, Gravity.END));

        FrameLayout button = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFFFF5A00);
        bg.setCornerRadius(changed ? 0 : dp(8));
        button.setBackground(bg);
        if (!changed) button.addView(text("저장하기", 16, Typeface.BOLD, Color.WHITE), new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, dp(changed ? 56 : 48));
        lp.setMargins(dp(20), dp(568), dp(20), 0);
        root.addView(button, lp);

        TextView home = text("홈", 11, Typeface.NORMAL, 0xFF999999);
        FrameLayout.LayoutParams tab = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL);
        tab.topMargin = dp(620);
        root.addView(home, tab);

        setContentView(root);
    }

    private int dp(float v) {
        return Math.round(v * density);
    }

    private TextView text(String s, float sp, int style, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(Typeface.DEFAULT, style);
        t.setTextColor(color);
        t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        return t;
    }

    /** 시안 좌표: 왼쪽(START)이면 왼쪽 여백, 오른쪽(END)이면 오른쪽 여백 */
    private FrameLayout.LayoutParams at(float x, float y, int side) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, side | Gravity.TOP);
        if (side == Gravity.END) lp.setMarginEnd(dp(x));
        else lp.setMarginStart(dp(x));
        lp.topMargin = dp(y);
        return lp;
    }
}
