#!/usr/bin/env bash
# DroidLens 설치·업데이트 (macOS, Linux)
#   curl -fsSL https://raw.githubusercontent.com/ESeungJun/droidlens/master/scripts/install.sh | bash
#
# macOS: 최신 릴리스 zip 을 받아 /Applications/DroidLens.app 을 설치·교체하고 실행한다.
#        브라우저가 아니라 curl 로 받으므로 Gatekeeper 경고 없이 바로 열린다.
# Linux: AppImage 를 ~/.local/bin/DroidLens.AppImage 로 받고 실행 권한을 준다.
set -euo pipefail

REPO="ESeungJun/droidlens"
API="https://api.github.com/repos/${REPO}/releases/latest"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl 이 필요합니다"

say "최신 릴리스 확인 중…"
TAG=$(curl -fsSL "$API" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
[ -n "${TAG:-}" ] || die "최신 릴리스를 찾지 못했습니다 (GitHub API 요청 한도에 걸렸을 수 있습니다)"
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) ARCH=arm64 ;;
      x86_64) ARCH=x64 ;;
      *) die "지원하지 않는 CPU: $(uname -m)" ;;
    esac
    FILE="DroidLens-${VERSION}-mac-${ARCH}.zip"
    say "${FILE} 내려받는 중…"
    curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || die "내려받지 못했습니다: $BASE/$FILE"
    ditto -x -k "$TMP/$FILE" "$TMP/app"
    [ -d "$TMP/app/DroidLens.app" ] || die "압축 안에 DroidLens.app 이 없습니다"

    DEST="/Applications"
    [ -w "$DEST" ] || DEST="$HOME/Applications"
    mkdir -p "$DEST"
    if pgrep -f "$DEST/DroidLens.app/Contents/MacOS/DroidLens" >/dev/null 2>&1; then
      say "실행 중인 DroidLens 종료"
      osascript -e 'quit app "DroidLens"' >/dev/null 2>&1 || true
      sleep 2
    fi
    rm -rf "$DEST/DroidLens.app"
    ditto "$TMP/app/DroidLens.app" "$DEST/DroidLens.app"
    xattr -dr com.apple.quarantine "$DEST/DroidLens.app" 2>/dev/null || true
    say "설치 완료: $DEST/DroidLens.app (v${VERSION})"
    open "$DEST/DroidLens.app"
    ;;
  Linux)
    [ "$(uname -m)" = "x86_64" ] || die "Linux 는 x86_64 만 지원합니다"
    FILE="DroidLens-${VERSION}-linux-x86_64.AppImage"
    DEST="$HOME/.local/bin/DroidLens.AppImage"
    mkdir -p "$(dirname "$DEST")"
    say "${FILE} 내려받는 중…"
    curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || die "내려받지 못했습니다: $BASE/$FILE"
    mv "$TMP/$FILE" "$DEST"
    chmod +x "$DEST"
    say "설치 완료: $DEST (v${VERSION})"
    echo "실행: $DEST"
    ;;
  *)
    die "Windows 는 Releases 에서 설치 파일(.exe)을 받으세요: https://github.com/${REPO}/releases/latest"
    ;;
esac
