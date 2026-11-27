package io.github.eseungjun.droidlens.agent;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** 활성 창 덤프에 같은 앱의 포커스 없는 팝업 창을 붙이는 규칙 (#127) */
public class PopupWindowsTest {
    private static final int APP = PopupWindows.TYPE_APPLICATION;
    private static final int IME = 2;
    private static final int SYSTEM = 3;

    private static PopupWindows.Win w(int type, boolean active, String pkg) {
        return new PopupWindows.Win(type, active, pkg);
    }

    @Test
    public void 활성_창_위에_있는_같은_앱_팝업을_아래에서_위_순서로_붙인다() {
        // getWindows 는 위 창부터: 상태 표시줄, 키보드, 같은 앱 팝업, 활성 창, 아래 앱
        List<PopupWindows.Win> ws = Arrays.asList(
                w(SYSTEM, false, "com.android.systemui"),
                w(IME, false, "com.example.keyboard"),
                w(APP, false, "com.example.app"),
                w(APP, false, "com.example.app"),
                w(APP, true, "com.example.app"),
                w(APP, false, "com.example.launcher"));
        assertEquals(Arrays.asList(4, 3, 2), PopupWindows.pick(ws));
    }

    @Test
    public void 다른_앱의_창과_활성_창_아래의_창은_붙이지_않는다() {
        List<PopupWindows.Win> ws = Arrays.asList(
                w(APP, false, "com.other.app"),
                w(APP, true, "com.example.app"),
                w(APP, false, "com.example.app"));
        assertEquals(Collections.singletonList(1), PopupWindows.pick(ws));
    }

    @Test
    public void 활성_창을_못_찾으면_빈_목록() {
        assertEquals(Collections.emptyList(), PopupWindows.pick(Arrays.asList(w(APP, false, "a"))));
        assertEquals(Collections.emptyList(), PopupWindows.pick(Arrays.asList(w(APP, true, null))));
    }
}
