@echo off
echo ========================================
echo  OpenCode Relay - Configurazione Internet
echo ========================================
echo.

echo Ottenendo IP pubblico...
for /f "delims=" %%i in ('curl -s ifconfig.me') do set PUBLIC_IP=%%i

echo.
echo ================================================
echo  CONFIGURAZIONE RELAY INTERNET
echo ================================================
echo.
echo IP PUBBLICO: %PUBLIC_IP%
echo PORTA RELAY: 3747
echo PORTA SERVER: 56912
echo.
echo ================================================
echo.
echo ISTRUZIONI PORT FORWARDING:
echo.
echo 1. Apri il browser e vai al router:
echo    - Solitamente: 192.168.1.1
echo    - Oppure: 192.168.0.1
echo.
echo 2. Fai login (admin/admin o credenziali router)
echo.
echo 3. Trova "Port Forwarding" o "NAT"
echo.
echo 4. Aggiungi queste regole:
echo.
echo    REGOLA 1 - Relay:
echo    - Porta esterna: 3747
echo    - Porta interna: 3747
echo    - Protocollo: TCP
echo    - IP interno: 192.168.1.182
echo.
echo    REGOLA 2 - Server:
echo    - Porta esterna: 56912
echo    - Porta interna: 56912
echo    - Protocollo: TCP
echo    - IP interno: 192.168.1.182
echo.
echo ================================================
echo.
echo 5. Verifica aprendo:
echo    http://%PUBLIC_IP%:3747/health
echo.
echo ================================================
echo.
echo CONFIGURAZIONE CLIENT (da condividere):
echo.
echo URL Relay:  ws://%PUBLIC_IP%:3747
echo URL Server: http://%PUBLIC_IP%:56912
echo.
echo ================================================
echo.

set /p FINE="Premi INVIO per chiudere..."
