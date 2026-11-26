# DroidLens Sample — main screen spec (QA example)

A short spec for trying the QA flow (spec → test cases → review → run → results table) end to end.
The app under test is the sample app in this repository (`android/sample`, package `io.github.eseungjun.droidlens.sample`).
Everything below works without internet access. Button labels are in Korean because that is what the app shows.

## 1. Main screen

- 1.1 When the app opens, the status line at the top reads `SDK <version> running: true`.
- 1.2 Below the status line, buttons are stacked vertically in this order: `GET 요청`, `POST 요청`, `폼 POST`, `404 요청`, `로컬 서버 요청`, `스트림 업로드`, `스트리밍 응답`, `DB에 메모 추가`, `PREFS 저장`, `커스텀 이벤트`.

## 2. Notes

- 2.1 Tapping `DB에 메모 추가` saves one note in the app database and the status line changes to `note #<number>`.
- 2.2 Tapping it again saves another note; the number goes up by 1.

## 3. Settings

- 3.1 Tapping `PREFS 저장` changes the status line to `prefs 저장됨` and stores the nickname `냥이` in the `settings` preferences.

## 4. Events

- 4.1 Tapping `커스텀 이벤트` changes the status line to `이벤트 기록됨` and records a custom event named `button_clicked`.

## 5. Local server

- 5.1 `로컬 서버 요청` calls a local test server on port 8099. When no server is reachable, the status line starts with `실패:` and the app keeps running.
