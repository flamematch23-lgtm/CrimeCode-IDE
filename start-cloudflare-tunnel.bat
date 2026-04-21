@echo off
echo ========================================
echo  Cloudflare Tunnel Setup
echo ========================================
echo.

set /p TUNNEL_NAME="Tunnel name (es. opencode): "

echo.
echo Creazione tunnel...
cloudflared tunnel create %TUNNEL_NAME%

echo.
echo Tunnel creato!
echo.
echo Avvio tunnel...
echo.

cloudflared tunnel run --url http://localhost:56912 %TUNNEL_NAME%
