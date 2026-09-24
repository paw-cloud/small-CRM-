@echo off
chcp 65001 >nul
set /p ADRES=Adres opublikowanej strony (Enter, jesli jeszcze nie opublikowano):
if "%ADRES%"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sprawdz.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sprawdz.ps1" -Adres "%ADRES%"
)
echo.
pause
