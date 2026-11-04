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

**Folder**:
The folder a file sits in.

**Library folder**:
Where the app writes wav copies and locked copies.
_Avoid_: output folder

**Remove**:
Take samples off the shelf. Their wav copies are deleted; originals never are.
_Avoid_: delete

## What a sample is

**Kind**:
Whether a sample is a loop or a one-shot.
_Avoid_: type

**Loop**:
A sample meant to repeat in time, with a bpm.

**One-shot**:
A single hit or note, played once.
_Avoid_: hit, shot

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
The pitch of a one-shot, with no scale.
_Avoid_: key (for one-shots)

**Guess**:
A key or bpm the app detected that nobody has confirmed. A loop with a guessed key isn't transposed.
_Avoid_: auto

**Confirm**:
Accept or fix a guessed key, which makes it count as set by you.

## Locking to a song

**Lock**:
A bpm and/or key that every loop plays and drags in. Two halves: the bpm lock and the key lock.
_Avoid_: sync

**Transpose**:
Move a loop's pitch so it fits the key lock: minor loops to the locked key, major loops to its relative major (and the mirror for a major lock).
_Avoid_: shift (as a verb), move

**Shift**:
The number of semitones a loop is transposed by, from −6 to +5.

**Relative**:
The major and minor keys that share the same notes, e.g. E minor and G major. They get the same shift.

**Locked copy**:
A wav of a sample rendered in the lock's bpm and key, for dragging out.
_Avoid_: rendered copy

## The map

**Anchor**:
The sample whose similar sounds the circles are built around.
_Avoid_: seed, centre
