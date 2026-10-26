# sample shelf

finds every audio file on your drives, converts anything that isn't a wav into a wav, and lists them all in one place sorted by bpm / key / length.

## run it
double-click `start.bat`. first run installs stuff (needs node.js from nodejs.org).

## what it does
- scans every drive (skips Windows, recycle bin, system folders)
- plain wavs stay where they are. everything else gets converted into the library folder you pick
- conversion keeps sample rate, channels and bit depth. lossy files (mp3/ogg/aac) come out 24-bit
- studio one .audioloop / .musicloop: audio gets pulled out of the loop file, tempo kept
- bpm/key: file tags, then file name, then auto-detect. auto values show dim, ones you set show orange
- no auto-detect on files under 1.5s (one-shots)
- rescans only touch new or changed files

## can't decode
.rx2 / .rex / .rcy, .soundx, .ncw — proprietary, ffmpeg can't read them. scan reports how many it skipped.

## search
`kick` `-vocal` `bpm:120` `bpm:120-128` `bpm:>140` `key:Am` `key:F#` `scale:minor` `tag:dark` `ext:audioloop` `len:<2`

## keys
space play · arrows move · T tag selected · double-click bpm/key to fix · alt-click tag to remove · drag rows into your DAW · right-click shows file in explorer
