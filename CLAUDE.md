# sample shelf

electron app (windows 11) that scans flah's sample folders, converts everything to wav, sorts by bpm/key/type, previews, and drags wavs into his daw (fender studio pro 8, formerly studio one).

current task: read `HANDOFF-sound-map.md` first. it has the plan, the open questions for flah, and what's verified vs not.

## how flah wants you to work
- ask before assuming intent, architecture or requirements. ask the "ask flah" questions in the handoff before building those parts.
- simplest thing that works first. no unrequested abstractions or options.
- don't touch code unrelated to the current task.
- flag uncertainty out loud. check sources, never guess.
- running isn't working: test that it's actually usable on this pc with real samples (playable, findable, drags into studio pro).
- never change a design just to make a test pass. fix the thing, then the test.
- ui copy: short, plain, lowercase, no flavour text, no ai words.
- don't describe this app as a version of or successor to any other product.
- end every pass with a plain list: files to upload to github / files to delete.
- talk to him casual and short.

## run
- `start.bat` (npm install on first run, then downloads electron.exe — electron 44 doesn't fetch it during npm install)
- dev: `npm start`
- db: `%APPDATA%\sample-shelf\shelf.json`

## layout
- `main.js`: window, db, ipc, cleanup, drag (`webContents.startDrag`)
- `preload.js`: `window.shelf` api
- `lib/worker.js`: scan / convert (ffmpeg-static) / tags / detect (essentia.js)
- `lib/keys.js`, `lib/classify.js`: shared helpers (node + window)
- `renderer/`: ui
- `docs/`: map visual target + sound-map prototype
