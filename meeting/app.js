/* Morning Meeting. Records the morning meeting, turns it into words on the phone with a built-in speech engine,
   and has Claude turn those words and the names lists into the day's job sheet.
   Recordings, sheets, names and the Claude key are kept on this phone only; only the words go to Claude.
   Nothing is stored on the website the app comes from. */
(() => {
"use strict";

const VERSION = self.MM_VERSION || "dev";
const MAX_REC_MS = 35 * 60 * 1000;        // a forgotten recording stops itself
const MAX_AI_SECS = 20 * 60;              // only the first 20 minutes of a recording are listened to

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "value") e.value = v;
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const words = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
const pad = (n) => String(n).padStart(2, "0");
const dstr = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const todayStr = () => dstr(new Date());
function dateObj(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function fmtDate(s, opts) { const d = dateObj(s); return d ? d.toLocaleDateString("en-US", opts) : (s || ""); }
function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + pad(s % 60); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const isStandalone = () => { try { return !!(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches); } catch (e) { return false; } };

/* ---------- storage on this phone ---------- */
let dbp = null;
function idb() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("morning-meeting", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("days")) d.createObjectStore("days", { keyPath: "id" });
      if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio");
      if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks", { autoIncrement: true });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("blocked"));
  }));
}
function tx(store, mode, fn) {
  return idb().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode); let out;
    const rq = fn(t.objectStore(store));
    if (rq) rq.onsuccess = () => { out = rq.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("aborted"));
  }));
}
const S = {
  get: (st, k) => tx(st, "readonly", (s) => s.get(k)),
  all: (st) => tx(st, "readonly", (s) => s.getAll()),
  keys: (st) => tx(st, "readonly", (s) => s.getAllKeys()),
  put: (st, v, k) => tx(st, "readwrite", (s) => (k === undefined ? s.put(v) : s.put(v, k))),
  del: (st, k) => tx(st, "readwrite", (s) => s.delete(k)),
  clear: (st) => tx(st, "readwrite", (s) => s.clear()),
};

/* ---------- state ---------- */
const EMPTY_NAMES = { me: "", boss: "", people: "", places: "", gear: "" };
const IDLE_BUILD = { id: null, status: "idle", err: "", said: "", step: "", ctl: null, fix: false, startedAt: 0 };
const state = {
  ready: false, storeErr: false, days: [], names: Object.assign({}, EMPTY_NAMES), namesDraft: null, namesMsg: "",
  key: "", models: [], route: { view: "home" },
  rec: { phase: "idle", startedAt: 0, ms: 0, err: "", awake: false },
  build: Object.assign({}, IDLE_BUILD),
  type: { date: todayStr(), text: "", err: "" },
  add: { file: null, date: todayStr(), err: "", busy: false },
  setup: { draft: "", busy: false, msg: "", ok: null, said: "", bmsg: "", bok: null, used: "" },
  fixText: "", copyText: "", confirmDelete: false, flash: "", installEvt: null, standalone: false, update: false,
};
const waiting = new Set();     // days whose sheet is waiting for signal
const NAV = { atBase: true };
let media = null, tick = null, wake = null, player = null, swReg = null;

const dayById = (id) => state.days.find((d) => d.id === id) || null;
const sortDays = (list) => list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
const names = () => Object.assign({}, EMPTY_NAMES, state.names);
const recBusy = () => state.rec.phase !== "idle";
function freshId(date) {
  const taken = new Set(state.days.map((d) => d.id));
  if (!taken.has(date)) return date;
  for (let i = 2; i < 60; i++) if (!taken.has(date + "-" + i)) return date + "-" + i;
  return date + "-" + Date.now();
}
async function saveDay(day) {
  await S.put("days", clone(day));
  state.days = sortDays(state.days.filter((d) => d.id !== day.id).concat([clone(day)]));
}
async function saveRecording(id, date, blob, secs, source, when, name) {
  const type = (blob.type || "").split(";")[0];
  const ext = /webm/.test(type) ? ".webm" : /mp4|m4a/.test(type) ? ".m4a" : /mpeg|mp3/.test(type) ? ".mp3" : "";
  await S.put("audio", { blob, name: name || "meeting-" + id + ext }, id);
  await saveDay({ id, date, createdAt: when || Date.now(), source, hasAudio: true, audioSecs: secs || 0, audioBytes: blob.size, transcript: "", sheet: null });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* fine */ }
}

/* ---------- moving between screens ---------- */
function go(route) {
  if (route.view !== "day" || !player || player.id !== route.id) dropPlayer();
  state.route = route; state.confirmDelete = false; state.copyText = ""; state.flash = "";
  if (route.view !== "day") state.fixText = "";
  try { history.pushState({ mm: 1, r: route }, ""); NAV.atBase = false; } catch (e) { /* fine */ }
  render(); window.scrollTo(0, 0);
}
function goReplace(route) {
  if (route.view !== "day" || !player || player.id !== route.id) dropPlayer();
  state.route = route; state.confirmDelete = false; state.copyText = ""; state.flash = "";
  if (route.view !== "day") state.fixText = "";
  try { history.replaceState(Object.assign({}, history.state || {}, { mm: 1, r: route }), ""); } catch (e) { /* fine */ }
  render(); window.scrollTo(0, 0);
}
// The first touch on the bottom screen adds a step to go back to, so the phone's Back button stays in the app.
function arm() { if (!NAV.atBase) return; try { history.pushState({ mm: 1, r: state.route }, ""); NAV.atBase = false; } catch (e) { /* fine */ } }
window.addEventListener("pointerdown", arm, true);
window.addEventListener("keydown", arm, true);
window.addEventListener("popstate", (e) => {
  const st = e.state;
  if (recBusy()) { try { history.pushState({ mm: 1, r: state.route }, ""); NAV.atBase = false; } catch (e2) { /* fine */ } return; }   // Back does nothing while it records
  const next = st && st.mm && st.r ? st.r : { view: "home" };
  NAV.atBase = !st || !st.mm || !!st.base;
  if (next.view !== "day" || !player || player.id !== next.id) dropPlayer();
  state.route = next; state.confirmDelete = false; state.copyText = ""; state.flash = "";
  render(); window.scrollTo(0, 0);
});

/* ---------- recording ---------- */
function micErr(e) {
  const n = e && e.name;
  if (n === "NotAllowedError" || n === "SecurityError") return "The microphone is blocked for this app. In your phone's Settings, open Apps, find Morning Meeting (or Chrome), and allow the Microphone. Then tap Record again.";
  if (n === "NotFoundError") return "No microphone was found on this phone.";
  if (n === "NotReadableError" || n === "AbortError") return "Another app is using the microphone. Close it and tap Record again.";
  if (n === "NoRecorder") return "This browser can't record. Open the app in Chrome.";
  return "Couldn't start recording. Tap Record to try again.";
}
async function keepAwake(on) {
  try {
    if (on) {
      if (!wake && navigator.wakeLock) {
        wake = await navigator.wakeLock.request("screen");
        wake.addEventListener("release", () => { wake = null; });
      }
    } else if (wake) { const w = wake; wake = null; await w.release(); }
  } catch (e) { wake = null; }
  state.rec.awake = !!wake; updateRec();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.rec.phase === "recording") keepAwake(true);
  if (swReg) swReg.update().catch(() => {});
});
async function startRec() {
  const r = state.rec; if (r.phase !== "idle") return;
  r.phase = "starting"; r.err = ""; render();
  let stream = null;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) throw { name: "NoRecorder" };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); }
    catch (e) { if (e && e.name === "OverconstrainedError") stream = await navigator.mediaDevices.getUserMedia({ audio: true }); else throw e; }
    const want = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"].find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } });
    const rec = new MediaRecorder(stream, Object.assign({ audioBitsPerSecond: 48000 }, want ? { mimeType: want } : {}));
    const m = media = { stream, rec, chunks: [], mime: rec.mimeType || want || "audio/webm", lvl: 0, heard: false };
    await S.clear("chunks").catch(() => {});
    await S.put("kv", { mime: m.mime, startedAt: Date.now() }, "rec-meta").catch(() => {});
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) { m.chunks.push(ev.data); S.put("chunks", ev.data).catch(() => {}); } };   // also kept on the phone as it goes, in case the app is closed
    rec.onstop = () => finishRec(m);
    rec.onerror = () => { if (state.rec.phase === "recording") stopRec(); };
    stream.getAudioTracks().forEach((t) => { t.onended = () => { if (state.rec.phase === "recording") stopRec(); }; });
    rec.start(3000);
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      m.ctx = new AC(); m.an = m.ctx.createAnalyser(); m.an.fftSize = 1024; m.buf = new Float32Array(m.an.fftSize);
      m.ctx.createMediaStreamSource(stream).connect(m.an);
      if (m.ctx.state === "suspended") m.ctx.resume().catch(() => {});
    } catch (e) { m.an = null; }
    r.phase = "recording"; r.startedAt = Date.now(); r.ms = 0;
    keepAwake(true);
    if (tick) clearInterval(tick);
    tick = setInterval(() => { updateRec(); if (state.rec.phase === "recording" && Date.now() - state.rec.startedAt > MAX_REC_MS) { state.flash = "The recording stopped by itself at 35 minutes."; stopRec(); } }, 500);
    render(); meterLoop();
  } catch (e) {
    if (stream) try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) { /* fine */ }
    media = null; r.phase = "idle"; r.err = micErr(e); render();
  }
}
function meterLoop() {
  const m = media; if (!m || state.rec.phase !== "recording") return;
  if (m.an) {
    m.an.getFloatTimeDomainData(m.buf);
    let sum = 0; for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / m.buf.length) + 1e-7);
    const lvl = Math.max(0, Math.min(1, (db + 62) / 50));
    if (lvl > 0.1) m.heard = true;
    m.lvl = Math.max(lvl, m.lvl * 0.86);
    const bar = $("#rec-meter"); if (bar) bar.style.transform = "scaleX(" + m.lvl.toFixed(3) + ")";
  }
  requestAnimationFrame(meterLoop);
}
function stopRec() {
  const r = state.rec; if (r.phase !== "recording" || !media) return;
  r.ms = Date.now() - r.startedAt; r.phase = "saving"; render();
  const m = media;
  try { if (m.rec.state !== "inactive") m.rec.stop(); else finishRec(m); } catch (e) { finishRec(m); }
}
async function finishRec(m) {
  if (!m || m.done) return; m.done = true;
  if (media === m) media = null;
  if (tick) { clearInterval(tick); tick = null; }
  keepAwake(false);
  try { m.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* fine */ }
  try { if (m.ctx) m.ctx.close(); } catch (e) { /* fine */ }
  const r = state.rec, ms = r.ms || (Date.now() - r.startedAt);
  const blob = new Blob(m.chunks, { type: (m.mime || "audio/webm").split(";")[0] });
  const reset = (err) => { Object.assign(r, { phase: "idle", startedAt: 0, ms: 0, err: err || "" }); };
  if (blob.size < 3000 || ms < 3000) { await S.clear("chunks").catch(() => {}); await S.del("kv", "rec-meta").catch(() => {}); reset("That was too short to use. Tap Record to try again."); render(); return; }
  try {
    const id = freshId(todayStr());
    await saveRecording(id, todayStr(), blob, Math.round(ms / 1000), "recorded");
    await S.clear("chunks").catch(() => {}); await S.del("kv", "rec-meta").catch(() => {});
    reset(""); const keep = state.flash; go({ view: "day", id }); state.flash = keep;
    buildSheet(id);
  } catch (e) {
    reset("The recording couldn't be saved on this phone. Free up some space and open the app again. What was recorded should still be there.");
    render();
  }
}
// A recording that was cut off (app closed, phone restarted) is put back together from what was kept as it went.
async function recoverCutOff() {
  const parts = await S.all("chunks"); if (!parts || !parts.length) return;
  const meta = (await S.get("kv", "rec-meta")) || {};
  const blob = new Blob(parts, { type: (meta.mime || "audio/webm").split(";")[0] });
  if (blob.size > 20000) {
    const date = meta.startedAt ? dstr(new Date(meta.startedAt)) : todayStr(), id = freshId(date);
    await saveRecording(id, date, blob, 0, "recovered", meta.startedAt);
    state.flash = "A recording was cut off before it was finished. What it caught is saved under " + fmtDate(date, { weekday: "long", month: "short", day: "numeric" }) + ".";
  }
  await S.clear("chunks"); await S.del("kv", "rec-meta");
}
function updateRec() {
  const r = state.rec;
  const t = $("#rec-timer"); if (t) t.textContent = clock(r.phase === "recording" ? Date.now() - r.startedAt : r.ms);
  const a = $("#rec-note");
  if (a) {
    const quiet = media && media.an && media.ctx && media.ctx.state === "running" && !media.heard && Date.now() - r.startedAt > 6000;
    a.textContent = quiet ? "Not hearing anything yet. Check that no other app is using the microphone."
      : r.awake ? "The screen stays on while it records. Leave the app open."
      : "Keep the app open with the screen on while it records.";
  }
}

/* ---------- the speech engine on the phone ---------- */
const SPEECH_MB = 137;
const asr = { w: null, ready: false, loading: null, jobs: new Map(), seq: 0, prog: null, onProg: null, threads: 0, err: "" };
function asrWorker() {
  if (asr.w) return asr.w;
  const w = asr.w = new Worker("asr-worker.js");
  w.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.t === "progress") { asr.prog = m; if (asr.onProg) asr.onProg(m); updateSpeech(); }
    else if (m.t === "ready") { asr.ready = true; state.speechKept = true; asr.threads = m.threads; asr.err = ""; S.put("kv", true, "speech-ready").catch(() => {}); if (asr.loading) { asr.loading.res(); asr.loading = null; } if (state.route.view === "setup") render(); }
    else if (m.t === "result" || m.t === "error") {
      const job = asr.jobs.get(m.id);
      if (m.t === "error" && !job && asr.loading) { asr.loading.rej(m); asr.loading = null; }
      if (job) { asr.jobs.delete(m.id); m.t === "result" ? job.res(m.lines) : job.rej({ code: m.code === "offline" ? "speech_offline" : m.code === "download" ? "speech_download" : "speech", message: m.message }); }
      if (m.t === "error") { asr.err = m.code; if (state.route.view === "setup") render(); }
    }
  };
  w.onerror = () => { const jobs = [...asr.jobs.values()]; asr.jobs.clear(); jobs.forEach((j) => j.rej({ code: "speech" })); try { w.terminate(); } catch (e) { /* fine */ } asr.w = null; };
  return w;
}
function loadSpeech() {
  if (asr.ready) return Promise.resolve();
  if (!asr.loading) {
    let res, rej; const p = new Promise((a, b) => { res = a; rej = b; });
    asr.loading = { p, res, rej };
    asrWorker().postMessage({ t: "load" });
    p.catch(() => { /* shown in Setup */ });
  }
  return asr.loading.p;
}
function transcribe(pcm, maxSecs, onProg, signal) {
  return new Promise((res, rej) => {
    const id = ++asr.seq;
    asr.jobs.set(id, { res, rej });
    asr.onProg = onProg;
    if (signal) signal.addEventListener("abort", () => {   // the engine can't be paused mid-piece, so it's restarted
      if (!asr.jobs.has(id)) return;
      asr.jobs.delete(id); try { asr.w.terminate(); } catch (e) { /* fine */ } asr.w = null; asr.ready = false; asr.loading = null;
      rej({ code: "cancelled" });
    });
    asrWorker().postMessage({ t: "run", id, pcm, maxSecs }, [pcm.buffer]);
  });
}
function updateSpeech() {
  const el = $("#speech-line"); if (!el || !asr.prog) return;
  const m = asr.prog;
  el.textContent = m.stage === "download" ? "Downloading the speech engine: " + Math.round(m.done / 1048576) + " of " + Math.round(m.total / 1048576) + " MB"
    : m.stage === "start" ? "Starting the speech engine" : "";
}
// Turns any recording into 16 kHz mono sound for the speech engine.
async function toPcm(blob, maxSecs) {
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new AC(1, 16000, 16000);
    const bytes = await blob.arrayBuffer();
    const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(bytes, res, rej); if (p && p.catch) p.catch(rej); });
    const len = Math.min(audio.duration, maxSecs);
    const off = new AC(1, Math.max(1, Math.ceil(len * 16000)), 16000);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0).slice();
  } catch (e) { throw { code: "decode" }; }
}
const linesText = (lines) => lines.map((l) => "[" + clock(l.at * 1000) + "] " + l.text).join("\n");

/* ---------- talking to Claude ---------- */
const API = "https://api.anthropic.com/v1";
const KEY_URL = "https://console.anthropic.com/settings/keys";
const BILLING_URL = "https://console.anthropic.com/settings/billing";
const DEFAULT_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5"];
async function cFetch(path, body, signal, key) {
  let res;
  try {
    res = await fetch(API + path, { method: body ? "POST" : "GET", cache: "no-store", signal,
      headers: Object.assign({ "x-api-key": key || state.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body ? { "content-type": "application/json" } : {}),
      body: body || undefined });
  } catch (e) { throw { code: signal && signal.aborted ? "cancelled" : navigator.onLine === false ? "offline" : "unreachable" }; }
  let data = null; try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) { const er = (data && data.error) || {}; throw { code: "http", status: res.status, type: er.type || "", message: String(er.message || "").slice(0, 300) }; }
  return data || {};
}
function sortErr(e) {
  if (!e || e.code !== "http") return (e && e.code) || "failed";
  const m = (e.message || "").toLowerCase();
  if (e.status === 401 || e.type === "authentication_error") return "badkey";
  if (/credit balance|billing|purchase credits|spend limit|usage limit/.test(m)) return "nocredit";
  if (e.status === 403 || e.type === "permission_error") return "denied";
  if (e.status === 404 || e.type === "not_found_error" || (/model/.test(m) && /not found|does not exist|invalid model/.test(m))) return "model";
  if (e.status === 429 || e.type === "rate_limit_error") return "busy";
  if (e.status === 529 || e.status >= 500 || e.type === "overloaded_error" || e.type === "api_error") return "busy";
  if (e.status === 413) return "big";
  return "rejected";
}
function rankModels(list) {
  const ids = (list || []).map((m) => String((m && m.id) || "")).filter((n) => /^claude-/.test(n));
  const ver = (n) => { const v = /-(\d+)(?:-(\d))?(?:-|$)/.exec(n.replace(/^claude-(sonnet|opus|haiku|fable)/, "")); return v ? +v[1] + (v[2] ? +v[2] / 10 : 0) : 0; };
  const fam = (n) => (/sonnet/.test(n) ? 0 : /opus/.test(n) ? 1 : /haiku/.test(n) ? 2 : 3);
  return ids.filter((n) => fam(n) < 3).sort((a, b) => fam(a) - fam(b) || ver(b) - ver(a) || a.length - b.length);
}
async function listModels(key) {
  const d = await cFetch("/models?limit=100", null, null, key);
  return rankModels(d.data || []);
}
function parseJson(text) {
  const t = String(text || "").trim();
  const tryIt = (s) => { try { return JSON.parse(s); } catch (e) { return undefined; } };
  let v = tryIt(t); if (v !== undefined) return v;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) { v = tryIt(fence[1].trim()); if (v !== undefined) return v; }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { v = tryIt(t.slice(a, b + 1)); if (v !== undefined) return v; }
  throw { code: "badjson" };
}
async function askClaude({ prompt, signal, onStep }) {
  if (!state.key) throw { code: "nokey" };
  let models = (state.models.length ? state.models : DEFAULT_MODELS).slice(), mi = 0, waited = 0, relisted = false, badJson = false;
  for (let tries = 0; tries < 10; tries++) {
    if (signal && signal.aborted) throw { code: "cancelled" };
    onStep("Claude is sorting out who's doing what");
    const model = models[mi];
    try {
      const d = await cFetch("/messages", JSON.stringify({ model, max_tokens: 12000,
        system: "You turn the morning crew meeting of an excavating company into a job sheet. Reply with JSON only, no other text.",
        messages: [{ role: "user", content: prompt }] }), signal);
      const text = (d.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("");
      if (!text.trim()) throw { code: d.stop_reason === "refusal" ? "blocked" : "empty" };
      let value;
      try { value = parseJson(text); } catch (e) { if (!badJson) { badJson = true; continue; } throw e; }
      if (mi > 0) { state.models = [model].concat(models.filter((x) => x !== model)); S.put("kv", state.models, "models").catch(() => {}); }
      return { value, model };
    } catch (e) {
      const kind = sortErr(e);
      if (kind === "model") {
        if (mi + 1 < models.length) { mi++; continue; }
        if (!relisted) { relisted = true; const fresh = await listModels().catch(() => []); if (fresh.length) { models = fresh; mi = 0; continue; } }
        throw { code: "nomodel", message: e.message };
      }
      if (kind === "busy" && waited < 2) { waited++; onStep("Claude is busy, trying again"); await sleep(waited * 5000); continue; }
      throw e && e.code && e.code !== "http" ? e : { code: kind, message: e && e.message };
    }
  }
  throw { code: "failed" };
}
function aiErr(e) {
  switch (e && e.code) {
    case "cancelled": return "";
    case "nokey": return "The Claude key isn't set up yet. Open Setup and add it. What was heard is saved, so the sheet builds as soon as the key is in.";
    case "badkey": return "Claude didn't accept the key. Open Setup and check it.";
    case "nocredit": return "Your Claude API account is out of credit. Add credit at console.anthropic.com, then tap Try again.";
    case "denied": return "Claude turned the request down.";
    case "offline": return "No signal. What was heard is saved on the phone, and the sheet builds when you have service.";
    case "unreachable": return "Couldn't reach Claude. Check your signal and tap Try again.";
    case "busy": return "Claude is busy right now. Wait a minute and tap Try again.";
    case "nomodel": return "Claude's models have changed. Open Setup and tap Check the key, then try again.";
    case "blocked": return "Claude wouldn't build a sheet from this one.";
    case "rejected": return "Claude wouldn't take the request.";
    case "big": return "This meeting is too long to send in one go.";
    case "decode": return "The phone couldn't read this recording. Try a different file.";
    case "speech_offline": return "The speech engine still needs to download once, and there's no signal. Try again on Wi-Fi.";
    case "speech_download": return "The speech engine didn't finish downloading. Try again on Wi-Fi.";
    case "speech": return "The speech engine stopped. Close the app, open it again and tap Try again.";
    case "noheard": return "No talking was picked up in this recording.";
    case "empty": case "badjson": return "Claude didn't send back a sheet. Tap Try again.";
    case "empty_sheet": return "No assignments were found in this one.";
    case "nothing": return "There's no recording or text saved for this day.";
    case "save_failed": return "The sheet was built but couldn't be saved on this phone. Free up some space and tap Try again.";
    default: return "Something went wrong building the sheet. Tap Try again.";
  }
}
const claudeSaid = (e) => (e && e.message && (e.status || /^(badkey|nocredit|denied|nomodel|rejected|busy|big)$/.test(e.code)) ? "Claude said: " + String(e.message).slice(0, 240) : "");

/* ---------- what the AI is asked ---------- */
const listBlock = (title, text) => title + ":\n" + (String(text || "").trim() || "(nothing listed yet)") + "\n\n";
const SHAPE = '{"headline": "one short line naming the main jobs of the day",\n'
  + ' "assignments": [{"who": ["First name"], "kind": "crew", "steps": [{"where": "Place", "what": "One plain sentence.", "how": ["a specific"]}], "bring": ["thing"], "notes": ["check-in or timing"], "unsure": ["what you could not make out"]}],\n'
  + ' "everyone": ["announcement for the whole crew"],\n'
  + ' "unsure": ["an instruction you could not tie to anyone"]}';
function rules(boss) {
  return "- One entry per person or crew, in the order they were called. People sent to do the same job together share one entry.\n"
    + "- \"who\": names as spelled on the People list. If a name is not on the list, spell it the way it sounds and say so in \"unsure\".\n"
    + "- \"kind\": \"crew\" for site work, \"truck\" for hauling and deliveries, \"move\" for moving machines, \"shop\" for shop and yard work, otherwise \"other\".\n"
    + "- \"steps\": in the order they happen. \"where\" is a short place name, or \"\" if none was said. \"what\" is one plain sentence. \"how\" holds the specifics, one short line each: directions to the site, quantities, sizes, depths, what to watch out for, who to see or call there. For hauling, say the material, where it is loaded, where it goes and how many loads.\n"
    + "- \"bring\": machines, trucks, tools, parts and materials they have to take.\n"
    + "- \"notes\": timing and check-ins, such as calling " + boss + " when done.\n"
    + "- \"everyone\": things said to the whole crew.\n"
    + "- Keep numbers, sizes, addresses and road names exactly as said. Leave out swearing. Never add anything that was not said.\n"
    + "- Leave an array empty when there is nothing for it.\n\n";
}
function background(n, boss, hasAudio) {
  return "How the meeting goes: " + boss + " runs it. He calls a person or a crew by name, then says where they are going, what to do there, how to do it, what to bring, and when to call him. Truck drivers get hauling runs: what material, where to load it, where to dump it, how many loads. Other people answer or ask questions now and then. Small talk before the first assignment, between assignments and after the last one is not part of the sheet."
    + (hasAudio ? " Recordings often keep running long after the assignments are done. Ignore that part." : "") + "\n\n"
    + (hasAudio
      ? "The transcript was made by a machine from a phone across a noisy shop, so many words are wrong, above all the names of people, places, machines and materials, and some are missing. Work out what was really said from how the words sound: a word that sounds like a name on the lists below is almost always that name (for example \"Strainer\" for Trainer). When you still cannot tell what was said, do not guess. Add a short line to \"unsure\" that quotes the words as heard.\n\n"
      : "Some words in the transcript may be wrong, above all the names of people, places, machines and materials. Use the lists below to work out what was meant: a word that looks like a name on a list is almost always that name. When you still cannot tell, do not guess. Add a short line to \"unsure\" that quotes the words as written.\n\n")
    + listBlock("PEOPLE", n.people) + listBlock("PLACES AND SUPPLIERS", n.places) + listBlock("MACHINES, TOOLS AND MATERIALS", n.gear)
    + (n.me ? "The person using this app is " + n.me + ".\n\n" : "");
}
const COMPANY = "an excavating company (site work, septic, water and sewer lines, and trucking of sand, gravel, stone and topsoil)";
const machine = (day) => day.source !== "typed";
function buildPrompt(day) {
  const n = names(), boss = n.boss || "The boss", when = fmtDate(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return (machine(day) ? "This is a speech-to-text transcript of a phone recording of the morning crew meeting at " : "This is a typed account of the morning crew meeting at ") + COMPANY + ". Turn it into the day's job sheet.\n\n"
    + background(n, boss, machine(day))
    + "Reply with only JSON in this shape:\n" + SHAPE + "\n\n"
    + "Rules:\n" + rules(boss)
    + "TRANSCRIPT (" + when + (machine(day) ? ", [m:ss] is the time into the recording" : "") + "):\n" + String(day.transcript || "").slice(0, 80000);
}
function fixPrompt(day, fix) {
  const n = names(), boss = n.boss || "The boss";
  return "This is about the morning crew meeting at " + COMPANY + ". A job sheet was already built from "
    + (machine(day) ? "a speech-to-text transcript of a phone recording of it" : "a typed account of it") + ", and the person who uses the sheet says something needs fixing.\n\n"
    + background(n, boss, machine(day))
    + "THE SHEET NOW:\n" + JSON.stringify(day.sheet) + "\n\n"
    + (day.transcript ? "WHAT WAS HEARD THE FIRST TIME:\n" + String(day.transcript).slice(0, 30000) + "\n\n" : "")
    + "WHAT NEEDS FIXING, in " + (n.me || "the user") + "'s words:\n" + fix + "\n\n"
    + "Apply the fix everywhere it matters, going back to the transcript where that helps, and keep everything else as it is. Reply with only JSON in this shape:\n"
    + '{"sheet": SHEET, "learn": {"people": ["line to add to the People list"], "places": ["line for the Places list"], "gear": ["line for the Machines list"]}}\nwhere SHEET is:\n' + SHAPE + "\n\n"
    + "Put a line in \"learn\" only when the fix teaches a name or term that is not on the lists yet, written like \"Name (how it was misheard) - what it is\". Otherwise leave those arrays empty.\n\n"
    + "Rules for the sheet:\n" + rules(boss);
}
const str = (x) => (typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim());
const strs = (x) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []).map(str).filter(Boolean).slice(0, 40);
function normalizeSheet(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw { code: "badjson" };
  const out = { headline: str(v.headline).slice(0, 220), assignments: [], everyone: strs(v.everyone), unsure: strs(v.unsure) };
  for (const a of (Array.isArray(v.assignments) ? v.assignments : []).slice(0, 60)) {
    if (!a || typeof a !== "object") continue;
    const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 20)
      .map((s) => (s && typeof s === "object" ? { where: str(s.where), what: str(s.what), how: strs(s.how) } : typeof s === "string" ? { where: "", what: s.trim(), how: [] } : null))
      .filter((s) => s && (s.where || s.what || s.how.length));
    const kind = ["crew", "truck", "move", "shop"].indexOf(a.kind) >= 0 ? a.kind : "other";
    const one = { who: strs(a.who), kind, steps, bring: strs(a.bring), notes: strs(a.notes), unsure: strs(a.unsure) };
    if (one.who.length || steps.length || one.notes.length || one.unsure.length) out.assignments.push(one);
  }
  if (!out.assignments.length && !out.everyone.length && !out.unsure.length) throw { code: "empty_sheet" };
  return out;
}

/* ---------- building and fixing a sheet ---------- */
async function buildSheet(id, fix) {
  const day = dayById(id);
  if (!day || state.build.status === "working") return;
  waiting.delete(id);
  const ctl = new AbortController();
  state.build = { id, status: "working", err: "", said: "", step: "Getting ready", ctl, fix: !!fix, startedAt: Date.now() };
  render();
  const timer = setInterval(updateBuild, 1000);
  const onStep = (s) => { state.build.step = s; updateBuild(); };
  try {
    let cur = clone(day);
    if (!String(cur.transcript || "").trim()) {
      if (!cur.hasAudio) throw { code: "nothing" };
      const rec = await S.get("audio", id).catch(() => null);
      if (!rec || !rec.blob) throw { code: "nothing" };
      onStep("Getting the recording ready");
      const pcm = await toPcm(rec.blob, MAX_AI_SECS);
      if (ctl.signal.aborted) throw { code: "cancelled" };
      onStep(asr.ready ? "Listening to the meeting on the phone" : "Starting the speech engine");
      const lines = await transcribe(pcm, MAX_AI_SECS, (m) => {
        onStep(m.stage === "download" ? "Downloading the speech engine (" + Math.round(m.done / 1048576) + " of " + Math.round(m.total / 1048576) + " MB, one time only)"
          : m.stage === "start" ? "Starting the speech engine"
          : "Listening to the meeting on the phone: " + Math.min(100, Math.round((m.done / Math.max(1, m.total)) * 100)) + "%");
      }, ctl.signal);
      if (!lines.length) throw { code: "noheard" };
      cur = Object.assign(clone(dayById(id) || cur), { transcript: linesText(lines), heardAt: Date.now() });
      await saveDay(cur);    // kept, so it never has to listen again
    }
    if (!state.key) throw { code: "nokey" };
    const res = await askClaude({ signal: ctl.signal, onStep, prompt: fix ? fixPrompt(cur, fix) : buildPrompt(cur) });
    const v = res.value || {};
    const sheet = normalizeSheet(v.sheet && !v.assignments ? v.sheet : v);
    const next = Object.assign(clone(dayById(id) || cur), { sheet, builtAt: Date.now(), model: res.model });
    if (fix) next.fixes = (next.fixes || []).concat([fix]).slice(-20);
    try { await saveDay(next); } catch (e) { throw { code: "save_failed" }; }
    if (fix && v.learn) await learnNames(v.learn);
    if (fix) state.fixText = "";
    state.build = Object.assign({}, IDLE_BUILD);
  } catch (e) {
    if (e && (e.code === "offline" || e.code === "unreachable")) waiting.add(id);
    state.build = Object.assign({}, IDLE_BUILD, { id, status: "failed", err: aiErr(e), said: claudeSaid(e), fix: !!fix });
  } finally { clearInterval(timer); render(); }
}
function updateBuild() {
  const el = $("#build-line"); if (!el) return;
  const b = state.build, secs = Math.max(0, Math.round((Date.now() - b.startedAt) / 1000));
  el.textContent = (b.step || "Working") + " · " + secs + "s";
}
window.addEventListener("online", () => {
  if (state.build.status === "working" || !state.key) return;
  const d = state.days.find((x) => !x.sheet && waiting.has(x.id));
  if (d) buildSheet(d.id);
});
async function learnNames(learn) {
  const n = names(), add = { people: strs(learn.people), places: strs(learn.places), gear: strs(learn.gear) }, got = [];
  for (const k of ["people", "places", "gear"]) for (const line of add[k]) {
    if (n[k].split("\n").some((l) => l.trim().toLowerCase() === line.toLowerCase())) continue;
    n[k] = (n[k].trim() ? n[k].trim() + "\n" : "") + line; got.push(line);
  }
  if (!got.length) return;
  state.names = n; state.namesDraft = null; state.flash = "Added to your names lists: " + got.join("; ");
  await S.put("kv", clone(n), "names").catch(() => {});
}

/* ---------- the Claude key ---------- */
async function checkKey() {
  const su = state.setup, k = su.draft.trim();
  if (!k) { su.ok = false; su.msg = "Paste the key in the box first."; su.said = ""; render(); return; }
  su.busy = true; su.msg = ""; su.said = ""; render();
  try {
    let ranked = [];
    try { ranked = await listModels(k); }
    catch (e) { const kind = sortErr(e); if (kind === "badkey" || kind === "offline" || kind === "unreachable" || kind === "denied") throw { code: kind, message: e.message }; }
    const order = DEFAULT_MODELS.filter((m) => !ranked.length || ranked.indexOf(m) >= 0).concat(ranked.filter((m) => DEFAULT_MODELS.indexOf(m) < 0));
    let good = null, last = null;
    for (const m of order.slice(0, 5)) {     // a one-word question, to be sure the key can really use Claude (costs a fraction of a cent)
      try { await cFetch("/messages", JSON.stringify({ model: m, max_tokens: 5, messages: [{ role: "user", content: "Reply with OK." }] }), null, k); good = m; break; }
      catch (e) { last = e; const kind = sortErr(e); if (kind !== "model") throw { code: kind, message: e.message }; }
    }
    if (!good) throw { code: sortErr(last), message: last && last.message };
    state.key = k; state.models = [good].concat(order.filter((x) => x !== good));
    await S.put("kv", k, "key"); await S.put("kv", state.models, "models");
    su.draft = ""; su.ok = true; su.msg = "The key works. Sheets will be built by " + good + ".";
    const w = state.days.find((x) => !x.sheet);
    if (w && state.build.status !== "working") waiting.add(w.id);
  } catch (e) {
    su.ok = false; su.said = claudeSaid(e);
    su.msg = e.code === "badkey" ? "Claude didn't accept that key. Copy it again and paste the whole thing (it starts with sk-ant-)."
      : e.code === "nocredit" ? "The key is fine, but the account has no credit yet. Add credit under Billing at console.anthropic.com, then check the key again."
      : e.code === "offline" ? "No signal. Try again when you have service."
      : e.code === "unreachable" ? "Couldn't reach Claude. Check your signal and try again."
      : e.code === "busy" ? "Claude is busy right now. Try again in a minute."
      : "Claude wouldn't use that key.";
  }
  su.busy = false; render();
}
async function forgetKey() {
  state.key = ""; state.models = [];
  await S.del("kv", "key").catch(() => {}); await S.del("kv", "models").catch(() => {});
  state.setup.ok = null; state.setup.msg = "The key was taken off this phone."; state.setup.said = ""; render();
}

/* ---------- backup ---------- */
function backupData() {
  return { app: "morning-meeting", v: 1, saved: new Date().toISOString(), names: names(),
    days: state.days.map((d) => { const c = clone(d); delete c.hasAudio; delete c.audioSecs; delete c.audioBytes; return c; }) };
}
function saveBackup() {
  const su = state.setup;
  try {
    const blob = new Blob([JSON.stringify(backupData(), null, 1)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "morning-meeting-backup-" + todayStr() + ".json" });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    su.bok = true; su.bmsg = "Saved to your Downloads. It holds the sheets and names lists, not the recordings.";
  } catch (e) { su.bok = false; su.bmsg = "Couldn't save the file."; }
  render();
}
async function loadBackup(file) {
  const su = state.setup; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || (!Array.isArray(data.days) && !data.names)) throw 0;
    let added = 0, gotNames = false;
    if (data.names && typeof data.names === "object") {
      const n = names();
      for (const k of ["me", "boss"]) if (!n[k] && typeof data.names[k] === "string") { n[k] = data.names[k].trim(); gotNames = true; }
      for (const k of ["people", "places", "gear"]) {
        const have = n[k].split("\n").map((l) => l.trim()).filter(Boolean), seen = new Set(have.map((l) => l.toLowerCase()));
        for (const line of String(data.names[k] || "").split("\n").map((l) => l.trim()).filter(Boolean)) if (!seen.has(line.toLowerCase())) { have.push(line); seen.add(line.toLowerCase()); gotNames = true; }
        n[k] = have.join("\n");
      }
      if (gotNames) { state.names = n; state.namesDraft = null; await S.put("kv", clone(n), "names"); }
    }
    for (const d of Array.isArray(data.days) ? data.days : []) {
      if (!d || typeof d.id !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(d.date || "")) continue;
      const mine = dayById(d.id);
      if (mine && (mine.sheet || !d.sheet)) continue;
      let sheet = null; try { sheet = d.sheet ? normalizeSheet(d.sheet) : null; } catch (e) { sheet = null; }
      await saveDay(Object.assign({}, mine || {}, { id: d.id, date: d.date.slice(0, 10), createdAt: Number(d.createdAt) || Date.now(), source: str(d.source) || "backup",
        transcript: str(d.transcript), sheet, hasAudio: !!(mine && mine.hasAudio) }));
      added++;
    }
    su.bok = true;
    su.bmsg = added || gotNames ? "Loaded " + (added ? added + (added === 1 ? " day" : " days") : "") + (added && gotNames ? " and " : "") + (gotNames ? "the names lists" : "") + "." : "Everything in that file is already here.";
  } catch (e) { su.bok = false; su.bmsg = "That file isn't a Morning Meeting backup or setup file."; }
  render();
}
async function clearOldRecordings() {
  const su = state.setup, cut = dstr(new Date(Date.now() - 30 * 86400000)); let n = 0;
  for (const d of state.days) if (d.hasAudio && d.date < cut) { await S.del("audio", d.id).catch(() => {}); await saveDay(Object.assign({}, d, { hasAudio: false })); n++; }
  su.bok = true; su.bmsg = n ? "Cleared " + n + (n === 1 ? " recording" : " recordings") + " older than 30 days. The sheets are still here." : "There are no recordings older than 30 days.";
  await usage(); render();
}
async function usage() {
  try { const e = await navigator.storage.estimate(); state.setup.used = e && e.usage ? mb(e.usage) : ""; } catch (e) { state.setup.used = ""; }
}

/* ---------- the sheet on screen ---------- */
const KINDS = { crew: "Crew", truck: "Truck", move: "Move", shop: "Shop", other: "Other" };
const GROUPS = [["crew", "Crews"], ["truck", "Trucks"], ["move", "Moving machines"], ["shop", "Shop and yard"], ["other", "Other"]];
function isMine(a) {
  const me = names().me.trim().toLowerCase(); if (!me) return false;
  return a.who.some((w) => { const x = w.toLowerCase(); return x === me || x.indexOf(me + " ") === 0; });
}
function crewBlock(a, mine) {
  return h("article", { class: "crew" + (mine ? " mine" : "") },
    h("header", null, h("h3", null, a.who.length ? a.who.join(" · ") : "Name not caught"), h("span", { class: "kind" }, mine ? "Your job" : KINDS[a.kind] || "Other")),
    a.steps.length ? h("ol", { class: "steps" + (a.steps.length === 1 ? " one" : "") }, a.steps.map((s) => h("li", null, h("div", null,
      s.where ? h("div", { class: "where" }, s.where) : null,
      s.what ? h("div", { class: "what" }, s.what) : null,
      s.how.length ? h("ul", { class: "how" }, s.how.map((x) => h("li", null, x))) : null)))) : null,
    a.bring.length ? h("div", { class: "bring" }, h("span", { class: "lab" }, "Bring"), h("ul", { class: "chips" }, a.bring.map((x) => h("li", null, x)))) : null,
    a.notes.length ? h("ul", { class: "notes" }, a.notes.map((x) => h("li", null, x))) : null,
    a.unsure.length ? h("div", { class: "unsure" }, h("span", { class: "lab" }, "Couldn't make out"), a.unsure.map((x) => h("div", null, x))) : null);
}
function sheetBlocks(sheet) {
  const out = [], all = sheet.assignments || [], mine = all.filter(isMine);
  if (mine.length) out.push(h("h3", { class: "sec-h" }, "Your job"), mine.map((a) => crewBlock(a, true)));
  for (const [kind, title] of GROUPS) {
    const list = all.filter((a) => a.kind === kind && !isMine(a));
    if (list.length) out.push(h("h3", { class: "sec-h" }, title), list.map((a) => crewBlock(a, false)));
  }
  if (sheet.everyone && sheet.everyone.length) out.push(h("h3", { class: "sec-h" }, "For everyone"), h("ul", { class: "plain" }, sheet.everyone.map((x) => h("li", null, x))));
  if (sheet.unsure && sheet.unsure.length) out.push(h("div", { class: "unsure" }, h("span", { class: "lab" }, "Couldn't make out"), sheet.unsure.map((x) => h("div", null, x))));
  return out;
}
function sheetText(day) {
  const s = day.sheet, L = ["MORNING MEETING - " + fmtDate(day.date, { weekday: "long", month: "long", day: "numeric" }), ""];
  for (const a of s.assignments) {
    L.push((a.who.join(", ") || "NAME NOT CAUGHT").toUpperCase());
    a.steps.forEach((st, i) => { L.push((a.steps.length > 1 ? (i + 1) + ". " : "") + [st.where, st.what].filter(Boolean).join(": ")); st.how.forEach((x) => L.push("   - " + x)); });
    if (a.bring.length) L.push("Bring: " + a.bring.join(", "));
    a.notes.forEach((x) => L.push("Note: " + x));
    a.unsure.forEach((x) => L.push("Unclear: " + x));
    L.push("");
  }
  if (s.everyone.length) { L.push("EVERYONE"); s.everyone.forEach((x) => L.push("- " + x)); L.push(""); }
  if (s.unsure.length) { L.push("UNCLEAR"); s.unsure.forEach((x) => L.push("- " + x)); }
  return L.join("\n").trim();
}
const crewCount = (sheet) => sheet.assignments.length + (sheet.assignments.length === 1 ? " crew" : " crews");
const backLink = () => h("div", null, h("button", { class: "navlink", type: "button", onclick: () => go({ view: "home" }) }, "‹ All days"));
const note = (text, ok, said) => h("p", { class: "msg" + (ok ? " ok" : "") }, text, said ? h("span", { class: "said" }, said) : null);

function header() {
  const v = state.route.view;
  return h("header", { class: "top" },
    h("button", { class: "brand", type: "button", onclick: () => { if (v !== "home" && !recBusy()) go({ view: "home" }); } }, h("i"), "Morning Meeting"),
    recBusy() ? null : h("nav", { class: "topnav" },
      h("button", { class: "navlink" + (v === "names" ? " on" : ""), type: "button", onclick: () => { if (v !== "names") { state.namesDraft = null; state.namesMsg = ""; go({ view: "names" }); } } }, "Names"),
      h("button", { class: "navlink" + (v === "setup" ? " on" : ""), type: "button", onclick: () => { if (v !== "setup") { usage().then(render); go({ view: "setup" }); } } }, "Setup")));
}
function recCard() {
  const r = state.rec;
  if (r.phase === "recording" || r.phase === "saving") {
    return h("section", { class: "rec" },
      h("div", { class: "rec-head" }, h("div", { class: "rec-state" }, h("b"), r.phase === "saving" ? "Saving" : "Recording"),
        h("div", { class: "timer", id: "rec-timer" }, clock(r.phase === "recording" ? Date.now() - r.startedAt : r.ms))),
      h("div", { class: "meter", "aria-hidden": "true" }, h("i", { id: "rec-meter" })),
      h("button", { class: "rec-btn stop", id: "rec-stop", type: "button", disabled: r.phase !== "recording", onclick: stopRec }, h("span", { class: "dot" }), "Stop and build the sheet"),
      h("p", { class: "muted small", id: "rec-note" }, "Keep the app open with the screen on while it records."));
  }
  return h("section", { class: "rec" },
    h("button", { class: "rec-btn", id: "rec-start", type: "button", disabled: r.phase === "starting", onclick: startRec }, h("span", { class: "dot" }), r.phase === "starting" ? "Getting the mic ready" : "Record the meeting"),
    r.err ? note(r.err) : h("p", { class: "muted small" }, "Tap when the meeting starts. Tap Stop when it's over and the sheet builds itself."),
    h("div", { class: "links" },
      h("button", { class: "navlink", type: "button", onclick: () => { state.add = { file: null, date: todayStr(), err: "", busy: false }; go({ view: "add" }); } }, "Add a recording from your phone"),
      h("button", { class: "navlink", type: "button", onclick: () => go({ view: "type" }) }, "Type or paste a meeting")));
}
function installCard() {
  if (state.standalone) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  return h("div", { class: "plain banner" },
    h("p", null, h("strong", null, "Put this app on your phone. "), state.installEvt ? "It gets its own icon and opens full screen." : ios ? "In Safari, tap the Share button, then Add to Home Screen." : "In Chrome, tap the ⋮ menu, then Add to Home screen or Install app."),
    state.installEvt ? h("button", { class: "btn", type: "button", onclick: async () => { const ev = state.installEvt; state.installEvt = null; try { await ev.prompt(); } catch (e) { /* fine */ } render(); } }, "Install the app") : null);
}
function homeView() {
  const out = [];
  if (state.storeErr) out.push(note("This phone isn't letting the app save anything. Free up some space, then close the app and open it again."));
  if (state.update && !recBusy()) out.push(h("div", { class: "plain banner" }, h("p", null, "A newer version of the app is ready."), h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Update now")));
  if (state.flash) out.push(note(state.flash));
  if (!recBusy() && !state.key) out.push(h("div", { class: "plain banner" },
    h("p", null, h("strong", null, "One-time setup. "), "The app needs a Claude key and its speech engine before it can build sheets. You can record without them, and the recording waits on the phone."),
    h("button", { class: "btn", type: "button", onclick: () => { usage().then(render); go({ view: "setup" }); } }, "Set it up")));
  out.push(recCard());
  if (recBusy()) return out;
  if (state.key && !names().people.trim()) out.push(note("Your names lists are empty, so Claude will have to guess at names. Load your setup file in Setup, or fill them in under Names."));
  out.push(installCard());
  if (!state.days.length) { out.push(h("p", { class: "muted" }, "No meetings yet. Record your first one.")); return out; }
  const latest = state.days[0];
  if (latest.sheet) {
    const mine = latest.sheet.assignments.filter(isMine);
    if (mine.length) out.push(h("h2", { class: "sec-h" }, "Your job · " + fmtDate(latest.date, { weekday: "long", month: "short", day: "numeric" })), mine.map((a) => crewBlock(a, true)));
  }
  out.push(h("h2", { class: "sec-h" }, "Days"), h("div", { class: "days" }, state.days.map((d) => h("button", { class: "dayrow", type: "button", onclick: () => go({ view: "day", id: d.id }) },
    h("span", { class: "d" }, h("small", null, fmtDate(d.date, { weekday: "short" })), fmtDate(d.date, { month: "short", day: "numeric" })),
    h("span", { class: "t" }, d.sheet ? (d.sheet.headline || crewCount(d.sheet)) : state.build.id === d.id && state.build.status === "working" ? "Building the sheet…" : d.hasAudio ? "Recorded. The sheet isn't built yet." : "Saved. The sheet isn't built yet."),
    h("span", { class: "go", "aria-hidden": "true" }, "›")))));
  return out;
}

/* ---------- one day ---------- */
function dropPlayer() { if (!player) return; try { player.el.pause(); URL.revokeObjectURL(player.url); } catch (e) { /* fine */ } player = null; }
async function mountPlayer(day) {
  const slot = $("#player-slot"); if (!slot || !day.hasAudio) return;
  if (!player || player.id !== day.id) {
    dropPlayer();
    const rec = await S.get("audio", day.id).catch(() => null);
    if (!rec || !rec.blob || state.route.view !== "day" || state.route.id !== day.id) return;
    const url = URL.createObjectURL(rec.blob), el = h("audio", { controls: true, preload: "metadata", src: url });
    // Recordings made in the app don't carry their length, so the player is nudged to work it out.
    el.addEventListener("loadedmetadata", () => { if (el.duration === Infinity) { el.currentTime = 1e7; el.addEventListener("timeupdate", function once() { el.removeEventListener("timeupdate", once); el.currentTime = 0; }); } });
    player = { id: day.id, el, url, blob: rec.blob, name: rec.name || "meeting-" + day.id };
  }
  const now = $("#player-slot"); if (!now) return;
  now.replaceChildren(player.el,
    h("div", { class: "row" },
      canShareFile() ? h("button", { class: "btn ghost", type: "button", onclick: shareRecording }, "Send the recording") : null,
      h("button", { class: "btn ghost", type: "button", onclick: downloadRecording }, "Save it to Downloads")));
}
const recFile = () => new File([player.blob], player.name, { type: /\.webm$/i.test(player.name) ? "video/webm" : (player.blob.type || "application/octet-stream").split(";")[0] });
function canShareFile() { try { return !!(navigator.canShare && player && navigator.canShare({ files: [recFile()] })); } catch (e) { return false; } }
async function shareRecording() {
  if (!player) return;
  try { await navigator.share({ files: [recFile()], title: "Morning meeting recording" }); } catch (e) { /* closed */ }
}
function downloadRecording() {
  if (!player) return;
  const a = h("a", { href: player.url, download: player.name }); document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
}
async function shareSheet(day) {
  const text = sheetText(day);
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); state.copyText = "ok"; } catch (e) { state.copyText = text; }
  render();
}
async function copySheet(day) {
  const text = sheetText(day);
  try { await navigator.clipboard.writeText(text); state.copyText = "ok"; } catch (e) { state.copyText = text; }
  render();
}
async function removeDay(id) {
  try {
    await S.del("days", id); await S.del("audio", id).catch(() => {});
    state.days = state.days.filter((d) => d.id !== id); waiting.delete(id);
    if (state.build.id === id) state.build = Object.assign({}, IDLE_BUILD);
    dropPlayer(); goReplace({ view: "home" });
  } catch (e) { state.confirmDelete = false; state.flash = "Couldn't delete it. Try again."; render(); }
}
function dayView() {
  const day = dayById(state.route.id), b = state.build, mineBuild = b.id === state.route.id, working = mineBuild && b.status === "working";
  if (!day) return [backLink(), h("p", { class: "muted" }, "That day isn't here any more.")];
  const out = [backLink(), h("div", { class: "day-h" },
    h("div", { class: "wk" }, fmtDate(day.date, { weekday: "long" })),
    h("h2", null, fmtDate(day.date, { month: "long", day: "numeric" })),
    day.sheet && day.sheet.headline ? h("p", null, day.sheet.headline) : null)];
  if (state.flash) out.push(note(state.flash));
  if (working) out.push(h("div", { class: "plain" }, h("div", { id: "build-line" }, b.step || "Working"), h("div", { class: "bar" }, h("i")),
    h("div", null, h("button", { class: "btn ghost", type: "button", onclick: () => b.ctl && b.ctl.abort() }, "Stop"))));
  if (mineBuild && b.status === "failed" && b.err) out.push(note(b.err, false, b.said));
  if (!day.sheet) {
    if (!working) out.push(h("div", { class: "plain" },
      h("p", null, day.hasAudio ? "The recording is saved on this phone" + (day.audioSecs ? " (" + clock(day.audioSecs * 1000) + ")" : "") + "." + (day.transcript ? " It's been turned into words, but the sheet isn't built yet." : " The sheet isn't built yet.") : "What was said is saved. The sheet isn't built yet."),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => buildSheet(day.id) }, mineBuild && b.status === "failed" ? "Try again" : day.transcript || state.key ? "Build the sheet" : "Turn it into words"),
        state.key ? null : h("button", { class: "btn ghost", type: "button", onclick: () => { usage().then(render); go({ view: "setup" }); } }, "Set up the Claude key"))));
  } else {
    out.push(sheetBlocks(day.sheet));
    out.push(h("div", { class: "row" },
      navigator.share ? h("button", { class: "btn", type: "button", onclick: () => shareSheet(day) }, "Send the sheet") : null,
      h("button", { class: "btn ghost", type: "button", onclick: () => copySheet(day) }, "Copy as text")));
    if (state.copyText) out.push(h("div", { class: "field" }, h("label", { for: "copy-box" }, state.copyText === "ok" ? "Copied. Paste it into a text or email." : "Press and hold to copy:"),
      state.copyText === "ok" ? null : h("textarea", { id: "copy-box", readonly: true, value: state.copyText })));
    if (state.key) out.push(h("div", { class: "field" },
      h("label", { for: "fix-box" }, "Something wrong?"),
      h("span", { class: "hint" }, "Say what to fix in your own words, like a name it got wrong. Claude fixes the sheet and learns names for next time."),
      h("textarea", { id: "fix-box", value: state.fixText, placeholder: "Example: \"Woochi\" is Butch. The hay job was in Cleverdale.", oninput: (e) => { state.fixText = e.target.value; } }),
      h("div", null, h("button", { class: "btn", type: "button", disabled: working, onclick: () => { const t = state.fixText.trim(); if (t) { state.flash = ""; buildSheet(day.id, t); } } }, "Fix the sheet"))));
  }
  out.push(h("details", { id: "said" }, h("summary", null, "What was said"),
    h("div", { class: "said-box" },
      day.hasAudio ? h("div", { id: "player-slot" }, h("p", { class: "muted small" }, "Loading the recording…")) : null,
      h("p", { class: "heard" }, day.transcript || (day.hasAudio ? "The written version shows up here once the recording has been turned into words." : "Nothing was saved for this day.")))));
  out.push(h("div", { class: "row" },
    day.sheet && state.key ? h("button", { class: "btn ghost", type: "button", disabled: working, onclick: () => buildSheet(day.id) }, "Build it again") : null,
    day.hasAudio && day.transcript && day.source !== "typed" ? h("button", { class: "btn ghost", type: "button", disabled: working, onclick: async () => { const d = Object.assign(clone(day), { transcript: "" }); await saveDay(d); buildSheet(day.id); } }, "Listen again") : null,
    state.confirmDelete ? [h("span", null, "Delete this day for good?"), h("button", { class: "btn danger", type: "button", onclick: () => removeDay(day.id) }, "Yes, delete"), h("button", { class: "btn ghost", type: "button", onclick: () => { state.confirmDelete = false; render(); } }, "Keep it")]
      : h("button", { class: "btn danger", type: "button", disabled: working, onclick: () => { state.confirmDelete = true; render(); } }, "Delete this day")));
  return out;
}

/* ---------- other screens ---------- */
function typeView() {
  const t = state.type;
  return [backLink(),
    h("div", { class: "day-h" }, h("h2", null, "Type or paste a meeting"), h("p", null, "For when recording isn't possible. Your keyboard's microphone button works here too.")),
    h("div", { class: "field" }, h("label", { for: "type-date" }, "Which day"), h("input", { type: "date", id: "type-date", value: t.date, oninput: (e) => { t.date = e.target.value; } })),
    h("div", { class: "field" }, h("label", { for: "type-text" }, "What was said"), h("textarea", { id: "type-text", style: "min-height:240px", value: t.text, oninput: (e) => { t.text = e.target.value; } })),
    t.err ? note(t.err) : null,
    h("div", null, h("button", { class: "btn", type: "button", onclick: saveTyped }, state.key ? "Build the sheet" : "Save it"))];
}
async function saveTyped() {
  const t = state.type, text = t.text.trim();
  if (words(text) < 12) { t.err = "Add more of what was said first."; render(); return; }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : todayStr();
  try {
    const id = freshId(date);
    await saveDay({ id, date, createdAt: Date.now(), source: "typed", hasAudio: false, transcript: text, sheet: null });
    state.type = { date: todayStr(), text: "", err: "" };
    goReplace({ view: "day", id }); if (state.key) buildSheet(id);
  } catch (e) { t.err = "Couldn't save it on this phone. Free up some space and try again."; render(); }
}
function addView() {
  const a = state.add;
  return [backLink(),
    h("div", { class: "day-h" }, h("h2", null, "Add a recording"), h("p", null, "Pick a voice memo that's already on your phone, like one from your recorder app.")),
    h("div", { class: "field" }, h("label", { for: "add-file" }, "The recording"),
      h("input", { type: "file", id: "add-file", accept: "audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.webm,.flac,.3gp,.amr",
        onchange: (e) => { const f = e.target.files && e.target.files[0]; a.file = f || null; a.err = ""; if (f && f.lastModified) a.date = dstr(new Date(f.lastModified)); render(); } }),
      a.file ? h("span", { class: "hint" }, a.file.name + " · " + mb(a.file.size) + (a.file.size > 30 * 1048576 ? ". It's a long one, so only the first 20 minutes are listened to." : "")) : null),
    a.file ? h("div", { class: "field" }, h("label", { for: "add-date" }, "Which day was the meeting"), h("input", { type: "date", id: "add-date", value: a.date, oninput: (e) => { a.date = e.target.value; } })) : null,
    a.err ? note(a.err) : null,
    a.file ? h("div", null, h("button", { class: "btn", type: "button", disabled: a.busy, onclick: saveAdded }, "Save it and build the sheet")) : null];
}
async function saveAdded() {
  const a = state.add; if (!a.file || a.busy) return;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : todayStr();
  a.busy = true; render();
  try {
    const id = freshId(date), f = a.file;
    await saveRecording(id, date, f.slice(0, f.size, f.type), 0, "file", f.lastModified || Date.now(), f.name);
    state.add = { file: null, date: todayStr(), err: "", busy: false };
    goReplace({ view: "day", id }); buildSheet(id);
  } catch (e) { a.busy = false; a.err = "Couldn't save that recording on this phone. Free up some space and try again."; render(); }
}
function namesView() {
  if (state.namesDraft === null) state.namesDraft = names();
  const d = state.namesDraft;
  const field = (key, label, hint, big) => h("div", { class: "field" }, h("label", { for: "nm-" + key }, label), hint ? h("span", { class: "hint" }, hint) : null,
    big ? h("textarea", { id: "nm-" + key, style: "min-height:200px", value: d[key], oninput: (e) => { d[key] = e.target.value; } })
      : h("input", { type: "text", id: "nm-" + key, autocomplete: "off", value: d[key], oninput: (e) => { d[key] = e.target.value; } }));
  return [h("div", { class: "day-h" }, h("h2", null, "Names"), h("p", null, "The AI uses these lists to get names right. One per line. Put nicknames in brackets and what they do after a dash.")),
    field("me", "Your first name", "Your own job is shown first on every sheet."),
    field("boss", "Who runs the meeting"),
    field("people", "People", "Crew, drivers, customers and contacts.", true),
    field("places", "Places and suppliers", "Job sites, pits, towns, vendors.", true),
    field("gear", "Machines, tools and materials", null, true),
    state.namesMsg ? note(state.namesMsg, state.namesMsg === "Saved.") : null,
    h("div", null, h("button", { class: "btn", type: "button", onclick: saveNames }, "Save names"))];
}
async function saveNames() {
  const d = state.namesDraft; if (!d) return;
  const cleaned = { me: d.me.trim(), boss: d.boss.trim(), people: d.people.trim(), places: d.places.trim(), gear: d.gear.trim() };
  try { await S.put("kv", cleaned, "names"); state.names = cleaned; state.namesMsg = "Saved."; }
  catch (e) { state.namesMsg = "Couldn't save on this phone. Free up some space and try again."; }
  render();
}
function setupView() {
  const su = state.setup, model = state.models[0], sp = asr.prog;
  const speechBusy = !!asr.loading && !asr.ready;
  return [h("div", { class: "day-h" }, h("h2", null, "Setup")),
    h("h3", { class: "sec-h" }, "Claude key"),
    state.key ? note("The key is on this phone" + (model ? ". Sheets are built by " + model + "." : "."), true) : null,
    h("div", { class: "plain" },
      h("p", null, "Claude builds the sheets. A downloaded app can't use your Claude subscription, so it needs a Claude API key. The API is billed separately from the subscription, pay as you go: a meeting costs a few cents."),
      h("ol", { class: "howto" },
        h("li", null, h("span", null, "Tap ", h("strong", null, "Get a Claude key"), " and sign in or make an account at console.anthropic.com.")),
        h("li", null, h("span", null, "Under ", h("strong", null, "Billing"), ", add a little credit ($5 lasts a long time).")),
        h("li", null, h("span", null, "Under ", h("strong", null, "API keys"), ", tap ", h("strong", null, "Create key"), " and copy it.")),
        h("li", null, h("span", null, "Come back here, paste it in the box and tap ", h("strong", null, "Check the key"), "."))),
      h("div", { class: "row" },
        h("a", { class: "btn ghost", href: KEY_URL, target: "_blank", rel: "noopener" }, "Get a Claude key"),
        h("a", { class: "btn ghost", href: BILLING_URL, target: "_blank", rel: "noopener" }, "Add credit")),
      h("p", { class: "muted small" }, "The key is kept on this phone only. Don't share it. Only the written words of the meeting go to Claude, never the recording.")),
    h("div", { class: "field" }, h("label", { for: "key-box" }, state.key ? "Put in a different key" : "Paste the key here"),
      h("input", { type: "password", id: "key-box", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "sk-ant-…", value: su.draft, oninput: (e) => { su.draft = e.target.value; } })),
    su.msg ? note(su.msg, su.ok === true, su.said) : null,
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", disabled: su.busy, onclick: checkKey }, su.busy ? "Checking with Claude…" : "Check the key"),
      state.key ? h("button", { class: "btn danger", type: "button", disabled: su.busy, onclick: forgetKey }, "Take the key off this phone") : null),
    h("h3", { class: "sec-h" }, "Speech engine"),
    h("div", { class: "plain" },
      h("p", null, "The app turns the recording into words right here on the phone, so the recording never leaves it. The engine is a one-time download of about " + SPEECH_MB + " MB. Use Wi-Fi."),
      asr.ready || (state.speechKept && !speechBusy && !asr.err) ? note("The speech engine is on this phone" + (asr.threads > 1 ? " and uses " + asr.threads + " cores." : "."), true)
        : speechBusy ? h("div", { class: "stack", style: "gap:8px" }, h("p", { id: "speech-line" }, "Getting the speech engine"), h("div", { class: "bar" }, h("i")))
        : h("div", { class: "stack", style: "gap:8px" },
            asr.err ? note(asr.err === "offline" ? "No signal. Try again on Wi-Fi." : "The download didn't finish. Try again on Wi-Fi.") : null,
            h("div", null, h("button", { class: "btn", type: "button", onclick: () => { asr.err = ""; loadSpeech().catch(() => {}).then(render); render(); } }, state.speechKept ? "Start the speech engine" : "Download the speech engine")))),
    h("h3", { class: "sec-h" }, "Backup and setup files"),
    h("p", { class: "muted small" }, "Sheets, names and recordings live on this phone only" + (su.used ? " (" + su.used + " so far, with the speech engine)" : "") + ". A backup file holds the sheets and names lists."),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: saveBackup }, "Save a backup file"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { const i = $("#load-file"); if (i) i.click(); } }, "Load a backup or setup file"),
      h("button", { class: "btn ghost", type: "button", onclick: clearOldRecordings }, "Clear recordings older than 30 days")),
    h("input", { type: "file", id: "load-file", accept: ".json,application/json,text/plain", hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; loadBackup(f); } }),
    su.bmsg ? note(su.bmsg, su.bok === true) : null,
    h("p", { class: "foot" }, "Version " + VERSION + ". Speech engine: NVIDIA Parakeet TDT 110M (CC-BY-4.0), run with ONNX Runtime.")];
}

/* ---------- drawing ---------- */
function render() {
  const root = $("#app"); if (!root) return;
  if (!state.ready) return;
  const act = document.activeElement;
  const keep = act && act.id && root.contains(act) ? { id: act.id, s: act.selectionStart, e: act.selectionEnd } : null;
  const saidOpen = !!$("#said[open]");
  const v = state.route.view;
  const body = v === "day" ? dayView() : v === "names" ? namesView() : v === "type" ? typeView() : v === "add" ? addView() : v === "setup" ? setupView() : homeView();
  root.replaceChildren(header(), h("main", { class: "stack" }, body));
  if (saidOpen) { const d = $("#said"); if (d) d.open = true; }
  if (keep) { const el = document.getElementById(keep.id); if (el) { try { el.focus({ preventScroll: true }); if (keep.s != null && el.setSelectionRange) el.setSelectionRange(keep.s, keep.e); } catch (e) { /* fine */ } } }
  updateRec(); updateBuild();
  if (v === "day") { const day = dayById(state.route.id); if (day) mountPlayer(day); }
}

/* ---------- starting up ---------- */
function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then((reg) => { swReg = reg; }).catch(() => { /* the app still works while it's open */ });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!had) return;
    const busy = recBusy() || state.build.status === "working" || state.fixText.trim() || state.type.text.trim() || state.setup.draft.trim() || state.route.view === "names";
    if (busy) { state.update = true; render(); } else location.reload();
  });
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.installEvt = e; render(); });
window.addEventListener("appinstalled", () => { state.installEvt = null; state.standalone = true; render(); });

async function boot() {
  state.standalone = isStandalone();
  try {
    const [days, nm, key, models, sp] = await Promise.all([S.all("days"), S.get("kv", "names"), S.get("kv", "key"), S.get("kv", "models"), S.get("kv", "speech-ready")]);
    state.speechKept = !!sp;
    state.days = sortDays(days || []);
    if (nm && typeof nm === "object") state.names = Object.assign({}, EMPTY_NAMES, nm);
    state.key = typeof key === "string" ? key : "";
    state.models = Array.isArray(models) ? models.filter((m) => typeof m === "string" && /^claude-/.test(m)) : [];
    await recoverCutOff();
  } catch (e) { state.storeErr = true; }
  state.ready = true;
  try { history.replaceState({ mm: 1, base: 1, r: { view: "home" } }, ""); } catch (e) { /* fine */ }
  render();
  registerSw();
}
boot();
})();
