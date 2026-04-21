@echo off
title OpenCode Server
setlocal EnableDelayedExpansion

:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

echo ========================================
echo  OpenCode Server - Remote Mode
echo ========================================
echo.
echo Password: SET (Crime1312)
echo.

:: Find local IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr "192.168"') do (
    set LOCAL_IP=%%a
    set LOCAL_IP=!LOCAL_IP:~1!
)

if defined LOCAL_IP (
    echo Local IP: %LOCAL_IP%
) else (
    set LOCAL_IP=192.168.1.182
    echo Local IP: %LOCAL_IP%
)

echo.
echo =============================================
echo Server listening on 0.0.0.0:56912
echo.
echo LOCAL:   http://127.0.0.1:56912
echo REMOTO:  http://%LOCAL_IP%:56912
echo =============================================
echo.
echo Credentials:
echo   Username: opencode
echo   Password: Crime1312
echo.
echo Press Ctrl+C to stop
echo ========================================
echo.

cd /d "%SCRIPT_DIR%"
set OPENCODE_SERVER_PASSWORD=Crime1312
bun run --cwd packages/opencode ./src/index.ts serve --hostname 0.0.0.0 --port 56912
