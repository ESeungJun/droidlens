package io.github.eseungjun.droidlens.sdk.internal;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.Locale;

/**
 * 앱의 SQLite/Room DB 브라우저. 앱과 같은 프로세스에서 별도 연결을 열어 조회한다.
 * SQLite 파일 락 덕분에 앱의 연결과 동시에 열어도 데이터가 깨지지는 않는다. 다만 WAL 은 앱이 켰을 때만이고
 * (Room 은 기본으로 켬, 직접 만든 SQLiteOpenHelper 는 기본이 롤백 저널), 롤백 저널 DB 에서는 조회하는 동안
 * 앱의 쓰기가 기다리거나 SQLITE_BUSY 로 실패할 수 있다. 그래서 조회는 필요한 행만 읽고 바로 닫는다.
 * 쓰기 SQL은 write=true일 때만 허용.
 */
final class DbPlugin {
    private static final int MAX_ROWS = 500;
    private final Context context;

    DbPlugin(Context context) {
        this.context = context;
    }

    /** counts=false 면 테이블마다 COUNT(*) 를 하지 않는다 (큰 DB 에서 목록을 빨리 받고 싶을 때) */
    JSONObject list(boolean counts) throws JSONException {
        JSONArray dbs = new JSONArray();
        for (String name : context.databaseList()) {
            if (name.endsWith("-journal") || name.endsWith("-wal") || name.endsWith("-shm")) continue;
            File f = context.getDatabasePath(name);
            JSONObject db = new JSONObject().put("name", name).put("path", f.getAbsolutePath()).put("size", f.length());
            JSONArray tables = new JSONArray();
            SQLiteDatabase d = null;
            try {
                d = open(name, false);
                try (Cursor c = d.rawQuery("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('android_metadata','room_master_table') ORDER BY name", null)) {
                    while (c.moveToNext()) {
                        String t = c.getString(0);
                        JSONObject tbl = new JSONObject().put("name", t).put("type", c.getString(1));
                        tbl.put("columns", columns(d, t));
                        // 기존 응답과 같게 기본은 센다. 큰 DB 라 목록만 빨리 받고 싶으면 호스트가 counts=0 을 보낸다
                        if (counts) {
                            try (Cursor cnt = d.rawQuery("SELECT COUNT(*) FROM " + quote(t), null)) {
                                if (cnt.moveToFirst()) tbl.put("rowCount", cnt.getLong(0));
                            } catch (Exception ignored) {
                                // 카운트 실패는 무시
                            }
                        }
                        tables.put(tbl);
                    }
                }
            } catch (Exception e) {
                db.put("error", e.toString());
            } finally {
                if (d != null) d.close();
            }
            dbs.put(db.put("tables", tables));
        }
        return new JSONObject().put("databases", dbs);
    }

    private static JSONArray columns(SQLiteDatabase d, String table) throws JSONException {
        JSONArray cols = new JSONArray();
        try (Cursor c = d.rawQuery("PRAGMA table_info(" + quote(table) + ")", null)) {
            while (c.moveToNext()) {
                cols.put(new JSONObject()
                        .put("name", c.getString(c.getColumnIndexOrThrow("name")))
                        .put("type", c.getString(c.getColumnIndexOrThrow("type")))
                        .put("pk", c.getInt(c.getColumnIndexOrThrow("pk")) > 0)
                        .put("notNull", c.getInt(c.getColumnIndexOrThrow("notnull")) > 0));
            }
        }
        return cols;
    }

    JSONObject query(String dbName, String sql, boolean write) throws JSONException {
        String trimmed = sql.trim();
        String head = trimmed.split("\\s+", 2)[0].toUpperCase(Locale.ROOT);
        boolean isRead = head.equals("SELECT") || head.equals("PRAGMA") || head.equals("WITH") || head.equals("EXPLAIN");
        if (!isRead && !write) throw new IllegalArgumentException("쓰기 SQL은 write=true가 필요합니다: " + head);
        SQLiteDatabase d = open(dbName, !isRead);
        try {
            if (!isRead) {
                d.execSQL(trimmed);
                long changes = 0;
                try (Cursor c = d.rawQuery("SELECT changes()", null)) {
                    if (c.moveToFirst()) changes = c.getLong(0);
                }
                // 별도 연결로 썼기 때문에 앱 쪽 Room 의 무효화 추적(Flow·LiveData)은 알지 못한다
                return new JSONObject().put("changes", changes)
                        .put("note", "DroidLens 의 별도 연결로 썼기 때문에 Room Flow·LiveData 는 자동으로 갱신되지 않습니다. 화면에 반영하려면 앱에서 다시 조회하거나 앱을 다시 시작하세요");
            }
            try (Cursor c = d.rawQuery(trimmed, null)) {
                JSONArray cols = new JSONArray();
                for (String n : c.getColumnNames()) cols.put(n);
                JSONArray rows = new JSONArray();
                // 전체 행 수를 세려고 끝까지 훑으면 큰 테이블에서 읽기 락을 오래 잡는다. MAX_ROWS+1 행에서 멈춘다
                int total = 0;
                while (total <= MAX_ROWS && c.moveToNext()) {
                    total++;
                    if (rows.length() >= MAX_ROWS) continue;
                    JSONArray row = new JSONArray();
                    for (int i = 0; i < c.getColumnCount(); i++) row.put(cell(c, i));
                    rows.put(row);
                }
                boolean truncated = total > MAX_ROWS;
                // truncated 면 total 은 정확한 수가 아니라 "MAX_ROWS 보다 많음"(MAX_ROWS+1)이다
                return new JSONObject().put("columns", cols).put("rows", rows).put("total", total)
                        .put("truncated", truncated).put("totalExact", !truncated);
            }
        } finally {
            d.close();
        }
    }

    private static Object cell(Cursor c, int i) {
        switch (c.getType(i)) {
            case Cursor.FIELD_TYPE_NULL: return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER: return c.getLong(i);
            case Cursor.FIELD_TYPE_FLOAT: return c.getDouble(i);
            case Cursor.FIELD_TYPE_BLOB: {
                byte[] b = c.getBlob(i);
                return "blob:" + b.length + "B " + Base64.encodeToString(b, 0, Math.min(b.length, 48), Base64.NO_WRAP);
            }
            default: return c.getString(i);
        }
    }

    private SQLiteDatabase open(String name, boolean writable) {
        File f = context.getDatabasePath(name);
        if (!f.exists()) throw new IllegalArgumentException("DB가 없습니다: " + name);
        int flags = (writable ? SQLiteDatabase.OPEN_READWRITE : SQLiteDatabase.OPEN_READONLY) | SQLiteDatabase.NO_LOCALIZED_COLLATORS;
        return SQLiteDatabase.openDatabase(f.getAbsolutePath(), null, flags);
    }

    private static String quote(String ident) {
        return "\"" + ident.replace("\"", "\"\"") + "\"";
    }
}
