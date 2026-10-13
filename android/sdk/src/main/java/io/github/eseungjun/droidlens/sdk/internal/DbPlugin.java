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
 * 앱의 SQLite/Room DB 브라우저. 앱과 같은 프로세스에서 별도 연결을 열어 조회한다
 * (WAL 모드라 앱의 연결과 동시에 읽어도 안전). 쓰기 SQL은 write=true일 때만 허용.
 */
final class DbPlugin {
    private static final int MAX_ROWS = 500;
    private final Context context;

    DbPlugin(Context context) {
        this.context = context;
    }

    JSONObject list() throws JSONException {
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
                        try (Cursor cnt = d.rawQuery("SELECT COUNT(*) FROM " + quote(t), null)) {
                            if (cnt.moveToFirst()) tbl.put("rowCount", cnt.getLong(0));
                        } catch (Exception ignored) {
                            // 뷰 카운트 실패 등은 무시
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
                return new JSONObject().put("changes", changes);
            }
            try (Cursor c = d.rawQuery(trimmed, null)) {
                JSONArray cols = new JSONArray();
                for (String n : c.getColumnNames()) cols.put(n);
                JSONArray rows = new JSONArray();
                int total = 0;
                while (c.moveToNext()) {
                    total++;
                    if (rows.length() >= MAX_ROWS) continue;
                    JSONArray row = new JSONArray();
                    for (int i = 0; i < c.getColumnCount(); i++) row.put(cell(c, i));
                    rows.put(row);
                }
                return new JSONObject().put("columns", cols).put("rows", rows).put("total", total).put("truncated", total > MAX_ROWS);
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
