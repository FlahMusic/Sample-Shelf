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
- bpm/key: file tags, then file name, then (key only) folder name, then auto-detect. detected values show in italics, ones you set show bold pink
- keys in names: `Am`, `F#m`, `C minor`, `Eb_Maj`, `KeyOfEm`, `Key of Bb`. a bare capital M isn't read as major (that's FM / AM synth names)
- no auto-detect on files under 1.5s (one-shots)
- rescans only touch new or changed files

## can't decode
.rx2 / .rex / .rcy, .soundx, .ncw — proprietary, ffmpeg can't read them. scan reports how many it skipped.

## filters
loops / one-shots checkboxes, pick any number of keys, bpm min–max. they all stack with the search box.

loop vs one-shot: closest "loop" / "one shot" / "hit" word in the name or folders wins, then studio one loop files and tempo tags count as loops, then anything under 2s is a one-shot. longer files are loops if the detector found a solid tempo. right-click to set it yourself.

## preview
auto-play: clicking or arrowing to a sample plays it. loops loop, one-shots play once. sync to ___ bpm: loops play stretched to that tempo, pitch stays (signalsmith stretch). arrowing to the next loop while one plays picks up on the same beat.

lock key: loops play moved to that key. minor loops go to the key, major loops to its relative major (lock E min: A min → E min, C maj → G maj). always the smallest move, never more than 6 semitones. tempo and key change in one pass. drums only get the tempo. vocals keep their formants. loops with no key, or no major/minor, play as is with a badge. a detected key still gets moved, but it's a guess (italic). right-click: transpose / never transpose / let the app decide.

## cleanup
folders → "remove files not in these folders" drops everything outside your scan folders (unticked ones still count as yours). "clear shelf" wipes everything. select rows + delete removes those. removing only ever deletes the wav copies this app made, never your originals. sort by "added" to grab a batch.

## search
`kick` `-vocal` `bpm:120` `bpm:120-128` `bpm:>140` `key:Am` `key:F#` `scale:minor` `tag:dark` `ext:audioloop` `len:<2`

## keys
space play · arrows move · T tag selected · double-click bpm/key to fix · alt-click tag to remove · drag rows into your DAW · right-click: show in explorer, loop/one-shot, remove · delete removes selected
