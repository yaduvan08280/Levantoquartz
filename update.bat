@echo off
rem Update the Levanto app on this computer: get the latest code, rebuild, restart.
rem Double-click this file, or run  .\update.bat  in the project folder.
cd /d "%~dp0"

echo.
echo === Getting the latest code ===
git pull
if errorlevel 1 goto failed

echo.
echo === Rebuilding and restarting ===
docker compose -f docker-compose.local.yml up --build -d
if errorlevel 1 goto failed

echo.
echo Done. Open the address you normally use, for example http://localhost:8090/admin/
echo If a page looks unchanged, press Ctrl+Shift+R in the browser.
goto end

:failed
echo.
echo Something went wrong - the message above says what. Nothing else was changed.

:end
echo.
pause
