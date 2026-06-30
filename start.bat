@echo off
title TRIMIO
color 0A
cls
cd /d "%~dp0"

echo.
echo  ========================================
echo    TRIMIO - Barbershop Booking App
echo  ========================================
echo.

:: Mbyll proceset e vjetra ne keto porta
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 "') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":5173 "') do taskkill /F /PID %%a >nul 2>&1

:: Instalo dependencies nese mungojne
if not exist "backend\node_modules" (
    echo  Duke instaluar backend...
    cd backend && npm install && cd ..
)
if not exist "frontend\node_modules" (
    echo  Duke instaluar frontend...
    cd frontend && npm install && cd ..
)

echo  [1/2] Backend duke u startuar...
start "TRIMIO - Backend" cmd /k "cd /d "%~dp0backend" && node src/server.js"

echo  [2/2] Frontend duke u startuar...
start "TRIMIO - Frontend" cmd /k "cd /d "%~dp0frontend" && npx vite --host"

echo.
echo  Duke pritur serverët...
timeout /t 6 /nobreak >nul

:: Gjej IP per celularin
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4 Address" /c:"Adresa IPv4"') do (
    set IP=%%I
    goto :showip
)
:showip
set IP=%IP: =%

cls
echo.
echo  ========================================
echo    TRIMIO eshte GATI!
echo  ========================================
echo.
echo   PC / Laptop:   http://localhost:5173
echo   Celular / WiFi: http://%IP%:5173
echo.
echo   KREDENCIALET:
echo   Admin:  admin / admin123
echo   Owner:  owner / owner123
echo   Barber: [emri] / [emri]123
echo.
echo   SHEMBULL SALLONE:
echo   /s/milano-centro
echo   /s/barber-napoli
echo   /s/gentleman-torino
echo.
echo  ========================================
echo  (Mos i mbyll dritaret TRIMIO Backend/Frontend)
echo.

start "" "http://localhost:5173"
pause
