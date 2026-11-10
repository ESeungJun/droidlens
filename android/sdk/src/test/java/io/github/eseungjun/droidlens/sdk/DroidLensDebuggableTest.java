package io.github.eseungjun.droidlens.sdk;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DroidLensDebuggableTest {
    /** ApplicationInfo.FLAG_DEBUGGABLE */
    private static final int DEBUGGABLE = 1 << 1;

    @Test
    public void 디버그_빌드에서만_켠다() {
        assertTrue(DroidLens.shouldStart(DEBUGGABLE, false));
        assertTrue(DroidLens.shouldStart(DEBUGGABLE | 1 | (1 << 23), false));
        assertFalse(DroidLens.shouldStart(0, false));
        // 다른 플래그(FLAG_SYSTEM, FLAG_HAS_CODE 등)만 켜진 release 앱
        assertFalse(DroidLens.shouldStart(1 | (1 << 2) | (1 << 23), false));
    }

    @Test
    public void 앱이_허용하면_디버그_빌드가_아니어도_켠다() {
        assertTrue(DroidLens.shouldStart(0, true));
        assertTrue(DroidLens.shouldStart(DEBUGGABLE, true));
    }
}
