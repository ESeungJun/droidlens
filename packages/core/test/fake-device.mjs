// 기기 없이 화면 지도·경로·탐색 코드를 시험하기 위한 가짜 기기 (테스트 도우미, *.test.mjs 가 아니라 단독으로 돌지 않는다).
// DeviceAdb 중 graph 가 쓰는 shell·execOut 만 흉내 낸다. 에이전트는 끈 상태(DROIDLENS_AGENT=0)를 전제로
// dumpsys window · uiautomator dump · screencap · input 명령에 답하고, 화면 이동은 아래 screens 정의를 따른다.
//
// screens: { 이름: { activity, pkg?, root?, buttons: [{ id, text?, desc?, bounds, cls?, enabled?, go?, long?, fail? }], swipe?: { left: 이름 }, backConsumes?, backThrows? } }
// - go: 누르면 갈 화면 이름 (없으면 그대로). '@back' 이면 뒤로 가기와 같다. 배열이면 차례로 쌓는다 (['앱 밖', '앱 안'] 이면 BACK 한 번에 앱 밖으로 나온다)
// - fail: 누르면 input tap 명령이 이 메시지로 실패한다 (화면은 그대로)
// - backConsumes: 그 화면에 들어온 뒤 BACK 을 이 횟수만큼 무시한다 (BACK 으로 못 돌아오는 화면)
// - backThrows: 그 화면에서 BACK(input keyevent 4)을 보내면 이 메시지로 실패한다
// - root: 루트 뷰 id 를 다른 화면과 같게 둔다. 버튼 id·class 가 같으면 위치가 달라도 같은 화면 id 가 된다 (펼치기처럼 배치만 바뀌는 상태)
// 앱 프로세스: am start 로 살고 am force-stop 으로 죽는다(pidof). 앱의 마지막 화면에서 BACK 을 누르면 Android 12+ 처럼
// 태스크가 뒤로 가고 화면은 남는다. 앞으로 가져오기(am start -f 0x10200000)는 남은 화면을 그대로 되살리고,
// 그 밖의 am start(0x10008000 CLEAR_TASK 등)는 첫 화면부터 다시 쌓는다
import { PNG_MAGIC } from '../dist/device.js';

const LAUNCHER = { pkg: 'com.android.launcher3', activity: 'com.android.launcher3.Launcher', buttons: [] };

const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function nodeXml(pkg, b) {
  const [l, t, r, bt] = b.bounds;
  const id = b.id ? (b.id.includes(':id/') ? b.id : `${pkg}:id/${b.id}`) : '';
  return `<node class="${b.cls ?? 'android.widget.Button'}" resource-id="${attr(id)}" text="${attr(b.text)}" content-desc="${attr(b.desc)}" package="${pkg}" bounds="[${l},${t}][${r},${bt}]" clickable="${b.clickable ?? true}" long-clickable="${!!b.long}" scrollable="false" focusable="true" focused="false" enabled="${b.enabled ?? true}" checkable="false" checked="false" selected="${!!b.selected}" password="false"/>`;
}

export function screenXml(name, s, defaultPkg) {
  const pkg = s.pkg ?? defaultPkg;
  const kids = s.buttons.map((b) => nodeXml(pkg, b)).join('');
  // 화면마다 루트 id 를 달리 해 구조 시그니처가 갈리게 한다
  return `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node class="android.widget.FrameLayout" resource-id="${pkg}:id/root_${s.root ?? name}" text="" content-desc="" package="${pkg}" bounds="[0,0][1080,2400]" clickable="false" long-clickable="false" scrollable="false" focusable="false" focused="false" enabled="true" checkable="false" checked="false" selected="false" password="false">${kids}</node></hierarchy>`;
}

/**
 * @param {{ pkg: string, launch: string, screens: Record<string, any> }} app
 */
export function fakeDevice(app, serial = 'fake-1') {
  const screens = { ...app.screens, '@launcher': LAUNCHER };
  /** 화면 스택. 맨 끝이 지금 화면. 항목은 { name, backLeft } */
  let stack = [];
  /** 뒤로 가기로 앱 밖에 나왔을 때 남아 있는 앱 화면 (앞으로 가져오면 되살린다) */
  let parked = null;
  let alive = false;
  const log = [];
  /** [명령, 받은 시각(ms)]. 기다림 길이처럼 명령 순서만으로 안 보이는 것을 볼 때 쓴다 */
  const stamps = [];
  const top = () => stack.at(-1) ?? { name: '@launcher', backLeft: 0 };
  const cur = () => screens[top().name];
  const push = (name) => stack.push({ name, backLeft: screens[name].backConsumes ?? 0 });
  const back = () => {
    const t = stack.at(-1);
    if (!t) return;
    if (t.backLeft > 0) t.backLeft--;
    else if (stack.length === 1 && (screens[t.name].pkg ?? app.pkg) === app.pkg) parked = stack.splice(0);
    else stack.pop();
  };
  const go = (target) => {
    if (!target) return;
    if (target === '@back') back();
    else for (const t of [target].flat()) push(t);
  };
  const hit = (x, y) =>
    cur()
      .buttons.filter((b) => (b.clickable ?? true) && (b.enabled ?? true))
      .filter(({ bounds: [l, t, r, bt] }) => x >= l && x <= r && y >= t && y <= bt)
      .sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))[0];

  const record = (cmd) => {
    const c = cmd.replace(/droidlens_ui_[0-9a-f]+/g, 'droidlens_ui_X');
    log.push(c);
    stamps.push([c, Date.now()]);
  };

  function shell(cmd) {
    record(cmd);
    let m;
    if (cmd.startsWith('dumpsys window displays')) return '  mDisplayId=0\n    cur=1080x2400 app=1080x2337';
    if (cmd.startsWith('dumpsys window')) {
      const s = cur();
      return `  mCurrentFocus=Window{1a2b u0 ${s.pkg ?? app.pkg}/${s.activity}}\n  mFocusedApp=ActivityRecord{3c4d u0 ${s.pkg ?? app.pkg}/${s.activity} t12}`;
    }
    if (cmd.startsWith('dumpsys activity top')) return '';
    if (cmd.startsWith('cmd package resolve-activity')) return `priority=0 preferredOrder=0\n${app.pkg}/${screens[app.launch].activity}`;
    if (cmd.startsWith('am force-stop ')) {
      const pkg = cmd.slice('am force-stop '.length).trim();
      stack = stack.filter((e) => (screens[e.name].pkg ?? app.pkg) !== pkg);
      if (pkg === app.pkg) {
        alive = false;
        parked = null;
      }
      return '';
    }
    if (cmd.startsWith(`pidof ${app.pkg}`)) return alive || stack.length ? '4321' : '';
    if (cmd.startsWith('am start ')) {
      if (cmd.includes('0x10200000') && (alive || stack.length)) {
        // 앞에 떠 있던 다른 앱 화면은 뒤로 보낸다
        // (inTask: 앱 태스크 안에 뜬 다른 패키지 화면. Custom Tab·결제 SDK 처럼 앞으로 가져와도 남는다)
        while (stack.length && (screens[stack.at(-1).name].pkg ?? app.pkg) !== app.pkg && !screens[stack.at(-1).name].inTask) stack.pop();
        if (!stack.length && parked) stack = parked;
        parked = null;
        if (!stack.length) push(app.launch);
        return 'Status: ok';
      }
      stack = [];
      parked = null;
      alive = true;
      push(app.launch);
      return 'Status: ok';
    }
    if ((m = /^input tap (\d+) (\d+)$/.exec(cmd))) {
      const b = hit(Number(m[1]), Number(m[2]));
      if (b?.fail) throw new Error(b.fail);
      go(b?.go);
      return '';
    }
    if ((m = /^input swipe (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(cmd))) {
      const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
      if (x1 === x2 && y1 === y2) {
        go(hit(x1, y1)?.long);
        return '';
      }
      const dir = Math.abs(x2 - x1) > Math.abs(y2 - y1) ? (x2 < x1 ? 'left' : 'right') : y2 < y1 ? 'up' : 'down';
      go(cur().swipe?.[dir]);
      return '';
    }
    if ((m = /^input keyevent (\d+)$/.exec(cmd))) {
      if (m[1] === '4' && cur().backThrows) throw new Error(cur().backThrows);
      if (m[1] === '4') back();
      return '';
    }
    return '';
  }

  function execOut(cmd) {
    record(cmd);
    if (cmd.startsWith('uiautomator dump')) {
      const name = top().name;
      return Buffer.from(`UI hierchary dumped to: /data/local/tmp/x.xml\n__DROIDLENS_XML__\n${screenXml(name, screens[name], app.pkg)}`);
    }
    if (cmd.startsWith('screencap')) return Buffer.concat([PNG_MAGIC, Buffer.from(`screen:${top().name}`)]);
    return Buffer.alloc(0);
  }

  const dev = {
    serial,
    adb: undefined,
    shell: async (cmd) => shell(cmd),
    execOut: async (cmd) => execOut(cmd),
    text: async (args) => (args[0] === 'shell' ? shell(args.slice(1).join(' ')) : ''),
    raw: async (args) => (args[0] === 'exec-out' ? execOut(args.slice(1).join(' ')) : Buffer.alloc(0)),
    forward: async () => 0,
    spawn: () => {
      throw new Error('fake device: spawn 미지원');
    },
  };
  return {
    dev,
    log,
    stamps,
    /** 지금 화면 이름 */
    get screen() {
      return top().name;
    },
    /** 스택을 바로 정한다 (앱을 그 화면까지 열어 둔 상태) */
    open(...names) {
      stack = [];
      parked = null;
      alive = names.length > 0;
      for (const n of names) push(n);
    },
    /** 화면 크기 조회는 2초 캐시라 시각에 따라 들어가거나 빠진다: 명령 순서 비교에서는 뺀다 */
    commands() {
      return log.filter((c) => !c.startsWith('dumpsys window displays'));
    },
  };
}
