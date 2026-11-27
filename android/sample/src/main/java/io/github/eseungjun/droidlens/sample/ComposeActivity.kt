package io.github.eseungjun.droidlens.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.app.DatePickerDialog
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Compose 화면 재현용: ModalNavigationDrawer(#126), 별도 창으로 뜨는 팝업(#127: DropdownMenu·ListPopupWindow·DatePickerDialog) */
class ComposeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { DrawerScreen() } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DrawerScreen() {
    val drawer = rememberDrawerState(androidx.compose.material3.DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var picked by remember { mutableStateOf("홈") }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Text("메뉴", modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium)
                for (item in listOf("홈", "알림", "설정")) {
                    NavigationDrawerItem(
                        label = { Text(item) },
                        selected = picked == item,
                        onClick = {
                            picked = item
                            scope.launch { drawer.close() }
                        },
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
            }
        },
    ) {
        Scaffold(topBar = { TopAppBar(title = { Text("Compose 화면") }) }) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).padding(16.dp)) {
                Text("지금 메뉴: $picked")
                Button(onClick = { scope.launch { drawer.open() } }) { Text("메뉴 열기") }
                PopupButtons(onPick = { picked = it })
            }
        }
    }
}

/** 별도 창 팝업 세 가지 (#127). 고른 값은 "지금 메뉴" 줄에 나온다 */
@Composable
private fun PopupButtons(onPick: (String) -> Unit) {
    val context = LocalContext.current
    val view = LocalView.current
    var menu by remember { mutableStateOf(false) }
    Box {
        Button(onClick = { menu = true }) { Text("정렬 메뉴") }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            for (item in listOf("최신순", "인기순")) {
                DropdownMenuItem(text = { Text(item) }, onClick = {
                    onPick(item)
                    menu = false
                })
            }
        }
    }
    Button(onClick = {
        // 포커스를 받지 않는 팝업 창 (검색 제안처럼 뒤 화면이 활성 창으로 남는다)
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFFEEEEEE.toInt())
        }
        val popup = PopupWindow(box, 600, LinearLayout.LayoutParams.WRAP_CONTENT, false)
        for (item in listOf("서울", "부산", "대구")) {
            box.addView(TextView(context).apply {
                text = item
                textSize = 20f
                setPadding(48, 36, 48, 36)
                setOnClickListener {
                    onPick(item)
                    popup.dismiss()
                }
            })
        }
        popup.isOutsideTouchable = true
        popup.showAtLocation(view, Gravity.CENTER, 0, 300)
    }) { Text("지역 제안") }
    Button(onClick = {
        DatePickerDialog(context, { _, y, m, d -> onPick("$y-${m + 1}-$d") }, 2026, 10, 27).show()
    }) { Text("날짜 선택") }
}
