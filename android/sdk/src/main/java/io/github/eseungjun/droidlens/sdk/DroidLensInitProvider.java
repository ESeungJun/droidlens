package io.github.eseungjun.droidlens.sdk;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;

/** 앱 프로세스 시작 시 자동 초기화 (LeakCanary와 같은 방식). 코드 추가 없이 의존성만으로 동작한다. */
public final class DroidLensInitProvider extends ContentProvider {
    @Override
    public boolean onCreate() {
        if (getContext() != null) DroidLens.init(getContext());
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
