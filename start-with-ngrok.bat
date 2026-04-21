@echo off
echo ========================================
echo  OpenCode - Setup con NGROK
echo ========================================
echo.
echo Questo script usa ngrok per creare
echo un tunnel sicuro verso internet.
echo.
echo VANTAGGI:
echo - Non serve configurare il router
echo - HTTPS incluso automaticamente
echo - Facile e veloce
echo.
echo ========================================
echo.

REM Check if ngrok is installed
where ngrok >nul 2>&1
if %errorlevel% neq 0 (
    echo NGROK NON TROVATO!
    echo.
    echo Installa ngrok:
    echo 1. Vai su https://ngrok.com/download
    echo 2. Estrai ngrok.exe in questa cartella
    echo 3. Riavvia questo script
    echo.
    echo Oppure usa il comando:
    echo   mkdir ngrok ^&^& cd ngrok
    echo   curl -s https://bin.equinox.io/c/bNyj1DkmGdS/ngrok-stable-windows-amd64.zip -o ngrok.zip
    echo   tar -xf ngrok.zip
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo  AVVIO SERVER + NGROK
echo ================================================
echo.

REM Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr "192.168"') do (
    set LOCAL_IP=%%a
)

echo Locale IP: %LOCAL_IP%
echo.
echo Apertura tunnel ngrok...
echo.

REM Start relay tunnel in background
start "NGROK Relay" cmd /k "ngrok tcp 3747"
timeout /t 3 /nobreak >nul

REM Start server
start "OpenCode Server" cmd /k "set OPENCODE_SERVER_PASSWORD=Crime1312 ^&^& bun run --cwd packages/opencode serve --hostname 0.0.0.0 --port 56912"
timeout /t 2 /nobreak >nul

REM Start server tunnel
start "NGROK Server" cmd /k "ngrok http 56912"

echo.
echo ================================================
echo  ISTRUZIONI
echo ================================================
echo.
echo 1. NGROK ha aperto 2 tunnel:
echo    - TCP 3747 (Relay)
echo    - HTTP 56912 (Server)
echo.
echo 2. Nelle finestre NGROK trovi gli URL:
echo    - Forwarding: tcp://xyz.ngrok.io:xxxxx
echo    - Forwarding: https://xyz.ngrok.io
echo.
echo 3. Per connetterti da fuori:
echo    - Copia l'URL HTTPS da ngrok
echo    - Usalo nell'app OpenCode Desktop
echo.
echo ================================================
echo.
echo NOTE:
echo - Gli URL ngrok cambiano ad ogni riavvio
echo - Per URL fissi, registra un account ngrok
echo.
pause
