// loop vs one-shot. shared by main (node) and the window.
// order: your manual pick > closest name/folder word > studio one loop file / acid flag > tempo > length

const ONESHOT_RE = /one[\s_-]?shots?|\bhits?\b|\bshots?\b/i;
const LOOP_RE = /loops?\b/i;

function kindOf(r) {
  if (r.kindUser) return r.kindUser;
  // name first, then parent folder, then grandparent... closest label wins
  const parts = [r.name.replace(/\.[^.]+$/, '')].concat(String(r.folder).split(/[\\/]/).filter(Boolean).reverse().slice(0, 4));
  for (const p of parts) {
    const os = ONESHOT_RE.test(p);
    const lp = LOOP_RE.test(p);
    if (os && !lp) return 'oneshot';
    if (lp && !os) return 'loop';
  }
  if (r.ext === 'audioloop' || r.ext === 'musicloop') return 'loop';
  if (r.acidOneShot) return 'oneshot';
  if (r.bpmSrc === 'tag' || r.bpmSrc === 'name' || r.bpmSrc === 'user') return 'loop';
  if (r.duration != null && r.duration < 2) return 'oneshot';
  // longer files: rhythmic enough for the detector to trust a tempo = loop, otherwise one-shot
  return r.bpm ? 'loop' : 'oneshot';
}

// drums vs pitched, for the key lock (drums never get transposed). closest decisive word wins, like kindOf.
// "break", "groove", "fill", "beat" aren't decisive: on flah's shelf they're mostly bass loop names (song sections)
const word = (w) => new RegExp(`(?:^|[^a-z])(?:${w})(?![a-z])`, 'i');
const DRUM_RE = word('drums?|percussions?|percs?|hi-?hats?|hats?|kicks?|snares?|claps?|cymbals?|rides?|crash(?:es)?|toms?|shakers?|congas?|bongos?|tambourines?');
const PITCHED_RE = word('bass(?:es)?|subs?|808s?|keys|piano|synths?|pads?|leads?|chords?|guitars?|gtr|vocals?|vox|voices?|strings?|brass|melod(?:y|ies)|arps?|plucks?|bells?|choirs?|organs?|horns?|stabs?');
const VOCAL_RE = word('vocals?|vox|voices?|choirs?|sings?|singing|acapellas?|a cappellas?');
const parts = (r) => [r.name.replace(/\.[^.]+$/, '')].concat(String(r.folder).split(/[\\/]/).filter(Boolean).reverse().slice(0, 4));

function isDrum(r) {
  for (const p of parts(r)) {
    const d = DRUM_RE.test(p);
    const t = PITCHED_RE.test(p);
    if (d && !t) return true;
    if (t && !d) return false;
  }
  return false;
}
const isVocal = (r) => parts(r).some((p) => VOCAL_RE.test(p)) || (r.tags || []).some((t) => VOCAL_RE.test(t));

if (typeof module !== 'undefined' && module.exports) module.exports = { kindOf, isDrum, isVocal };
else Object.assign(window, { kindOf, isDrum, isVocal });
