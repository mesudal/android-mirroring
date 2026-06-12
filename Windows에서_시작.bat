@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   DroidBridge - Setup and Launch
echo ============================================
echo.

REM ---- 1. Check Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found.
    echo     Please install the LTS version from https://nodejs.org
    echo.
    start https://nodejs.org/en/download
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v

REM ---- 2. Install npm packages ----
if not exist "node_modules\electron" (
    echo [..] Installing npm packages... ^(first run only, 1-2 min^)
    call npm install
    if errorlevel 1 (
        echo [X] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
)
echo [OK] npm packages ready

REM ---- 3. Download adb / scrcpy via PowerShell ----
echo [..] Checking adb / scrcpy...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Windows_setup.ps1"
if errorlevel 1 (
    echo [X] Binary setup failed. Check your internet connection.
    pause
    exit /b 1
)

REM ---- 4. Check connected device ----
echo.
echo [..] Checking for connected Android devices...
"%~dp0bin\adb.exe" start-server >nul 2>&1
for /f "skip=1 tokens=1,2" %%a in ('"%~dp0bin\adb.exe" devices') do (
    if "%%b"=="device" echo [OK] Device detected: %%a
    if "%%b"=="unauthorized" echo [!] Device %%a - tap "Allow USB debugging" on your phone
)

REM ---- 5. Launch app ----
echo.
echo ============================================
echo   Setup complete. Launching DroidBridge...
echo ============================================
start "" npx electron .
exit
endlocal
