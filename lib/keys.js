// key + bpm helpers shared by worker and renderer (renderer gets a copy via preload)

const PITCHES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ALIAS = {
  'C': 0, 'B#': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3, 'E': 4, 'FB': 4,
  'F': 5, 'E#': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8, 'AB': 8, 'A': 9,
  'A#': 10, 'BB': 10, 'B': 11, 'CB': 11,
};

// "Db" / "c#" / "C♯" -> "C#" style canonical name, or null
function normRoot(s) {
  if (!s) return null;
  const k = s.replace('♯', '#').replace('♭', 'b').toUpperCase();
  const i = ALIAS[k];
  return i === undefined ? null : PITCHES[i];
}

function normScale(s) {
  if (!s) return null;
  if (/^(m|min|minor)$/i.test(s) && s !== 'M') return 'minor';
  if (/^(M|maj|major)$/i.test(s) || s === 'M') return 'major';
  return null;
}

// pull bpm from a filename. explicit "128bpm" / "bpm128" first, then a lone 60-200 number.
function bpmFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  let m = base.match(/(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm/i) || base.match(/bpm\s*-?\s*(\d{2,3}(?:\.\d+)?)/i);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= 40 && v <= 300) return v;
  }
  const re = /(?:^|[\s_\-.()[\]])(\d{2,3})(?=$|[\s_\-.()[\]])/g;
  while ((m = re.exec(base))) {
    const v = parseInt(m[1], 10);
    if (v >= 60 && v <= 200) return v;
  }
  return null;
}

// "KeyOfEm", "Key of Bb minor", "KeyOfC" (no suffix = major, like "key of C" means)
function keyOfWords(s) {
  const m = s.match(/key\s*of\s*([A-Ga-g])([#b♯♭]?)\s?(major|minor|maj|min|m)?(?![a-z])/i);
  if (!m) return null;
  const root = normRoot(m[1].toUpperCase() + m[2]);
  return root ? { root, scale: m[3] ? normScale(m[3].toLowerCase()) : 'major' } : null;
}

// pull key from a filename. needs an accidental or a scale word so "Kick A" isn't read as A.
// no bare capital "M" for major: on flah's shelf that was "FM Brass", "AM Sequences" 258 times out of 321
function keyFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const ko = keyOfWords(base);
  if (ko) return ko;
  const re = /(?:^|[\s_\-.()[\]])([A-Ga-g])([#b♯♭]?)(?:[\s_-]?([Mm]aj(?:or)?|[Mm]in(?:or)?)|(m))?(?=$|[\s_\-.()[\]&,])/g;
  let m;
  while ((m = re.exec(base))) {
    const [, letter, acc, word, mm] = m;
    if (!acc && !word && !mm) continue;
    // lowercase letter without a scale word is ordinary text ("am", "a b")
    if ((mm || !word) && letter !== letter.toUpperCase()) continue;
    const root = normRoot(letter + acc);
    if (!root) continue;
    return { root, scale: word ? normScale(word.toLowerCase()) : mm ? 'minor' : null };
  }
  return null;
}

// sample packs often put the key on the folder ("Indie Pop Em 119bpm"). nearest 3 folders, nearest first
function keyFromFolder(folder) {
  for (const seg of String(folder).split(/[\\/]/).filter(Boolean).reverse().slice(0, 3)) {
    const k = keyFromName(seg + '.x');
    if (k) return k;
  }
  return null;
}

// parse a tag string like "Am", "F# minor", "Bbmaj", "C" (from ID3 TKEY etc)
function keyFromTag(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m|M)?$/);
  if (!m) return null;
  const root = normRoot(m[1] + m[2]);
  if (!root) return null;
  return { root, scale: m[3] ? normScale(m[3]) : 'major' };
}

// key lock: semitones that move a key into the locked key. minor goes to the locked minor key, major to its
// relative major (a major lock is the mirror). smallest move, -6..+5, so A min -> E min is -5 not +7.
// a key and its relative get the same shift, so a relative major/minor mix-up in detection does no harm
function lockShift(root, scale, lockRoot, lockScale) {
  const pc = (r) => ALIAS[r.toUpperCase()];
  let target = pc(lockRoot);
  if (scale !== lockScale) target += lockScale === 'minor' ? 3 : -3;
  const d = (((target - pc(root)) % 12) + 12) % 12;
  return d > 5 ? d - 12 : d;
}
// the key a loop ends up in under the lock
function lockedKey(scale, lockRoot, lockScale) {
  if (scale === lockScale) return { root: lockRoot, scale };
  const pc = ALIAS[lockRoot.toUpperCase()] + (lockScale === 'minor' ? 3 : -3);
  return { root: PITCHES[((pc % 12) + 12) % 12], scale };
}

const Keys = { PITCHES, normRoot, normScale, bpmFromName, keyFromName, keyFromFolder, keyFromTag, lockShift, lockedKey };
if (typeof module !== 'undefined' && module.exports) module.exports = Keys;
else window.Keys = Keys;
