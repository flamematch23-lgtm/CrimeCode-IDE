@echo off
echo ========================================
echo  OpenCode Firewall Setup
echo ========================================
echo.

echo This script will:
echo 1. Open port 56912 in Windows Firewall (Inbound)
echo 2. Create a rule to allow OpenCode connections
echo.

set /p CONFIRM="Continue? (y/n): "
if /i not "%CONFIRM%"=="y" exit /b 1

echo.
echo Adding firewall rule...

netsh advfirewall firewall add rule name="OpenCode Server" dir=in action=allow protocol=tcp localport=56912

if %errorlevel%==0 (
    echo.
    echo SUCCESS: Firewall rule added!
    echo.
    echo Port 56912 is now open for OpenCode Server.
) else (
    echo.
    echo ERROR: Failed to add firewall rule.
    echo Try running as Administrator.
)

echo.
pause
