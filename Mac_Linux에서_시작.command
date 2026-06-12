#!/usr/bin/env bash
# DroidBridge 자동 세팅 및 실행 (macOS / Linux)
# macOS: 이 파일을 더블클릭하면 실행됩니다
#        (안 되면 우클릭 → 열기, 또는 터미널에서 ./Mac_Linux에서_시작.command)
# Linux: 터미널에서 ./Mac_Linux에서_시작.command
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
err()  { echo -e "${RED}[X]${NC} $1"; }
info() { echo -e "${YELLOW}[..]${NC} $1"; }

echo "============================================"
echo "  DroidBridge 자동 세팅 및 실행"
echo "============================================"
echo

# ── 1. Node.js 확인 ──────────────────────────
if ! command -v node &> /dev/null; then
  err "Node.js가 설치되어 있지 않습니다."
  if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &> /dev/null; then
    info "Homebrew로 Node.js 설치 중..."
    brew install node
  else
    err "https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
    exit 1
  fi
fi
ok "Node.js $(node --version)"

# ── 2. npm 의존성 설치 ───────────────────────
if [ ! -d "node_modules" ]; then
  info "npm 패키지 설치 중... (최초 1회, 1~2분 소요)"
  npm install --silent
fi
ok "npm 패키지 준비됨"

# ── 3. adb / scrcpy 자동 설치 ────────────────
need_adb=false; need_scrcpy=false
command -v adb    &> /dev/null || [ -f "bin/adb" ]    || need_adb=true
command -v scrcpy &> /dev/null || [ -f "bin/scrcpy" ] || need_scrcpy=true

if $need_adb || $need_scrcpy; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS — Homebrew
    if ! command -v brew &> /dev/null; then
      err "Homebrew가 필요합니다: https://brew.sh 에서 설치 후 다시 실행해 주세요."
      exit 1
    fi
    $need_adb    && { info "adb 설치 중...";    brew install --quiet android-platform-tools; }
    $need_scrcpy && { info "scrcpy 설치 중..."; brew install --quiet scrcpy; }
  else
    # Linux — apt / dnf / pacman 자동 감지
    if command -v apt &> /dev/null; then
      info "apt로 adb/scrcpy 설치 중... (sudo 비밀번호 필요)"
      sudo apt update -qq
      $need_adb    && sudo apt install -y adb
      $need_scrcpy && sudo apt install -y scrcpy
    elif command -v dnf &> /dev/null; then
      $need_adb    && sudo dnf install -y android-tools
      $need_scrcpy && sudo dnf install -y scrcpy
    elif command -v pacman &> /dev/null; then
      $need_adb    && sudo pacman -S --noconfirm android-tools
      $need_scrcpy && sudo pacman -S --noconfirm scrcpy
    else
      err "지원하는 패키지 매니저를 찾을 수 없습니다. adb와 scrcpy를 직접 설치해 주세요."
      exit 1
    fi
  fi
fi
ok "adb:    $(command -v adb    || echo bin/adb)"
ok "scrcpy: $(command -v scrcpy || echo bin/scrcpy)"

# ── 4. 기기 연결 확인 ────────────────────────
echo
info "연결된 Android 기기 확인 중..."
adb start-server &> /dev/null || true
devices=$(adb devices | tail -n +2 | grep -c "device$" || true)
unauth=$(adb devices | tail -n +2 | grep -c "unauthorized" || true)
if [ "$devices" -gt 0 ]; then
  ok "기기 ${devices}대 감지됨"
elif [ "$unauth" -gt 0 ]; then
  err "기기가 있지만 미승인 상태 — 폰 화면에서 \"USB 디버깅 허용\"을 눌러주세요"
else
  err "감지된 기기 없음 — USB 연결과 USB 디버깅 설정을 확인해 주세요 (앱에서 Wi-Fi 연결도 가능)"
fi

# ── 5. 앱 실행 ───────────────────────────────
echo
echo "============================================"
echo "  세팅 완료! DroidBridge를 시작합니다..."
echo "============================================"
npm start
