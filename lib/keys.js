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

// pull key from a filename. needs an accidental or a scale word so "Kick A" isn't read as A.
function keyFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const re = /(?:^|[\s_\-.()[\]])([A-Ga-g])([#b♯♭]?)\s?(major|minor|maj|min|m|M)?(?=$|[\s_\-.()[\]])/g;
  let m;
  while ((m = re.exec(base))) {
    const [, letter, acc, sc] = m;
    if (!acc && !sc) continue;
    // lowercase single letter + "b" is ambiguous ("a b"); require uppercase letter when no scale word
    if (!sc && letter !== letter.toUpperCase()) continue;
    const root = normRoot(letter + acc);
    if (!root) continue;
    return { root, scale: sc ? normScale(sc) : null };
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

const Keys = { PITCHES, normRoot, normScale, bpmFromName, keyFromName, keyFromTag };
if (typeof module !== 'undefined' && module.exports) module.exports = Keys;
else window.Keys = Keys;
