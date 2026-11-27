package io.github.eseungjun.droidlens.agent;

import java.util.ArrayList;
import java.util.List;

/**
 * 활성 창 덤프에 붙일 창을 고른다 (#127).
 * 포커스를 받지 않는 팝업(PopupWindow·ListPopupWindow, 검색 제안 등)은 활성 창이 되지 않아
 * getRootInActiveWindow 에 안 나온다. 활성 창보다 위에 있는 같은 앱의 앱 창만 붙인다.
 * 키보드·시스템 창·다른 앱 창은 붙이지 않는다(다른 앱 글자가 섞이지 않게).
 * 안드로이드에 기대지 않는 순수 규칙이라 JVM 단위 시험으로 본다.
 */
final class PopupWindows {
    /** AccessibilityWindowInfo.TYPE_APPLICATION */
    static final int TYPE_APPLICATION = 1;

    static final class Win {
        final int type;
        final boolean active;
        final String pkg;

        Win(int type, boolean active, String pkg) {
            this.type = type;
            this.active = active;
            this.pkg = pkg;
        }
    }

    private PopupWindows() {}

    /**
     * @param windows getWindows() 순서(위 창부터)
     * @return 덤프할 창의 번호. 활성 창이 먼저, 그 위 같은 앱 팝업이 아래에서 위 순서. 활성 창을 모르면 빈 목록
     */
    static List<Integer> pick(List<Win> windows) {
        List<Integer> out = new ArrayList<>();
        int active = -1;
        for (int i = 0; i < windows.size(); i++) {
            if (windows.get(i).active) {
                active = i;
                break;
            }
        }
        if (active < 0 || windows.get(active).pkg == null) return out;
        String pkg = windows.get(active).pkg;
        out.add(active);
        for (int i = active - 1; i >= 0; i--) {
            Win w = windows.get(i);
            if (w.type == TYPE_APPLICATION && pkg.equals(w.pkg)) out.add(i);
        }
        return out;
    }
}
