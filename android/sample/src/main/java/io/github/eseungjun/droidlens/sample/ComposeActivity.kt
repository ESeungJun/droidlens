package io.github.eseungjun.droidlens.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Compose 화면 재현용 (#126): ModalNavigationDrawer 를 열고 닫는다 */
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
            }
        }
    }
}
