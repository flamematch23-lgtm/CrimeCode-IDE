@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  OpenCode - Internet Sharing Setup
echo ========================================
echo.

REM Get public IP
echo Retrieving public IP...
for /f "delims=" %%i in ('curl -s ifconfig.me') do set PUBLIC_IP=%%i

REM Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr "192.168"') do (
    set LOCAL_IP=%%a
    set LOCAL_IP=!LOCAL_IP:~1!
)

if not defined LOCAL_IP set LOCAL_IP=192.168.1.182
if not defined PUBLIC_IP set PUBLIC_IP=TUO_IP_PUBBLICO

echo.
echo ================================================
echo  SERVER CONFIGURATION
echo ================================================
echo.
echo LOCAL:   http://127.0.0.1:56912
echo LAN:     http://%LOCAL_IP%:56912
echo INTERNET: http://%PUBLIC_IP%:56912
echo.
echo RELAY:   ws://%PUBLIC_IP%:3747
echo.
echo PASSWORD: Crime1312
echo USERNAME: opencode
echo.
echo ================================================
echo.

REM Create config file
(
echo {
echo   "server": {
echo     "url": "http://%PUBLIC_IP%:56912",
echo     "username": "opencode",
echo     "password": "Crime1312"
echo   },
echo   "relay": {
echo     "url": "ws://%PUBLIC_IP%:3747"
echo   },
echo   "instructions": {
echo     "host": "Share this config with collaborators",
echo     "connect": "OpenCode Desktop ^> Server ^> Add ^> Enter server URL"
echo   }
echo }
) > opencode-remote-config.json

echo Config saved to: opencode-remote-config.json
echo.

REM Ask to start servers
set /p START="Start relay and server now? (y/n): "
if /i "!START!"=="y" (
    echo.
    echo Starting servers...
    echo.
    start "OpenCode Relay" cmd /k "bun relay-server.ts"
    timeout /t 2 /nobreak >nul
    start "OpenCode Server" cmd /k "set OPENCODE_SERVER_PASSWORD=Crime1312 ^&^& bun run --cwd packages/opencode serve --hostname 0.0.0.0 --port 56912"
    echo.
    echo Servers started in new windows!
    echo Close windows or press Ctrl+C to stop.
)

echo.
echo ================================================
echo  QUICK CONNECT (for collaborators)
echo ================================================
echo.
echo They need to:
echo 1. Open OpenCode Desktop
echo 2. Click server icon at bottom
echo 3. Click "Add Server"
echo 4. Enter:
echo    URL:    http://%PUBLIC_IP%:56912
echo    Name:   Remote Server
echo    User:   opencode
echo    Pass:   Crime1312
echo.
echo ================================================
echo.

set /p CLOSE="Press ENTER to close..."
