@echo off
title OpenCode Relay
setlocal

:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

echo ========================================
echo  OpenCode Relay Server
echo ========================================
echo.
echo This relay server enables remote
echo Live Share sessions over the internet.
echo.
echo Listening on port 3747
echo WebSocket: ws://localhost:3747
echo.
echo Press Ctrl+C to stop
echo ========================================
echo.

cd /d "%SCRIPT_DIR%"
bun run relay-server.ts

pause
