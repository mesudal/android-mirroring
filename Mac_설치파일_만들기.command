#!/usr/bin/env bash
# DroidBridge macOS용 DMG 설치파일 빌드 스크립트
# 이 파일을 더블클릭하여 실행하면 자동으로 필요한 도구(Node.js 등)를 설치하고 DMG 빌드를 완료합니다.
set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
err()  { echo -e "${RED}[X]${NC} $1"; }
info() { echo -e "${YELLOW}[..]${NC} $1"; }

echo "============================================"
echo "  DroidBridge macOS DMG 빌드 마법사"
echo "============================================"
echo

# ── 1. Xcode Command Line Tools 확인 및 설치 ──
if ! xcode-select -p &>/dev/null; then
  info "빌드를 위해 Xcode Command Line Tools가 필요합니다. 설치 창을 띄웁니다..."
  xcode-select --install
  echo "------------------------------------------------------------"
  echo "설치 창이 완료될 때까지 기다린 후, 완료되면 아무 키나 눌러 계속 진행해주세요."
  echo "------------------------------------------------------------"
  read -n 1 -s
fi
ok "Xcode Command Line Tools 확인됨"

# ── 2. Homebrew 확인 및 설치 ──────────────────
if ! command -v brew &> /dev/null; then
  info "Homebrew를 찾을 수 없습니다. Homebrew 설치를 시도합니다..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  
  # Apple Silicon 및 Intel Mac PATH 환경변수 로드
  if [ -f "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -f "/usr/local/bin/brew" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# PATH 리로드 (Homebrew 정상 적용을 위해 다시 한번 체크)
if command -v brew &> /dev/null; then
  ok "Homebrew 준비됨: $(brew --version | head -n 1)"
else
  # 수동 경로 등록
  if [ -d "/opt/homebrew/bin" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [ -d "/usr/local/bin" ]; then
    export PATH="/usr/local/bin:$PATH"
  fi
  if command -v brew &> /dev/null; then
    ok "Homebrew 준비됨: $(brew --version | head -n 1)"
  else
    err "Homebrew를 자동으로 연동할 수 없습니다. 터미널을 다시 켜고 실행해 주세요."
    exit 1
  fi
fi

# ── 3. Node.js 확인 및 설치 ──────────────────
if ! command -v node &> /dev/null; then
  info "Node.js가 필요합니다. Homebrew로 설치 중..."
  brew install node
fi
ok "Node.js 버전: $(node --version)"

# ── 4. npm 의존성 패키지 설치 ────────────────────
info "필요한 패키지를 다운로드하는 중... (1~2분 소요)"
npm install

# ── 5. DMG 빌드 실행 ──────────────────────────
info "macOS 설치 파일(.dmg) 빌드 시작..."
npm run build:mac

echo
echo "============================================"
ok "빌드가 완료되었습니다!"
info "dist/ 폴더 내 DroidBridge-1.0.0.dmg 파일을 사용하세요!"
echo "============================================"
open dist
