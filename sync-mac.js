// copies the app to the mac folder next to this one ("sample shelf mac"), so both stay the same.
// run after every change: node sync-mac.js
// the code itself works on both (process.platform / MAC / SEP), so everything is copied except what's only
// for one of them. mac-only files live in the mac folder and are never touched here.
const fs = require('fs');
const path = require('path');

const from = __dirname;
const to = path.join(path.dirname(from), 'sample shelf mac');
// windows-only, or not code
const SKIP = new Set(['node_modules', '.git', '.claude', 'start.bat', 'sync-mac.js', 'CLAUDE.md']);
// only in the mac folder
const MAC_ONLY = new Set(['node_modules', '.git', '.claude', 'start.command', 'MAC.md', 'CLAUDE.md', '.gitattributes']);

let copied = 0, removed = 0;
function copyDir(a, b, top) {
  fs.mkdirSync(b, { recursive: true });
  const names = fs.readdirSync(a).filter((n) => !(top && SKIP.has(n)));
  for (const n of names) {
    const sa = path.join(a, n), sb = path.join(b, n);
    if (fs.statSync(sa).isDirectory()) { copyDir(sa, sb, false); continue; }
    const same = fs.existsSync(sb) && fs.readFileSync(sa).equals(fs.readFileSync(sb));
    if (!same) { fs.copyFileSync(sa, sb); copied++; }
  }
  // files deleted here get deleted there too (not the mac-only ones)
  for (const n of fs.readdirSync(b)) {
    if (top && MAC_ONLY.has(n)) continue;
    if (!names.includes(n)) { fs.rmSync(path.join(b, n), { recursive: true, force: true }); removed++; }
  }
}
copyDir(from, to, true);
console.log(`${to}: ${copied} file${copied === 1 ? '' : 's'} copied, ${removed} removed`);
