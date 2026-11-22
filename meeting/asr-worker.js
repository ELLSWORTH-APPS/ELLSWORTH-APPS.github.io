/* Morning Meeting speech engine. Runs on the phone, in the background, and turns a recording into words.
   It uses NVIDIA's Parakeet TDT 110M speech model through ONNX Runtime Web. Nothing leaves the phone here.
   Messages in:  {t:"load"}                      gets the model ready (downloads it once, then keeps it)
                 {t:"run", id, pcm, maxSecs}     pcm: Float32Array of 16 kHz mono audio
   Messages out: {t:"progress", stage, done, total}, {t:"ready"}, {t:"result", id, lines:[{at, text}]}, {t:"error", id, code, message} */
"use strict";
importScripts("vendor/ort/ort.wasm.min.js");

const MODEL_VER = "parakeet-tdt-110m-1";
const MODEL_CACHE = "mm-model-" + MODEL_VER;
const BASE = new URL("model/", self.location.href).href;
const FILES = { enc: ["encoder.onnx.part0", "encoder.onnx.part1", "encoder.onnx.part2"], dec: "decoder.onnx", joi: "joiner.onnx", mel: "mel80.bin", tok: "tokens.txt" };
const SIZES = { "encoder.onnx.part0": 45000000, "encoder.onnx.part1": 45000000, "encoder.onnx.part2": 41113202, "decoder.onnx": 3955863, "joiner.onnx": 1411403, "mel80.bin": 82240, "tokens.txt": 9953 };
const SR = 16000, NFFT = 512, WIN = 400, HOP = 160, NMEL = 80, NBIN = NFFT / 2 + 1;
const BLANK = 1024, DURS = [0, 1, 2, 3, 4];

let ready = null, enc, dec, joi, MEL, TOKS;
const post = (m, tr) => self.postMessage(m, tr || []);

/* ---------- getting the model onto the phone ---------- */
async function getFile(cache, name, onBytes) {
  const url = BASE + name;
  let res = await cache.match(url);
  if (res) { const b = await res.arrayBuffer(); onBytes(b.byteLength); return b; }
  let net;
  try { net = await fetch(url, { cache: "no-store" }); } catch (e) { throw { code: "offline" }; }
  if (!net.ok) throw { code: "download", message: "HTTP " + net.status + " for " + name };
  const want = SIZES[name] || 0, reader = net.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.byteLength; onBytes(value.byteLength);
  }
  if (want && got !== want) throw { code: "download", message: "Incomplete download of " + name };
  const blob = new Blob(parts);
  try { await cache.put(url, new Response(blob)); } catch (e) { /* keep going; it downloads again next time */ }
  return await blob.arrayBuffer();
}
function load() {
  if (ready) return ready;
  ready = (async () => {
    const cache = await caches.open(MODEL_CACHE);
    const total = Object.values(SIZES).reduce((a, b) => a + b, 0); let done = 0;
    const tickBytes = (n) => { done += n; post({ t: "progress", stage: "download", done, total }); };
    const encParts = [];
    for (const f of FILES.enc) encParts.push(await getFile(cache, f, tickBytes));
    const decB = await getFile(cache, FILES.dec, tickBytes), joiB = await getFile(cache, FILES.joi, tickBytes);
    MEL = new Float32Array(await getFile(cache, FILES.mel, tickBytes));
    TOKS = new TextDecoder().decode(await getFile(cache, FILES.tok, tickBytes)).split("\n").filter(Boolean).map((l) => l.slice(0, l.lastIndexOf(" ")));
    // throw away older copies of the model
    for (const k of await caches.keys()) if (k.startsWith("mm-model-") && k !== MODEL_CACHE) caches.delete(k);
    post({ t: "progress", stage: "start", done: 0, total: 1 });
    const encBytes = new Uint8Array(encParts.reduce((a, b) => a + b.byteLength, 0)); let o = 0;
    for (const p of encParts) { encBytes.set(new Uint8Array(p), o); o += p.byteLength; }
    encParts.length = 0;
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", self.location.href).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    enc = await ort.InferenceSession.create(encBytes, opt);
    dec = await ort.InferenceSession.create(new Uint8Array(decB), opt);
    joi = await ort.InferenceSession.create(new Uint8Array(joiB), opt);
    post({ t: "ready", threads: ort.env.wasm.numThreads });
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

/* ---------- sound to numbers (the same steps the model was trained with) ---------- */
const WINDOW = new Float32Array(NFFT);
for (let i = 0; i < WIN; i++) WINDOW[(NFFT - WIN) / 2 + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
const COS = new Float32Array(NFFT / 2), SIN = new Float32Array(NFFT / 2), REV = new Uint16Array(NFFT);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / NFFT); SIN[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
for (let i = 0, bits = Math.log2(NFFT); i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); REV[i] = r; }
function fft(re, im) {
  for (let i = 0; i < NFFT; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) for (let k = 0; k < half; k++) {
      const a = s + k, b = a + half, wr = COS[k * step], wi = SIN[k * step];
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
function features(x) {
  const pad = NFFT / 2, n = x.length, padded = new Float32Array(n + 2 * pad);
  padded[pad] = x[0];
  for (let i = 1; i < n; i++) padded[pad + i] = x[i] - 0.97 * x[i - 1];
  const frames = 1 + Math.floor((padded.length - NFFT) / HOP);
  const L = Math.max(1, Math.min(Math.floor(n / HOP), frames));
  const out = new Float32Array(NMEL * frames), re = new Float32Array(NFFT), im = new Float32Array(NFFT), pw = new Float32Array(NBIN);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < NFFT; i++) { re[i] = padded[off + i] * WINDOW[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < NBIN; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < NMEL; m++) {
      let s = 0; const row = m * NBIN;
      for (let k = 0; k < NBIN; k++) { const w = MEL[row + k]; if (w) s += w * pw[k]; }
      out[m * frames + f] = Math.log(s + 5.960464477539063e-8);
    }
  }
  for (let m = 0; m < NMEL; m++) {   // each band evened out over the stretch of speech
    const row = m * frames; let mean = 0;
    for (let f = 0; f < L; f++) mean += out[row + f];
    mean /= L;
    let v = 0;
    for (let f = 0; f < L; f++) { const d = out[row + f] - mean; v += d * d; }
    const sd = L > 1 ? Math.sqrt(v / (L - 1)) + 1e-5 : 1;
    for (let f = 0; f < frames; f++) out[row + f] = f < L ? (out[row + f] - mean) / sd : 0;
  }
  return { data: out, frames };
}

/* ---------- numbers to words ---------- */
async function runDec(tok, h, c) {
  const o = await dec.run({ targets: new ort.Tensor("int32", Int32Array.of(tok), [1, 1]), target_length: new ort.Tensor("int32", Int32Array.of(1), [1]), "states.1": h, "onnx::LSTM_3": c });
  return { out: o.outputs, h: o.states, c: o["74"] };
}
async function transcribeChunk(x) {
  const { data, frames } = features(x);
  const e = await enc.run({ audio_signal: new ort.Tensor("float32", data, [1, NMEL, frames]), length: new ort.Tensor("int64", BigInt64Array.of(BigInt(frames)), [1]) });
  const eo = e.outputs.data, T = Number(e.encoded_lengths.data[0]), TT = e.outputs.dims[2], D = e.outputs.dims[1];
  let h = new ort.Tensor("float32", new Float32Array(640), [1, 1, 640]), c = new ort.Tensor("float32", new Float32Array(640), [1, 1, 640]);
  let d = await runDec(BLANK, h, c);
  const col = new Float32Array(D), toks = []; let t = 0, sym = 0;
  while (t < T) {
    for (let i = 0; i < D; i++) col[i] = eo[i * TT + t];
    const lg = (await joi.run({ encoder_outputs: new ort.Tensor("float32", col, [1, D, 1]), decoder_outputs: d.out })).outputs.data;
    let tok = 0, best = -Infinity;
    for (let i = 0; i <= BLANK; i++) if (lg[i] > best) { best = lg[i]; tok = i; }
    let di = 0, bd = -Infinity;
    for (let i = 0; i < DURS.length; i++) if (lg[BLANK + 1 + i] > bd) { bd = lg[BLANK + 1 + i]; di = i; }
    let dur = DURS[di];
    if (tok !== BLANK) { toks.push(tok); h = d.h; c = d.c; d = await runDec(tok, h, c); sym++; }
    if (tok === BLANK && dur === 0) dur = 1;
    if (dur === 0 && sym >= 10) dur = 1;
    if (dur > 0) sym = 0;
    t += dur;
  }
  return toks.map((i) => TOKS[i] || "").join("").replace(/▁/g, " ").replace(/\s+/g, " ").trim();
}

/* ---------- cutting the meeting into pieces at the pauses ---------- */
function pieces(pcm) {
  const F = 160, n = Math.floor(pcm.length / F), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < F; j++) { const v = pcm[i * F + j]; s += v * v; } e[i] = Math.sqrt(s / F); }
  const sorted = Array.from(e).sort((a, b) => a - b), floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.9)] || 0;
  const MIN = 1000, MAX = 2200, out = [];   // 10 ms frames: pieces of about 10 to 22 seconds
  let s = 0;
  while (s < n) {
    let cut = n;
    if (n - s > MAX) {
      cut = s + MAX; let best = Infinity;
      for (let i = s + MIN; i < s + MAX; i++) { let w = 0; for (let k = -15; k <= 15; k++) w += e[Math.min(n - 1, Math.max(0, i + k))]; if (w < best) { best = w; cut = i; } }
    }
    let peak = 0; for (let i = s; i < cut; i++) if (e[i] > peak) peak = e[i];
    if (peak > Math.max(0.004, floor * 3, loud * 0.15)) out.push([s * F, cut * F]);   // skip stretches with no one talking
    s = cut;
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.t === "load") { await load(); return; }
    if (m.t !== "run") return;
    await load();
    let pcm = m.pcm; if (m.maxSecs && pcm.length > m.maxSecs * SR) pcm = pcm.subarray(0, m.maxSecs * SR);
    let peak = 0; for (let i = 0; i < pcm.length; i += 7) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    if (peak > 0 && peak < 0.25) { const g = Math.min(8, 0.5 / peak), y = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) y[i] = pcm[i] * g; pcm = y; }   // a quiet recording is turned up
    const list = pieces(pcm), lines = [];
    for (let i = 0; i < list.length; i++) {
      post({ t: "progress", stage: "listen", done: i, total: list.length });
      const [a, b] = list[i], text = await transcribeChunk(pcm.subarray(a, b));
      if (text) lines.push({ at: Math.round(a / SR), text });
    }
    post({ t: "progress", stage: "listen", done: list.length, total: list.length });
    post({ t: "result", id: m.id, lines });
  } catch (e) {
    post({ t: "error", id: m.id, code: (e && e.code) || "engine", message: String((e && (e.message || e)) || "").slice(0, 300) });
  }
};
