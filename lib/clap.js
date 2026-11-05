// what a sample sounds like, as 32 numbers for the map: the audio half of CLAP (laion/clap-htsat-unfused,
// apache-2.0, onnx export by Xenova), run with onnxruntime-node, then cut from 512 to 32 numbers with a fixed
// pca (clap-pca.json, made from 3,355 of flah's samples).
// on those samples, the 10 nearest from other packs share the sound (kick, snare, bass...) 57% of the time.
// the hand-made features it replaces: 39%. chance: 13%
const path = require('path');
const fs = require('fs');

const MODEL = {
  url: 'https://huggingface.co/Xenova/clap-htsat-unfused/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/onnx/audio_model.onnx',
  sha256: 'a1c2b43c44f71e0fa841a4b86700886c199bf87699ea45632c4d831bc6c88957',
  size: 117528416,
  file: 'clap-htsat-unfused-audio.onnx',
};

// the model's own preprocessing (its preprocessor_config.json, same maths as transformers.js):
// 48 kHz mono, 10 s, shorter sounds repeated whole to fill it then zero padded ("repeatpad"),
// hann 1024 / hop 480 power spectrum, 64 slaney mel bands 50 Hz - 14 kHz, 10*log10, 1001 frames
const SR = 48000, N = 480000, FFT = 1024, HOP = 480, MELS = 64, BINS = FFT / 2 + 1, FRAMES = 1001;

const hzToMel = (f) => (f >= 1000 ? 15 + Math.log(f / 1000) * (27 / Math.log(6.4)) : (3 * f) / 200);
const melToHz = (m) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 * m) / 3);
const FILTERS = (() => {
  const lo = hzToMel(50), hi = hzToMel(14000);
  const f = Array.from({ length: MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (MELS + 1)));
  const fft = Array.from({ length: BINS }, (_, j) => (j * (SR / 2)) / (BINS - 1));
  return Array.from({ length: MELS }, (_, i) => {
    const w = new Float64Array(BINS);
    const norm = 2 / (f[i + 2] - f[i]);
    for (let j = 0; j < BINS; j++) {
      const down = (fft[j] - f[i]) / (f[i + 1] - f[i]);
      const up = (f[i + 2] - fft[j]) / (f[i + 2] - f[i + 1]);
      w[j] = Math.max(0, Math.min(down, up)) * norm;
    }
    return w;
  });
})();
const WINDOW = Float64Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));

// in-place radix-2 fft
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// x = mono floats at 48 kHz (up to 10 s used) -> [1001 x 64] log-mel, frame by frame
function melOf(x) {
  const n = Math.min(x.length, N);
  const w = new Float64Array(N);
  w.set(x.subarray(0, n));
  if (n > 0) for (let i = n; i < N - n; i += n) w.set(x.subarray(0, n), i);
  // centred frames: reflect-pad half a frame each side
  const half = FFT / 2, pad = new Float64Array(N + FFT);
  pad.set(w, half);
  for (let i = 1; i <= half; i++) { pad[half - i] = w[i]; pad[half + N - 1 + i] = w[N - 1 - i]; }
  const out = new Float32Array(FRAMES * MELS);
  const re = new Float64Array(FFT), im = new Float64Array(FFT), pw = new Float64Array(BINS);
  for (let t = 0; t < FRAMES; t++) {
    for (let i = 0; i < FFT; i++) { re[i] = pad[t * HOP + i] * WINDOW[i]; im[i] = 0; }
    fft(re, im);
    for (let j = 0; j < BINS; j++) pw[j] = re[j] * re[j] + im[j] * im[j];
    for (let m = 0; m < MELS; m++) {
      const f = FILTERS[m];
      let s = 0;
      for (let j = 0; j < BINS; j++) if (f[j]) s += f[j] * pw[j];
      out[t * MELS + m] = 10 * Math.log10(Math.max(1e-10, s));
    }
  }
  return out;
}

const PCA = JSON.parse(fs.readFileSync(path.join(__dirname, 'clap-pca.json'), 'utf8'));
let session = null;
async function load(modelFile) {
  if (session) return session;
  const ort = require('onnxruntime-node');
  // 2 threads: on flah's 20-thread cpu that was as fast per sound as all of them, and running more at once didn't help
  session = await ort.InferenceSession.create(modelFile, { intraOpNumThreads: 2 });
  return session;
}

// x = mono 48 kHz floats -> 32 numbers
async function soundPrint(modelFile, x) {
  const s = await load(modelFile);
  const ort = require('onnxruntime-node');
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', melOf(x), [1, 1, FRAMES, MELS]) });
  const e = res[s.outputNames[0]].data;
  let n = 0;
  for (const v of e) n += v * v;
  n = Math.sqrt(n) || 1;
  const out = new Array(PCA.comps.length);
  for (let c = 0; c < out.length; c++) {
    let v = 0;
    const comp = PCA.comps[c];
    for (let j = 0; j < e.length; j++) v += (e[j] / n - PCA.mean[j]) * comp[j];
    out[c] = Math.round(v * 1e4) / 1e4;
  }
  return out;
}

// bump when what goes into a sample's numbers changes: older ones get measured again
const VERSION = 2;

module.exports = { MODEL, SR, VERSION, melOf, soundPrint };
