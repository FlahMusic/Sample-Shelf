// a small waveform for a list row: the loudest sample in each of `bins` slices of a wav, 0..255,
// scaled to the file's own loudest point. reads pcm 8/16/24/32 and float 32/64 (plain or extensible)
const fs = require('fs');

function wavPeaks(buf, bins = 48) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      let tag = buf.readUInt16LE(p + 8);
      if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(p + 32);
      fmt = { tag, ch: buf.readUInt16LE(p + 10), bits: buf.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      data = [p + 8, Math.min(buf.length, p + 8 + size)];
      break;
    }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || !fmt.ch) return null;
  const bytes = fmt.bits / 8;
  const read = fmt.tag === 3
    ? (bytes === 4 ? (o) => buf.readFloatLE(o) : bytes === 8 ? (o) => buf.readDoubleLE(o) : null)
    : bytes === 1 ? (o) => (buf[o] - 128) / 128
    : bytes === 2 ? (o) => buf.readInt16LE(o) / 32768
    : bytes === 3 ? (o) => buf.readIntLE(o, 3) / 8388608
    : bytes === 4 ? (o) => buf.readInt32LE(o) / 2147483648
    : null;
  if (!read) return null;
  const frame = bytes * fmt.ch;
  const frames = Math.floor((data[1] - data[0]) / frame);
  if (frames < 1) return null;
  // long files: look at up to ~64k frames per slice, enough to find the peaks without reading every sample
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const s = Math.floor((b * frames) / bins), e = Math.max(s + 1, Math.floor(((b + 1) * frames) / bins));
    const step = Math.max(1, Math.floor((e - s) / 65536));
    let m = 0;
    for (let f = s; f < e; f += step) {
      const o = data[0] + f * frame;
      for (let c = 0; c < fmt.ch; c++) { const v = Math.abs(read(o + c * bytes)); if (v > m) m = v; }
    }
    out[b] = m;
  }
  let top = 0;
  for (const v of out) if (v > top) top = v;
  const q = Buffer.alloc(bins);
  for (let b = 0; b < bins; b++) q[b] = top ? Math.round(Math.min(1, out[b] / top) * 255) : 0;
  return q.toString('base64');
}

async function peaksOfFile(file, bins) {
  return wavPeaks(await fs.promises.readFile(file), bins);
}

module.exports = { wavPeaks, peaksOfFile };
