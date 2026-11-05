# sample shelf

finds every audio file on your drives, converts anything that isn't a wav into a wav, and lists them all in one place sorted by bpm / key / length.

## run it
double-click `start.bat`. first run installs stuff (needs node.js from nodejs.org).

## what it does
- scans the folders you pick under **folders**. add a whole drive (like `D:\`) to scan all of it. skips Windows, recycle bin, system folders
- untick a folder to hide its files (nothing gets deleted, scans skip it). tick it again and they're back. the trash icon takes the folder and its files off the shelf
- plain wavs stay where they are. everything else gets converted into the library folder you pick
- same file in two places = converted once, shown once
- conversion keeps sample rate, channels and bit depth. lossy files (mp3/ogg/aac) come out 24-bit
- studio one .audioloop / .musicloop: audio gets pulled out of the loop file, tempo kept
- a bare number in a name ("Juno 106", "Perc 117") only counts as bpm when the length is within 25 ms of a whole number of bars at it. "128bpm" / "bpm128" always count
- bpm/key: file tags, then file name, then (loops only) folder name, then detected. anything not stated in the name, tags or by you is a guess and gets a **?** (`A min?`, `124?`). ones you set show bold pink
- keys in names: `Am`, `F#m`, `C minor`, `Eb_Maj`, `KeyOfEm`, `Key of Bb`. a bare capital M isn't read as major (that's FM / AM synth names). notes with an octave (`C3`, `F#1`) count as a stated note
- one-shots get a note, not a key: from the name, else detected (yin pitch). on 476 one-shots with the note in the name it answered 85% of the time and was right on 96% of those. no confident pitch = no note
- no tempo detection on files under 1.5s
- rescans only touch new or changed files
- scan checks first, without converting: how many new sounds each folder has and about how much room their wav copies take (a few files of each type get probed, the rest scaled by size. on Sample Packs: 6.81 gb estimated, 6.79 gb exact), and free space on the drive. folders with program files (exe, dll, vst3, game paks), an instrument's own samples (the same sound at 3+ notes, like serum's multisamples) or preset previews (.nksf.ogg), or long files (songs, mixes) start unticked. mp3/ogg copies are 16-bit (a third smaller than 24, and the encoder already dropped more than 16-bit loses). unticked folders get skipped from then on. it only asks when copies come to 50 mb or more, a folder got flagged, or the drive would get under 5 gb free. it also says how much room wav copies of samples outside your folders take, with a button to remove them

## can't decode
.rx2 / .rex / .rcy, .soundx, .ncw — proprietary, ffmpeg can't read them. scan reports how many it skipped. macOS `._` files (metadata that comes along with packs made on a mac) aren't audio and get skipped.

## map
switch **list / map** up top. same search, filters, selection, preview and lock in both.
- every shown sample is a dot, placed near ones that sound alike (its first 10 s go through a sound model, CLAP: laion clap-htsat-unfused, apache-2.0, run with onnxruntime. 32 numbers per sample, laid out with umap). on 3,355 of your samples with a sound word in the name, the 10 nearest from **other** packs share the sound 57% of the time (the hand-made features before: 39%, chance: 13%). the bigger CLAP models were no better and twice as slow. colours = sound (kick, snare, hat, perc, bass, keys, vocal, fx), loops are mint
- sound comes from name/folder words. the rest get a guess (`?`) from their nearest labelled neighbours. checked on your shelf with other packs only as neighbours: right 64% of the time (one-shots: kick 84%, snare 84%, hat 84%, bass 70%, perc 47%)
- click a dot: it becomes the centre. the side list shows **similar** (nearest by sound, circles on the map) or **fits with** (loops whose key sits next to it on the camelot wheel and whose bpm is within 6% or half/double; with a lock on, that half is skipped). ↑↓ steps through the list and plays each one (shift = 5), ←→ goes back/forward through what you played, enter makes the current one the centre
- drag across dots to hear them. ctrl+drag a dot (or drag a row in the side list) into studio pro. right-drag moves the map, wheel zooms, double-click empty space fits it back
- scans measure new samples for the map, about 0.6 s each. the first scan downloads the model once (118 mb, into the app's own folder, checked against its sha256). samples measured the old way leave the map until a scan measures them again: the check before scanning says how many and how long. remove samples outside your folders first if there are lots. new ones get placed next to their neighbours so the map doesn't move; "rebuild map" lays it all out again (~1 min)

## filters
loops / one-shots checkboxes, pick any number of keys, bpm min–max. they all stack with the search box.

loop vs one-shot: under 1 s is always a one-shot (a bar at 240 bpm is 1 s). then the closest "loop" / "one shot" / "hit" word in the name or folders wins, then studio one loop files and stated tempos count as loops, then anything under 2 s is a one-shot. longer files are loops only if the detector finds a solid tempo **and** 4+ onsets in the first 8 s (a phrase, not one held note): 99% of files your words call loops have that many, 76% of one-shots fewer. right-click to set it yourself.

★ favourites: click the star on a row (or press F) and tick "favourites" to see only those. they get a gold ring on the map.

## preview
the strip above the status line shows what's playing with its waveform: click it to play from there. volume slider on the right. space plays/stops, enter plays from the top, esc stops. dragging something out stops the preview.

auto-play: clicking or arrowing to a sample plays it. loops loop, one-shots play once. lock bpm ___: loops play stretched to that tempo, pitch stays (signalsmith stretch, 240 ms blocks so bass stays in tune). arrowing to the next loop while one plays picks up on the same beat. ½× / 2× next to it halves or doubles the bpm of the selected loops, for a tempo detected at double or half.

lock key: loops get transposed to that key. minor loops go to the key, major loops to its relative major (lock E min: A min → E min, C maj → G maj). always the smallest shift, never more than 6 semitones. tempo and key change in one pass. drums only get the tempo. vocals keep their formants. loops with no key, or no major/minor, play as is with a badge. a guessed key (`?`) plays as is with an "as is" badge until you confirm or fix it (double-click the key). right-click: set major / minor, transpose / never transpose / let the app decide.

one-shots show a note (like "C note"), not a key.

## cleanup
folders → "remove samples not in these folders" drops everything outside your scan folders (unticked ones still count as yours). "clear shelf" wipes everything. select rows + delete removes those. removing only ever deletes the wav copies this app made, never your originals. sort by "added" to grab a batch.

## search
`kick` `-vocal` `bpm:120` `bpm:120-128` `bpm:>140` `key:Am` `key:F#` `scale:minor` `tag:dark` `ext:audioloop` `len:<2`

## keys
space play/stop · enter from the top · esc stop · arrows / page up/down / home / end move · T tag selected · F star selected · double-click bpm/key to fix · alt-click tag to remove · drag rows into your DAW · right-click: show in explorer, loop/one-shot, set major/minor, transposing, remove · delete removes selected

words used in the app: see GLOSSARY.md
