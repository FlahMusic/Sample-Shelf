# sample shelf on a mac

Same app as the windows one. Nobody has tried it on a mac yet, so this first run is a test.

## first time

1. Install Node.js (the LTS one) from https://nodejs.org
2. Open Terminal, then type `cd ` (with a space) and drag this folder onto the Terminal window. Press return.
3. Type `bash start.command` and press return.

The first start installs packages and downloads Electron (a few minutes, needs internet). After that it starts in a few seconds.

## what to try

- **folders** → add a folder of samples → **scan**
- click rows: do they play? drag one into Logic / Ableton / Finder. does it land?
- tick **bpm sync** and **key lock**, then drag a loop out: is it in the new tempo and key?
- **map** view: do the dots show? two-finger drag (or option + drag) turns it, scroll zooms
- cmd-click picks more than one (where windows uses ctrl)
- the guide on first start: does the ring land on folders, then scan? is the orange bar at the bottom filling?
- map: click a star, then **solo**: do the others fade out and a star chart form round it?

## if something goes wrong

Send flah:
- a screenshot
- what Terminal printed
- the mac model, and Apple chip (M1/M2/M3/M4) or Intel

## where things go

- the app's data: `~/Library/Application Support/sample-shelf/shelf.json`
- wav copies of non-wav files: the library folder you pick on the first scan
