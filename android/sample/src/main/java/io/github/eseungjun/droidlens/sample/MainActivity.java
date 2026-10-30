package io.github.eseungjun.droidlens.sample;

import android.app.Activity;
import android.content.ContentValues;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.IOException;

import io.github.eseungjun.droidlens.sdk.DroidLens;
import io.github.eseungjun.droidlens.sdk.DroidLensInterceptor;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;
import okio.BufferedSource;

/** SDK 동작 확인용 샘플: 네트워크 요청, SQLite, SharedPreferences, 커스텀 이벤트 */
public class MainActivity extends Activity {
    private final OkHttpClient http = new OkHttpClient.Builder().addInterceptor(new DroidLensInterceptor()).build();
    private TextView status;
    private SQLiteOpenHelper dbHelper;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dbHelper = new SQLiteOpenHelper(this, "sample.db", null, 1) {
            @Override
            public void onCreate(SQLiteDatabase db) {
                db.execSQL("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at INTEGER)");
            }

            @Override
            public void onUpgrade(SQLiteDatabase db, int o, int n) {}
        };

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 96, 48, 48);
        status = new TextView(this);
        status.setText("SDK " + DroidLens.version() + " running: " + DroidLens.isRunning());
        root.addView(status);
        root.addView(button("GET 요청", "btn_get", () -> get("https://jsonplaceholder.typicode.com/todos/1")));
        root.addView(button("POST 요청", "btn_post", this::post));
        root.addView(button("404 요청", "btn_404", () -> get("https://jsonplaceholder.typicode.com/does-not-exist")));
        // 에뮬레이터에 인터넷이 없을 때: adb reverse tcp:8099 tcp:8099 후 호스트에서 로컬 서버 실행
        root.addView(button("로컬 서버 요청", "btn_local", () -> get("http://127.0.0.1:8099/api/user?id=7")));
        // 한 번만 쓸 수 있는 스트림 본문 업로드와, 줄 단위로 천천히 오는 응답 (로컬 서버 /upload, /stream)
        root.addView(button("스트림 업로드", "btn_upload", this::upload));
        root.addView(button("스트리밍 응답", "btn_stream", this::stream));
        root.addView(button("DB에 메모 추가", "btn_db", this::insertNote));
        root.addView(button("Prefs 저장", "btn_prefs", this::savePrefs));
        root.addView(button("커스텀 이벤트", "btn_event", () -> {
            try {
                DroidLens.event("button_clicked", new JSONObject().put("screen", "main").put("count", 1));
            } catch (Exception ignored) {
            }
            status.setText("이벤트 기록됨");
        }));
        setContentView(root);
    }

    private Button button(String label, String tag, Runnable action) {
        Button b = new Button(this);
        b.setText(label);
        b.setContentDescription(tag);
        b.setOnClickListener(v -> action.run());
        return b;
    }

    private void get(String url) {
        enqueue(new Request.Builder().url(url).header("X-Sample", "droidlens").build());
    }

    private void post() {
        RequestBody body = RequestBody.create("{\"title\":\"안녕\",\"userId\":1}", MediaType.get("application/json; charset=utf-8"));
        enqueue(new Request.Builder().url("https://jsonplaceholder.typicode.com/posts").post(body).build());
    }

    /** 1MB 를 64KB 씩 만들어 보내는 일회용 본문. 인터셉터가 미리 써 보면 서버가 받는 크기가 줄어든다 */
    private void upload() {
        RequestBody body = new RequestBody() {
            private boolean used;

            @Override
            public MediaType contentType() {
                return MediaType.get("application/octet-stream");
            }

            @Override
            public boolean isOneShot() {
                return true;
            }

            @Override
            public void writeTo(BufferedSink sink) throws IOException {
                if (used) throw new IOException("이미 쓴 본문");
                used = true;
                byte[] chunk = new byte[64 * 1024];
                for (int i = 0; i < 16; i++) sink.write(chunk);
            }
        };
        enqueue(new Request.Builder().url("http://127.0.0.1:8099/upload").post(body).build());
    }

    /** 첫 줄이 도착하자마자 화면에 보이면 인터셉터가 응답을 막지 않는 것 */
    private void stream() {
        long t0 = System.currentTimeMillis();
        http.newCall(new Request.Builder().url("http://127.0.0.1:8099/stream").build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                runOnUiThread(() -> status.setText("실패: " + e.getMessage()));
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                try (BufferedSource src = response.body().source()) {
                    String line;
                    while ((line = src.readUtf8Line()) != null) {
                        String text = "stream +" + (System.currentTimeMillis() - t0) + "ms: " + line;
                        runOnUiThread(() -> status.setText(text));
                    }
                }
            }
        });
    }

    private void enqueue(Request req) {
        http.newCall(req).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                runOnUiThread(() -> status.setText("실패: " + e.getMessage()));
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                String text = response.body() != null ? response.body().string() : "";
                runOnUiThread(() -> status.setText(response.code() + " " + text.length() + "B"));
            }
        });
    }

    private void insertNote() {
        ContentValues v = new ContentValues();
        v.put("title", "메모 " + System.currentTimeMillis() % 1000);
        v.put("created_at", System.currentTimeMillis());
        long id = dbHelper.getWritableDatabase().insert("notes", null, v);
        status.setText("note #" + id);
    }

    private void savePrefs() {
        getSharedPreferences("settings", MODE_PRIVATE).edit()
                .putString("nickname", "냥이")
                .putInt("launch_count", getSharedPreferences("settings", MODE_PRIVATE).getInt("launch_count", 0) + 1)
                .putBoolean("dark_mode", true)
                .apply();
        status.setText("prefs 저장됨");
    }
}
