@echo off
echo ========================================
echo  Installazione NGROK
echo ========================================
echo.

echo Opzione 1: Microsoft Store (Consigliata)
echo ========================================
echo.
echo 1. Premi Win e cerca "ngrok"
echo 2. Installa "ngrok" da Microsoft Store
echo 3. Poi esegui il comando sotto
echo.

echo Opzione 2: Winget
echo ========================================
echo.
echo Esegui questo comando in un terminale:
echo   winget install ngrok
echo.

echo Opzione 3: Download Manuale
echo ========================================
echo.
echo 1. Vai su: https://ngrok.com/download
echo 2. Clicca "Download for Windows"
echo 3. Estrai e metti ngrok.exe in questa cartella
echo.

echo.
echo ========================================
echo  DOPO l'installazione, esegui:
echo ========================================
echo.
echo   ngrok config add-authtoken 31mPwTC7R7GouZBlp87l4F8jdCF_3hhwdX6wVT5fFNQfj21Zq
echo.
echo Poi esegui:
echo   start-with-ngrok.bat
echo.
pause
