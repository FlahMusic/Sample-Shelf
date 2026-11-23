#!/bin/bash
# sample shelf for mac. run it from Terminal: bash start.command
# (or double-click it in Finder after: chmod +x start.command)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Get the LTS from https://nodejs.org then run this again."
  read -r -n 1
  exit 1
fi
# first run, or a package was added since the last install
if ! node -e "for (const d in require('./package.json').dependencies) if (!require('fs').existsSync('node_modules/' + d + '/package.json')) process.exit(1)"; then
  echo "Installing packages. Takes a minute."
  npm install || { read -r -n 1; exit 1; }
fi
# electron 44 doesn't download itself during npm install, it does it on first use
if [ ! -f node_modules/electron/path.txt ]; then
  echo "Downloading Electron. Takes a minute."
  node node_modules/electron/install.js || { read -r -n 1; exit 1; }
fi
nohup node node_modules/electron/cli.js . >/dev/null 2>&1 &
echo "sample shelf is starting. you can close this window."
