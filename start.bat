@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get the LTS from https://nodejs.org then run this again.
  pause
  exit /b
)
if not exist node_modules (
  echo First run: installing. Takes a minute.
  call npm install
  if errorlevel 1 ( pause & exit /b )
)
start "" "node_modules\electron\dist\electron.exe" .
