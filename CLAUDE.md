# sample shelf (mac copy)

this folder is the mac copy of `../sample shelf`. **don't edit the app here.** change it in the windows folder (read its CLAUDE.md), keep the code working on both, then run `node sync-mac.js` there. that copies everything over except the windows-only files.

files that only live here, and the sync never touches:
- `start.command`: mac launcher (npm install, electron download, start)
- `MAC.md`: first-run steps for whoever tests it
- `CLAUDE.md`: this file
- `.gitattributes`: keeps start.command's line endings mac-style

the mac build has never been run (flah has no mac; a friend tests it).
