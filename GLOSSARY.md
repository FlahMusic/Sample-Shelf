# sample shelf

An app that gathers flah's samples from the folders he points it at, keeps them findable by bpm, key and kind, and lets him preview and drag them into his DAW in his song's tempo and key.

## The shelf

**Shelf**:
Everything the app knows about, across all scan folders.
_Avoid_: library, database, collection

**Sample**:
One piece of audio on the shelf. The same audio found in two places is one sample.
_Avoid_: file, record, entry

**File**:
Something on disk. Only ever means the thing on disk, never the sample.

**Original**:
A file a sample was found as. The app never changes or deletes it.
_Avoid_: source

**Wav copy**:
A wav the app writes for a sample whose original isn't a wav.
_Avoid_: converted file, cache

**Scan folder**:
A folder or whole drive the app looks through for samples.
_Avoid_: root, source folder

**Unticked**:
A scan folder whose samples are hidden and which scans skip. Nothing is deleted; ticking it brings them back.
_Avoid_: hidden, disabled

**Skipped**:
A folder inside a scan folder that you unticked in the check. Scans never go in it and nothing in it gets a wav copy. Its samples count as outside your scan folders.
_Avoid_: excluded, ignored

**Check**:
The look a scan takes first: what is new under each folder and how much room its wav copies would take. Nothing is converted.
_Avoid_: survey, estimate

**Folder**:
The folder a file sits in.

**Tree**:
The folders on the left. Picking one shows only what is in it and the folders inside it. Samples outside every scan folder hang off their drive.
_Avoid_: browser, explorer

**Library folder**:
Where the app writes wav copies and processed copies.
_Avoid_: output folder

**Remove**:
Take samples off the shelf. Their wav copies are deleted; originals never are.
_Avoid_: delete

## What a sample is

**Kind**:
Whether a sample is a loop or a one-shot.
_Avoid_: type

**Loop**:
A phrase meant to repeat in time, with a bpm. At least a bar long, so never under 1 s.

**One-shot**:
A single hit or note (or a held sound), played once.
_Avoid_: hit, shot

**Even volume**:
Playing every sample at about the same loudness while previewing. It never changes the file or what gets dragged out.
_Avoid_: normalise

**Favourite**:
A sample you starred.
_Avoid_: shortlist, like

**Sound**:
What a sample sounds like: kick, snare, hat, perc, bass, keys, vocal, fx.
_Avoid_: type, category

**Drum**:
A sample whose sound is percussion. Drums are never transposed.

**Key**:
A loop's root and scale, e.g. E minor.

**Scale**:
Major or minor.
_Avoid_: mode, quality

**Note**:
The pitch of a one-shot, with no scale. A folder's key never becomes a one-shot's note.
_Avoid_: key (for one-shots)

**Guess**:
A key, note, bpm or sound that wasn't stated in the file name, its tags or by flah: detected, or taken from the folder name. Shown with a "?". A loop with a guessed key isn't transposed.
_Avoid_: auto

**Stated**:
Written in the file name or tags, or set by flah. The opposite of a guess.

**Confirm**:
Accept or fix a guessed key, which makes it count as set by you.

## Locking to a song

Names follow other sample browsers (Loopcloud's key lock and sync, ADSR Sample Manager's raw or processed drag), so anyone who knows music software reads them right.

**BPM sync**:
Loops play (and drag out, with drag processed on) at one tempo.
_Avoid_: bpm lock, lock bpm

**Key lock**:
Loops get transposed to one key and play (and drag out, with drag processed on) in it.
_Avoid_: lock key

**Lock**:
Only in code (prefs.sync, prefs.lockKey). In the app it's bpm sync and key lock.

**Transpose**:
Move a loop's pitch so it fits the key lock: minor loops to the locked key, major loops to its relative major (and the mirror for a major lock).
_Avoid_: shift (as a verb), move

**Shift**:
The number of semitones a loop is transposed by, from −6 to +5.

**Relative**:
The major and minor keys that share the same notes, e.g. E minor and G major. They get the same shift.

**Drag processed**:
The checkbox for what a loop drags out as when bpm sync or key lock is on: ticked = its processed copy, unticked = the original (raw) file.

**Processed copy**:
A loop rendered with bpm sync and key lock applied, by the same stretcher you hear, as a 32-bit float wav in the library folder's `_processed`. Made in the background when you pick the loop, so the drag starts straight away.
_Avoid_: locked copy, rendered copy

**Key in name**:
A sample whose key (or note) is stated. On the map these shine brighter; the filter of the same name shows only them.

## The map

**Map**:
The 3d view where every shown sample is a dot, placed near samples that sound alike across the floor, with high sounds up top and low ones at the bottom. The other view is the list.

**High / low**:
How high a sample sounds: the centre of its spectrum (spectral centroid). The map's height.
_Avoid_: brightness, pitch (that's a note)

**Anchor**:
The sample the side list is built around: the dot last clicked.
_Avoid_: seed, centre

**Similar**:
The samples that sound most like the anchor, nearest first. Lines go from the anchor to them, the closest brightest.

**Matches**:
Loops that would play together with an anchor loop, best first by semitones off plus tempo off. Tempo counts in the same units: a 6% stretch is about 1. Without bpm sync the bpm has to be within 6% (or half / double).
_Avoid_: compatible, fits with

**Semitones off**:
How far a sample's key is from the key the anchor plays in. 0 = the same key or its relative. Landing a fifth away (next on the camelot wheel) works too, for half a step more. Under the key lock, what the lock moves a loop by counts as well.

**Max shift**:
The most semitones off a key can be and still show in similar or matches. 0..3, or any key (which also lets in samples without a key).
_Avoid_: key range, tolerance

**Solo**:
Only the anchor and its list on the map, laid out as a star chart round the anchor.
_Avoid_: focus, isolate

**Star chart**:
Solo's layout. Round the wheel = the key's place on the camelot wheel, the anchor's key straight ahead. Further out = further off (matches: semitones + tempo, rings at 1, 2, 3, 4; similar: sound distance). Height = high / low. Lines = the shortest tree joining them.

**Sweep**:
Dragging across dots so each one plays as the pointer reaches it.

**History**:
The samples played so far, in order, to step back and forward through.

## Setups

**Setup**:
Folders (ticked scan folders and folders picked in the tree), filters, search, bpm sync and key lock saved under a name, loaded from the top left. One with fewer folders gets its own map, laid out over just its samples.
_Avoid_: preset, profile, workspace

**Whole shelf**:
No setup: every scan folder ticked, nothing picked or filtered.

## First run

**Guide**:
The steps shown on start: pick folders, scan, the progress bar, the map. "hide guide" keeps it off; help has "show the guide".
_Avoid_: tutorial, onboarding

**Progress bar**:
The orange bar at the bottom while it scans or generates the map, with % and time left.
