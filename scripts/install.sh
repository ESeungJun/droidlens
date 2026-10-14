#!/usr/bin/env bash
# DroidLens 설치·업데이트 (macOS, Linux)
#   curl -fsSL https://raw.githubusercontent.com/ESeungJun/droidlens/master/scripts/install.sh | bash
#
# macOS: 최신 릴리스 zip 을 받아 /Applications/DroidLens.app 을 설치·교체하고 실행한다.
#        브라우저가 아니라 curl 로 받으므로 Gatekeeper 경고 없이 바로 열린다.
# Linux: AppImage 를 ~/.local/bin/DroidLens.AppImage 로 받고 실행 권한을 준다.
#
# 받은 파일은 릴리스의 SHA256SUMS 와 대조하고, 다르면 설치하지 않는다.
# 전체를 main 함수로 감싸 두어 다운로드가 중간에 끊겨도 일부만 실행되지 않는다.
set -euo pipefail

main() {
  local REPO="ESeungJun/droidlens"
  local API="https://api.github.com/repos/${REPO}/releases/latest"

  say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
  die() { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }

  command -v curl >/dev/null || die "curl 이 필요합니다"

  local TMP
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  say "최신 릴리스 확인 중…"
  # 응답을 파일로 먼저 받는다 (파이프로 grep 하면 curl 이 SIGPIPE 로 조용히 끝날 수 있다)
  if ! curl -fsSL -o "$TMP/release.json" "$API"; then
    die "GitHub 에서 최신 릴리스를 가져오지 못했습니다. 네트워크를 확인하거나 잠시 뒤 다시 시도하세요 (GitHub API 요청 한도: 시간당 60회)"
  fi
  local TAG
  TAG=$(grep -m1 '"tag_name"' "$TMP/release.json" | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)
  [ -n "$TAG" ] || die "릴리스 정보에서 버전을 찾지 못했습니다"
  local VERSION="${TAG#v}"
  local BASE="https://github.com/${REPO}/releases/download/${TAG}"

  # 체크섬 목록
  if ! curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"; then
    die "릴리스 ${TAG} 에 SHA256SUMS 가 없어 파일을 확인할 수 없습니다"
  fi
  verify() {
    local file="$1" name="$2" want got
    want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$TMP/SHA256SUMS")
    [ -n "$want" ] || die "SHA256SUMS 에 ${name} 이(가) 없습니다"
    if command -v shasum >/dev/null; then got=$(shasum -a 256 "$file" | awk '{print $1}')
    else got=$(sha256sum "$file" | awk '{print $1}'); fi
    [ "$want" = "$got" ] || die "${name} 의 체크섬이 릴리스와 다릅니다. 설치하지 않습니다"
    say "체크섬 확인됨"
  }

  case "$(uname -s)" in
    Darwin)
      # Rosetta 로 돌아가는 터미널에서도 실제 CPU 를 본다 (uname -m 은 x86_64 로 나온다)
      local ARCH=x64
      [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] && ARCH=arm64
      local FILE="DroidLens-${VERSION}-mac-${ARCH}.zip"
      say "${FILE} 내려받는 중…"
      curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || die "내려받지 못했습니다: $BASE/$FILE"
      verify "$TMP/$FILE" "$FILE"
      ditto -x -k "$TMP/$FILE" "$TMP/app"
      [ -d "$TMP/app/DroidLens.app" ] || die "압축 안에 DroidLens.app 이 없습니다"

      local DEST="/Applications"
      [ -w "$DEST" ] || DEST="$HOME/Applications"
      mkdir -p "$DEST"
      local BIN="$DEST/DroidLens.app/Contents/MacOS/DroidLens"
      if pgrep -f "$BIN" >/dev/null 2>&1; then
        say "실행 중인 DroidLens 종료"
        osascript -e 'quit app "DroidLens"' >/dev/null 2>&1 || true
        # 실제로 끝날 때까지 기다린다 (실행 중인 번들을 지우면 옛 인스턴스가 깨진 채 남는다)
        local i
        for i in $(seq 1 40); do pgrep -f "$BIN" >/dev/null 2>&1 || break; sleep 0.5; done
        pgrep -f "$BIN" >/dev/null 2>&1 && die "DroidLens 가 종료되지 않았습니다. 앱을 직접 종료한 뒤 다시 실행하세요"
      fi
      rm -rf "$DEST/DroidLens.app"
      ditto "$TMP/app/DroidLens.app" "$DEST/DroidLens.app"
      xattr -dr com.apple.quarantine "$DEST/DroidLens.app" 2>/dev/null || true
      say "설치 완료: $DEST/DroidLens.app (v${VERSION})"
      open "$DEST/DroidLens.app"
      ;;
    Linux)
      [ "$(uname -m)" = "x86_64" ] || die "Linux 는 x86_64 만 지원합니다"
      local FILE="DroidLens-${VERSION}-linux-x86_64.AppImage"
      local DEST="$HOME/.local/bin/DroidLens.AppImage"
      mkdir -p "$(dirname "$DEST")"
      say "${FILE} 내려받는 중…"
      curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || die "내려받지 못했습니다: $BASE/$FILE"
      verify "$TMP/$FILE" "$FILE"
      mv "$TMP/$FILE" "$DEST"
      chmod +x "$DEST"
      say "설치 완료: $DEST (v${VERSION})"
      echo "실행: $DEST"
      ;;
    *)
      die "Windows 는 Releases 에서 설치 파일(.exe)을 받으세요: https://github.com/${REPO}/releases/latest"
      ;;
  esac
}

main "$@"
