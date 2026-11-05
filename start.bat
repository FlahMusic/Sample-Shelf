@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get the LTS from https://nodejs.org then run this again.
  pause
  exit /b
)
rem first run, or a package was added since the last install
node -e "for (const d in require('./package.json').dependencies) if (!require('fs').existsSync('node_modules/' + d + '/package.json')) process.exit(1)" >nul 2>nul
if errorlevel 1 (
  echo Installing packages. Takes a minute.
  call npm install
  if errorlevel 1 ( pause & exit /b )
)
rem electron 44 doesn't download its exe during npm install, it grabs it on first use
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading Electron. Takes a minute.
  call node node_modules\electron\install.js
  if errorlevel 1 ( pause & exit /b )
)
start "" "node_modules\electron\dist\electron.exe" .
