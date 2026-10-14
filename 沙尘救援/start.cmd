@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js before starting this demo.
  pause
  exit /b 1
)
start "" http://127.0.0.1:8787
node server.mjs
pause
