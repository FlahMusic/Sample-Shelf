// what a sample sounds like, as 34 numbers, for the map and "similar" lists. plain js, no essentia calls
// (thousands of wasm calls per file were the slow part of the prototype).
// per 2048-sample frame (hop 1024, hann): 13 mfcc, spectral centroid, zero-crossing rate, spectral flatness.
// mean + spread of each over the frames that aren't silent, plus log length and log time-to-peak.
const N = 2048;
const HOP = 1024;
const BANDS = 40;
const COEFFS = 13;

const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

// iterative radix-2 fft tables
const rev = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  rev[i] = r;
}
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = -Math.sin((2 * Math.PI * i) / N); }
const re = new Float64Array(N);
const im = new Float64Array(N);
function fft() {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cosT[k * step], sn = sinT[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn;
        const ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// triangular mel filters, 0 - 11 kHz, each summing to 1
let mel = null;
function melBank(sr) {
  const toMel = (f) => 2595 * Math.log10(1 + f / 700);
  const toHz = (m) => 700 * (10 ** (m / 2595) - 1);
  const top = Math.min(11000, sr / 2);
  const edges = [];
  for (let i = 0; i < BANDS + 2; i++) edges.push(toHz((toMel(top) * i) / (BANDS + 1)));
  const bins = N / 2 + 1;
  const bank = [];
  for (let b = 0; b < BANDS; b++) {
    const w = new Float64Array(bins);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const f = (k * sr) / N;
      const v = f <= edges[b] || f >= edges[b + 2] ? 0 : f <= edges[b + 1] ? (f - edges[b]) / (edges[b + 1] - edges[b]) : (edges[b + 2] - f) / (edges[b + 2] - edges[b + 1]);
      w[k] = v; sum += v;
    }
    if (sum) for (let k = 0; k < bins; k++) w[k] /= sum;
    bank.push(w);
  }
  return { sr, bank };
}
const dct = [];
for (let c = 0; c < COEFFS; c++) {
  const row = new Float64Array(BANDS);
  for (let b = 0; b < BANDS; b++) row[b] = Math.cos((Math.PI * c * (b + 0.5)) / BANDS) * Math.sqrt((c ? 2 : 1) / BANDS);
  dct.push(row);
}

// x: mono float samples (the first few seconds), sr: their rate, dur: the whole file's length in seconds
function features(x, sr, dur) {
  if (!mel || mel.sr !== sr) mel = melBank(sr);
  const bins = N / 2 + 1;
  const pow = new Float64Array(bins);
  const bandE = new Float64Array(BANDS);
  const rows = [];
  let peakRms = 0, peakAt = 0;
  // a file shorter than one frame still gets one (zero-padded)
  for (let s = 0; s === 0 || s + N <= x.length; s += HOP) {
    let e = 0, zc = 0;
    for (let i = 0; i < N; i++) {
      const v = s + i < x.length ? x[s + i] : 0;
      e += v * v;
      if (i && (v >= 0) !== ((s + i - 1 < x.length ? x[s + i - 1] : 0) >= 0)) zc++;
      re[i] = v * win[i]; im[i] = 0;
    }
    const rms = Math.sqrt(e / N);
    if (rms > peakRms) { peakRms = rms; peakAt = s; }
    fft();
    let tot = 0, cen = 0, logSum = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      pow[k] = p; tot += p; cen += k * p; logSum += Math.log(p + 1e-12);
    }
    for (let b = 0; b < BANDS; b++) {
      const w = mel.bank[b];
      let acc = 0;
      for (let k = 0; k < bins; k++) if (w[k]) acc += w[k] * pow[k];
      bandE[b] = 10 * Math.log10(acc + 1e-10);
    }
    const row = new Array(COEFFS + 3);
    for (let c = 0; c < COEFFS; c++) { let acc = 0; for (let b = 0; b < BANDS; b++) acc += dct[c][b] * bandE[b]; row[c] = acc; }
    row[COEFFS] = tot ? cen / tot / (bins - 1) : 0;
    row[COEFFS + 1] = zc / N;
    row[COEFFS + 2] = tot ? Math.exp(logSum / bins) / (tot / bins) : 0;
    rows.push({ rms, row });
  }
  // frames more than 60 dB under the loudest don't describe the sound
  const keep = rows.filter((r) => r.rms >= peakRms * 0.001);
  const use = keep.length ? keep : rows;
  const d = COEFFS + 3;
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const { row } of use) for (let j = 0; j < d; j++) mean[j] += row[j] / use.length;
  for (const { row } of use) for (let j = 0; j < d; j++) sd[j] += (row[j] - mean[j]) ** 2 / use.length;
  const out = [...mean, ...sd.map(Math.sqrt), Math.log((dur || x.length / sr) + 0.01), Math.log(peakAt / sr + 0.005)];
  return out.map((v) => Math.round(v * 10000) / 10000);
}

// bump when the numbers change: older samples get measured again on the next scan
const VERSION = 1;

module.exports = { features, VERSION, LENGTH: 2 * (COEFFS + 3) + 2 };
