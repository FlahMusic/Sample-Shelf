# handoff: audio engine, sound map, audition, key/bpm lock, daw sync

for claude code. read this whole file first (and `CLAUDE.md` for how flah works), then ask flah the **ask flah** questions before building those parts. each one has a suggested default.

## what flah wants (his words, cleaned up)
1. **switch between views:** a toggle up top between the list we have now and a map view. same filters, search, selection and preview settings in both.
2. **map view:** sounds placed by how they sound (option 3 in `docs/map-examples.html`). loops that fit by key + bpm get linked.
3. **arrow through "circles" of similar loops:** pick a loop, then up/down steps through the most similar sounds, nearest first. each one plays right away at the locked bpm (and key, see 5), so he can swap loops fast in the song's tempo.
4. **drag and drop is the whole point:** whatever's selected, in list or map, drags straight into the daw as a wav. one or many.
5. **key + bpm lock:** e.g. lock 128 bpm + E minor. every loop still shows, but plays (and drags) stretched to 128 and transposed: minor loops to E minor, major loops to the relative major (G major).
6. **better stretch quality:** he picked **signalsmith stretch** over the current chromium stretch.
7. **daw sync if it's not a ridiculous amount of work.** otherwise typing the bpm up top is fine. optional, do last.
8. **new look:** pastel colours like his own slimehedron site, and chunkier popover menus (folder picker etc.) like the menus in aria labs' upcycle. see section 0.

## what we're after vs XO (so you know the target)
XO (XLN Audio) is the reference flah likes for the map feel. sources: XLN support "interface overview", musicradar review, attack magazine review, everything recording review (links at the bottom).

**how XO's map works (as documented):**
- it "identifies one-shot drum samples" and lays them out by similarity (XLN support). musicradar says the layout uses t-SNE.
- dots are coloured by instrument type (e.g. red kicks, blue snares). zoomable, scrollable.
- **drag-to-sweep:** holding and dragging the pointer plays and selects every dot it passes over (musicradar). that's the main way you browse.
- **similarity list:** the closest-sounding samples to the selected one (musicradar says 15). left/right steps through it, shift jumps 5, up/down goes back through recently played history, and "refresh" rebuilds it around the current sample (XLN support).
- **kit similarity:** left/right moves all 8 slots' lists at once, swapping the whole kit for similar sounds. hot-swap works while the beat plays.
- filters: name, type, folder, plus frequency, length and "drumminess" sliders (musicradar; XLN's page confirms length and favourites). any filter change updates the map and the lists.
- none of the sources mention key or bpm detection, loops, or tempo-stretching. it's built around drum one-shots.

**XO's weak spots (per reviews):** search/filter can pause for a few seconds, the filter pop-up gets in the way, 8 slots only, 16-step A/B patterns only, no batch stem export (musicradar, everything recording).

**where sample shelf should be stronger:**
- loops **and** one-shots, every format he has (incl. studio one loop files), in one place.
- key + bpm + scale on everything, with a key/bpm **lock** that stretches and transposes to his song. XO doesn't do this, and it's the core reason this app exists.
- drag-out of plain wavs (rendered in key/tempo when locked) into any daw. free, his own.
- fast filtering. don't repeat XO's multi-second pauses: filter in memory, redraw the canvas only.

**where we're weaker (be honest with flah about these):**
- no proven sound analysis yet. XO's type detection is praised in reviews ("very impressive", musicradar). ours is basic MFCC + umap and has only been tested on synthetic sounds. measure it on his library.
- no sequencer or kit (that's the optional last pass).
- standalone app, not a plugin. no host sync except the optional MIDI-clock tempo follow.
- first analysis of a big library takes minutes (prototype timings above).

**steal these XO ideas (fold into sections 3–4):**
- **drag-to-sweep audition on the map.** this clashes with "drag a dot = drag-out to daw". **ask flah** which gets the plain drag. suggestion: plain drag on the map = sweep (like XO); drag-out from the selected dot with ctrl held, or from the list/selection strip. pick one and make it obvious.
- **history:** back/forward through recently auditioned sounds.
- **refresh:** rebuild the similarity list around the current sound (same as making it the new anchor).
- **shift + up/down jumps 5.** note: flah asked for **up/down** to step through similar sounds, so keep that. use left/right for history (the reverse of XO). **confirm with flah.**
- extra filters later: length (already), plus a "tonal ↔ noisy" slider (e.g. from spectral flatness), similar to XO's drumminess.

## what sample shelf is today
electron 44 app in `C:\flah plugins\sample shelf`. scans folders the user picks, converts any non-wav to wav copies in a library folder (ffmpeg-static), reads bpm/key from tags → file name → auto-detect (essentia.js), lists everything with search, filters (loops/one-shots, several keys, bpm range), tags, preview (auto-play, "sync to ___ bpm" via `<audio>` `playbackRate` + `preservesPitch`), and native drag-out (`webContents.startDrag`).

record fields: `id, path, name, folder, ext, size, mtime, qhash, wav, duration, sampleRate, channels, bpm, bpmSrc, key, scale, keySrc, acidOneShot, tags[], kindUser, added, error`.

## facts already checked (with sources)
- **chromium's built-in stretch** (current preview) is WSOLA and mutes extreme rates (chromium `media/filters/audio_renderer_algorithm.h`). fine for small nudges, smears on big ones.
- **signalsmith stretch web:** npm `signalsmith-stretch` 1.3.2 (published 2025-06-27), MIT licence (qt's attribution page). official web release using WASM + AudioWorklet, ships `.js` (UMD) and `.mjs`. api per its README (**verify against the installed package**):
  - `SignalsmithStretch(audioContext, ?channelOptions)` → Promise of an AudioNode with extra methods
  - `addBuffers([chan0Float32, chan1Float32])`, `dropBuffers()`, `start(?when)`, `stop(?when)`, `latency()`, `configure({blockMs, intervalMs, splitComputation, preset: 'default'|'cheaper'})`, `setUpdateInterval(seconds, cb)`
  - `schedule({ active, input, output, rate, semitones, tonalityHz, formantSemitones, formantCompensation, formantBaseHz, loopStart, loopEnd })`. `output` is in audio-context time and the node compensates for its own latency, so schedule a little ahead. `loopStart`/`loopEnd` loop a section of the input.
- **ffmpeg on flah's pc** (`node_modules/ffmpeg-static/ffmpeg.exe`) contains librubberband (grepped on his machine). ffmpeg's rubberband filter has no engine option and "Finer" isn't in the binary, so it's rubber band's older R2 engine. only a fallback now.
- **rubber band R3** is "substantially higher-quality" than R2, at higher cpu (v3.0.0 announcement). not used unless signalsmith export fails.
- **sound map prototype** (`docs/sound-map-prototype.js`, in the cloud on linux): essentia.js 0.1.3 MFCC + centroid + zcr mean/std (31 numbers) → z-score → umap-js 1.4.0. 100% same-type neighbours on 115 synthetic sounds (**easy case**). ~50 ms per one-shot, ~425 ms per loop (first 3 s). exact essentia call signatures are in the file. delete every essentia vector or wasm leaks.
- **studio pro MIDI clock:** sent to "external instruments" (Options → External Devices, MIDI Clock checkbox), per the fender studio pro manual "set up your midi devices".
- **windows 11 midi services** has built-in loopback ports that work for MIDI 1.0/2.0 apps including web midi. rolling out in phases to retail windows 11, so it may not be on his pc yet (microsoft windows experience blog, 2026-02-17). fallback: loopMIDI (free).
- no evidence studio one / studio pro supports ableton link.
- studio pro fills a clip's "file tempo" automatically when it can read a tempo from the file. sound on sound's example is studio one's own audioloop. nothing found on acid wav tempo, so pre-rendered wavs are the safe way to land in tempo.

## spec

### 0. look + menus
the current ui is dark grey. flah wants it pastel, using **his own** slimehedron site (https://flahmusic.github.io/Slimehedron/) as the colour source, with menus that work like the popover menus in upcycle (https://arialabs.io/upcycle, first screenshot "Folders").

**colours and shapes: copy these from slimehedron's live css** (read from the site on 2026-10-29; they're flah's own design, safe to reuse):
```css
--bg1:#e3d4ff; --bg2:#c4f0e2; --bg3:#ffd3e7; --bg4:#cfe2ff; --bg5:#fff0cf;
--ink:#463b66; --ink-soft:#73619f; --accent:#b388f0;
--mint:#9fe6cf; --lav:#c4a9f5; --peach:#ffc0a8; --sky:#a6c8ff; --pink:#ffb6d6; --yellow:#ffe39c;
--card:rgba(240,232,253,.80); --card-brd:rgba(255,255,255,.62); --panel-solid:#ece4fa;
--panel:linear-gradient(180deg,rgba(245,239,254,.97),rgba(231,221,249,.97));
--cream:linear-gradient(180deg,#fefcff 0%,#f3ecfd 52%,#e6dbf8 100%);
--ring:rgba(160,150,200,.45); --edge:rgba(98,72,156,.40); --lip:rgba(255,255,255,.92);
--radius:clamp(10px, 8px + 0.6vmin, 18px);
--shadow:0 14px 34px rgba(54,36,104,.30);
--depth:0 4px 0 var(--edge), 0 8px 16px rgba(54,36,104,.22), inset 0 2px 1px var(--lip), inset 0 -4px 8px rgba(110,80,170,.16);
--depthUp:0 6px 0 var(--edge), 0 12px 22px rgba(54,36,104,.26), inset 0 2px 1px var(--lip), inset 0 -4px 8px rgba(110,80,170,.16);
--depthIn:0 1px 0 var(--edge), 0 2px 5px rgba(54,36,104,.24), inset 0 3px 7px rgba(110,80,170,.26);
```
- font: slimehedron uses **Quicksand** (google font, SIL open font licence). bundle the font file in the app so it works offline. no cdn.
- buttons/cards: pastel fill, `--depth` shadow, `--depthUp` on hover, `--depthIn` when pressed or on. rounded `--radius`. text in `--ink`.
- colour jobs (suggested, **ask flah**): loops = mint, one-shots = peach; map types kick = pink, snare = peach, hat = sky, perc = yellow, loop = mint, vocal = lav; selection = lav tint; playing = accent. the key/bpm lock bar gets its own tint so it's obvious when it's on.
- **contrast:** body text must hit at least 4.5:1 against what it sits on. check every text/background pair (`--ink-soft` on the lighter pastels especially) and darken the text, not the pastel, if it fails.
- auto/guess values (detected bpm/key) still need to look different from tagged ones. use `--ink-soft` or italics, not grey on pastel.

**menus, the upcycle-style part:** take the interaction, not the art. upcycle's menus are popovers anchored to a big button, with a clear title, a checklist, and one big action at the bottom. apply that to:
- **folders popover** (replaces the current folders panel): title "folders". each row = a checkbox (include/exclude), folder name, the path or status under it ("scanning…", "1,204 files"), and a trash icon to remove it. "enable all" button top right. big "add folder or drive" button at the bottom. **ask flah:** should unticking a folder just hide its files from the list/map without deleting anything? suggest yes. that's a new per-folder `enabled` flag in the db, and scans skip disabled folders.
- **bottom status strip:** counts like "7,053 / 15,027 in selected folders · 372,349 total".
- the same popover style for the key picker, the lock settings and help.
- **don't copy** upcycle's wordmark, illustrations, folder-shaped button art, thick black cartoon outlines or exact layout. sample shelf should look like flah's stuff (slimehedron), not like upcycle. don't describe it as a version of upcycle anywhere, in ui copy or docs.

**ask flah before building:**
- light pastel only, or keep a dark mode toggle? (suggest: light only, simplest)
- app name: the claude project is now called "SAMPLIT". rename the app (window title, header, package `productName`) or keep "sample shelf"?
- does he want any of his hand-drawn slimehedron art (slime character, crayon sky) in the app? **never** swap his hand-drawn art for flat vector stand-ins. use his actual art files or none.

**test:** screenshot the list, the map, the folders popover and the lock bar, show flah, and check contrast. make sure nothing got harder to read than the current dark ui (he already complained once that the dark one was too hard to read).

### 1. audio engine → signalsmith (do this first, everything else sits on it)
- `npm install signalsmith-stretch@1.3.2` (pin the version).
- replace the `<audio>` preview in `renderer/app.js` with web audio: one `AudioContext`, decode the selected `rec.wav` (`decodeAudioData`), `addBuffers` per channel, then `schedule({ active: true, rate, semitones, loopStart, loopEnd })`.
  - getting the bytes: either `fetch(fileUrl)` (the CSP in `renderer/index.html` will need `connect-src file:`) or have main read the file and send an ArrayBuffer over ipc. pick whichever works cleanly with `sandbox: true` and say which.
  - loading the worklet in electron from a `file://` page: check how the package loads its AudioWorklet module (inline blob vs separate file) and make it work with the current CSP. **flag what you changed.**
- `rate = lockBpm / rec.bpm` for loops with a bpm when bpm lock is on, else 1. `semitones` from the key lock (section 5), else 0. one-shots: rate 1.
- loops loop while auditioning; one-shots play once.
- **in-time swap:** when stepping to the next loop while one plays, start the new one at the same beat position: `beats = inputPos * old.bpm / 60`, `newInput = (beats % newBeats) * 60 / new.bpm`, using `schedule({ input, output })` a short time ahead. keep two nodes and switch between them so there's no gap.
- delete the old `playbackRate` / `preservesPitch` code once this works. don't leave two engines.
- **test:** stretch a loop 124 → 128 and 124 → 90, transpose ±5. compare by ear against the current chromium preview and tell flah honestly how it sounds. check cpu on his laptop (MSI GE76, i7-12700H) while arrowing quickly. try `preset: 'cheaper'` only if it struggles.

### 2. list / map toggle
- two-option toggle in the header: `list` · `map`. remember the last one.
- both views read the same filtered/sorted records and the same selection. selecting in one shows in the other.
- keyboard, auto-play, lock settings and drag-out behave the same in both.

### 3. map
- **features:** compute in `lib/worker.js` after conversion, from `rec.wav` decoded by ffmpeg to mono f32 44.1k (the decode pattern is already in `detect()`). cap at 3 s. store `rec.feat` (4 decimals). only recompute when the file changes. one-time backfill for existing records, with progress.
- **positions:** z-score + umap over all records with `feat`, in a worker thread, seeded rng. store `rec.mx, rec.my`. "rebuild map" button. until the next rebuild, put new points at the average position of their nearest neighbours (umap-js can't place new points onto an existing map). tell flah.
- **types / colours:** name/folder words first (kick, bd, snare, sd, clap, hat, hh, ride, crash, perc, tom, 808, bass, keys, vox/vocal, fx; loops via `lib/classify.js`), then label the rest by majority vote of their k nearest labeled neighbours in feature space. **report accuracy on flah's library.**
- **drawing:** canvas 2D. wheel = zoom, drag empty space = pan, quadtree/grid hit testing, hover = name · bpm · key. drag a **dot** = native drag-out. keep that separate from panning.
- **links:** selected loop → lines to loops that fit by key + bpm (section 7 rules). when the key lock is on every loop gets transposed to fit, so key links are moot. **ask flah:** with the lock on, show links by bpm only, or hide them?

### 4. "circles" audition
- selecting anything makes it the **anchor**. its neighbours come from **feature space** (not 2D map distance), nearest first.
- **up/down** steps through that neighbour list: selects it, plays it (if auto-play is on, through the engine with the current lock), highlights it on the map. the anchor stays put.
- draw rings around the anchor on the map (nearest 8 / 16 / 32) so "circles" is literal.
- **enter** or clicking a dot = new anchor.
- **ask flah:** should the neighbour list only include loops that fit by key + bpm? suggest a checkbox "only matching key", default **off** (with the key lock on, everything fits anyway).
- **ask flah:** does he want the same up/down-through-similar in the list view, or only on the map?

### 5. key + bpm lock (transpose lock)
ui: up top, next to the bpm box: `lock key` checkbox + a key picker (12 roots × major/minor). the existing "sync to ___ bpm" becomes the bpm half of the lock.

rules:
- target minor key T (e.g. E minor). minor loops → T. major loops → T's **relative major** (E minor → G major). if he locks a major key, it's the mirror: major → that key, minor → its relative minor.
- shift = (targetRoot − loopRoot) mod 12, mapped to the range −6..+5 (smallest move; A minor → E minor is −5, not +7). quality drops the further it moves.
- **useful property:** a key and its relative get the same shift (C major → G major = −5, A minor → E minor = −5). so the common detection mix-up between relative major/minor does no harm. a key that's wrong by a fifth still does.
- stretch and transpose in **one** pass (`rate` + `semitones` together), never two.
- `formantCompensation: true` for vocals (anything tagged or labeled vox/vocal), so shifted vocals don't go chipmunk. **verify** it sounds right on a real vocal chop.
- **don't transpose drums.** drum loops (words: drum, beat, top, perc, hat, kick, break, groove; or map type) get tempo only. drum one-shots (kick, snare, hat, clap, perc, cymbal) get nothing. right-click override per file. **ask flah** to confirm the default (suggest: drums never transpose).
- **pitched one-shots** (808, bass, keys/stab, synth, vocal chop): **ask flah** whether they should be tuned to the lock key's root, or just get their note tagged. if tuning: detect the note with essentia (pick a pitch algorithm, e.g. yin-family, and **verify on real 808s**, since sub-heavy one-shots are hard), then shift to the nearest root. if tagging: show the note, no shift.
- **mode, ask flah:** `exact` = everything goes to the target key or its relative. `gentle` = leave loops already in a key that blends (same, relative, ±1 on the camelot wheel) and only shift the ones that clash, which means fewer artifacts. suggest default **exact**, since that's what he described.
- **no key** on a loop: leave it alone, show a "no key" badge. **auto-detected** key (`keySrc === 'auto'`): still shift, but mark it so he knows it's a guess.
- list/map show `A min → E min · −5` on shifted rows.

### 6. drag-out (must be rock solid)
- from list rows and map dots, single or multi-select, same `ipcMain.on('drag')` → `startDrag({ file, files, icon })`.
- **when bpm or key lock is on, drag a rendered copy at the locked bpm/key** (flah asked for it to stay stretched).
  - render with the **same signalsmith engine** in an `OfflineAudioContext`, so what he drags is what he heard. **verify** the package's worklet runs in an OfflineAudioContext in electron 44. if it doesn't, fall back to ffmpeg `rubberband=tempo=..:pitch=2^(semitones/12)` (R2, so lower quality) and **tell flah**.
  - write the wav in main: same sample rate and channels as the source, 24-bit, to `<libDir>/_rendered/<name> [<key> <bpm>bpm].wav`. reuse it if it already exists.
  - **drag has to start instantly.** you can't render inside `dragstart`, so pre-render the selected file(s) in the background on select while a lock is on. if a render isn't ready, drag the original and show one line: "locked copy not ready, dragged original".
  - "clear shelf" and remove must delete `_rendered` copies too.
- **test in studio pro 8 on his pc:** drag 1 loop, 3 loops at once, a one-shot, a map dot, and a locked copy onto tracks and onto empty space. check they land as audio, right length, right key. **this has never been tested.**

### 7. key + bpm match rules (links, "only matching key", gentle mode)
- camelot: minor 1A..12A = Abm Ebm Bbm Fm Cm Gm Dm Am Em Bm F#m C#m; major 1B..12B = B F# Db Ab Eb Bb F C G D A E (normalise spellings with `lib/keys.js`, e.g. Db = C#).
- match = same key, same number other letter (relative), or ±1 number same letter (12 wraps to 1). source: mixedinkey.com/workflows/how-to-use-the-camelot-wheel/
- bpm: within a tolerance % (slider, default 6% — **flah's call, that number is a guess**), optional half/double time (mixgraph.io/learn/bpm-guide).

### 8. daw sync (optional, do last)
- **cheapest:** typing the bpm (already there).
- **suggested, moderate work:** follow studio pro's tempo via MIDI clock. studio pro → external instrument with MIDI Clock ticked → windows midi services loopback (or loopMIDI) → electron web midi (`navigator.requestMIDIAccess()`, allow `midi` in `session.setPermissionRequestHandler`). clock `0xF8` = 24 per quarter note → bpm = 60000 / (avg ms per tick × 24), averaged over 1–2 beats. "follow daw" checkbox makes the bpm box read-only and live.
  - **unknowns to test:** whether studio pro sends clock while stopped or only while playing, how much the averaged tempo jitters, and whether chromium's web midi sees the loopback port on his windows build.
  - tempo only. don't sync previews to studio pro's transport this round.
- **skip:** ableton link (no support found). **not now:** a JUCE VST3 version (flah has JUCE + VS 2022 + CMake in `C:\flah plugins`, but it's basically a second app).

## pass 1 status (2026-10-29): built, measured, not yet ear-tested by flah
- `signalsmith-stretch` 1.3.2 installed, pinned. `<audio>` / `playbackRate` / `preservesPitch` code is gone.
- bytes: main reads the wav (`read-audio` ipc, only wavs on the shelf) → `decodeAudioData`. `fetch` can't do `file://` in chromium, and the sandboxed preload has no fs.
- worklet: package defaults to a `blob:` url. we set `SignalsmithStretch.moduleUrl` to the package file instead, so csp only gained `script-src 'self' 'wasm-unsafe-eval'` (wasm is inlined base64, compiled in the worklet). `media-src file:` dropped.
- api gotcha (from the package source): every `schedule()` deletes all segments scheduled after `currentTime`. so you can't queue start + stop on one node. one-shots get stopped by a js timer.
- lead: `latency()` = input + output, 0.12 s on default preset. measured: half of it (+10 ms) starts sounds with nothing cut off. `cheaper` preset has *higher* latency (0.14 s), so default stays.
- measured on flah's pc (muted capture): pitch holds at 440 Hz stretched 124→128 and →90. ±5 st lands within ~5 cents. tempo right. in-time swap within ±6 ms of the grid. arrowing 60 real loops at 150 ms each with stretching: ui stalls ≤10 ms, 2–4% of total cpu, ~1% holding one loop, ~0 after 5 s idle (context suspends).
- full songs (2–5 min wavs, 40–60 MB) take 0.3–0.8 s to start (read + decode whole file). short samples 20–100 ms. streaming via repeated `addBuffers` would fix it; not built.
- `OfflineAudioContext` + the worklet works in electron 44 (renders 7–10 s in ~0.2 s). output can overshoot 0 dBFS slightly, so pass 4 should write float or leave headroom. start alignment offline not checked yet.
- the stretcher isn't transparent at rate 1 (kick attack peak −1 dB, ~40 ms extra tail). if flah hears it on one-shots, bypass it when rate 1 + 0 st.
- how it was tested: launch `electron.exe . --remote-debugging-port=9333`, run page scripts over CDP `Runtime.evaluate` (app.js top-level `let`s like `live`, `decks`, `ctx` are reachable), capture deck output through a ScriptProcessor into a muted gain. note: an occluded window gets 1 s timer throttling, which wrecks timing tests; bring the window to front.

## decisions from flah (2026-11-02, all suggested answers accepted)
short form of q1–q31 from the grilling rounds:
- engine: keep signalsmith default preset (pending his ear test). bypass the stretcher at rate 1 with no transpose (done). full-song start delay ok for now. in-time swap only with sync on.
- look: light pastel only. name stays "sample shelf". his art: `slimelogo.png` in the header, `minis/violet.png` on the empty screen (copied into `renderer/art/`). colours as section 0 suggests.
- folders: untick = hide, scans skip it, cleanup treats unticked as still his. trash = remove the folder and its files (confirm). "scan all drives" dropped (add `C:\` as a folder). wav-copies path, prune and clear shelf sit quietly under the big add button.
- header: no list|map toggle until pass 5.
- key lock: drums never transpose (right-click override). pitched one-shots show the note only (italic, "note" label), no tuning yet. exact mode. fix "KeyOfEm"-style name parsing in pass 3.
- drag-out: locked copies as 32-bit float wavs (the stretcher overshoots 0 dBFS slightly).
- map: plain drag = sweep (plays everything it passes, newest cuts the last), ctrl+drag a dot = drag-out. up/down = similar (shift = 5), left/right = history. circles on the map only. "only matching key" default off. links are bpm-only while key-locked. bpm tolerance 6% + half/double time.
- later: midi-clock tempo last and optional. no step sequencer. pass order as below.

## pass 2 status (2026-11-02): built, screenshot-checked, not yet seen by flah
- stretcher bypass: plain `AudioBufferSourceNode` on the same deck when rate is 1. one-shots start in ~19 ms (was ~70), kick attack exact. switching plain ↔ stretched mid-loop (sync tick) stays on the beat. plain → stretched in-time swap within ±5 ms.
- look: quicksand bundled (`renderer/fonts/`, OFL.txt alongside, unicode ranges copied from google fonts' css). slimehedron tokens in `style.css`. **`--ink-soft` fails 4.5:1 on most pastels** (2.6–4.4), so secondary text uses `--soft: #63548b` (worst case 4.76, 6.3 on the list sheet). every text/surface pair checked with alpha compositing. still lower contrast than the old dark ui's dim text (~10:1), but passes AA everywhere.
- folders: `db.hidden` = unticked roots. the most specific root wins (an unticked subfolder inside a ticked one stays hidden). status strip: "x shown · y on the shelf · z in unticked folders", deduped by qhash. tested in a throwaway profile (`--user-data-dir` works in electron 44).
- test gotcha: bash heredocs on this machine collapse `\\` to `\`. write page scripts that contain windows paths with the file tool, not a heredoc.

## suggested passes (one at a time, check in with flah after each)
1. signalsmith engine swap in the existing list view (section 1)
2. new look + folders popover + status strip (section 0). early, so everything after is built in the new style
3. key + bpm lock + transpose rules (section 5), list view only
4. locked drag-out + studio pro drag tests (section 6)
5. list/map toggle + features + backfill + map drawing + dot drag (sections 2–3)
6. circles audition (section 4)
7. type labels/colours + accuracy check + key/bpm links (sections 3, 7)
8. optional: MIDI-clock tempo follow (section 8)
9. later, only if flah wants it: XO-style 8-lane step sequencer with kit hot-swap and MIDI drag-out

## reference links
- XO: https://support.xlnaudio.com/hc/en-us/articles/16920363887645-Interface-Overview · https://www.musicradar.com/reviews/xln-audio-xo · https://www.attackmagazine.com/reviews/gear-software/xln-audio-xo/ · https://everythingrecording.com/review-xln-audio-xo/
- upcycle (menu reference only): https://arialabs.io/upcycle
- slimehedron (colour source, flah's own): https://flahmusic.github.io/Slimehedron/

## still unverified from earlier passes
- real studio one `.audioloop` / `.musicloop` internals. the code treats them as zips (per sound on sound) and reads `tempo="..."` from xml. never checked against a real file, and key isn't read from them. ask flah for one of each.
- `.rx2/.rex/.rcy`, `.soundx`, `.ncw` are skipped (ffmpeg can't decode them).
- windows-specific paths (drive letters, long paths, junction skipping) only tested on linux.
