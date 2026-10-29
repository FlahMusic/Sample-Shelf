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

if (typeof module !== 'undefined' && module.exports) module.exports = { kindOf };
else window.kindOf = kindOf;
