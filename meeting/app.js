/* Morning Meeting. Records the morning meeting, sends the recording to Google's AI together with the names lists,
   and shows the day's job sheet. Recordings, sheets, names and the AI key are kept on this phone only.
   Nothing is stored on the website the app comes from. */
(() => {
"use strict";

const VERSION = self.MM_VERSION || "dev";
const MAX_REC_MS = 35 * 60 * 1000;        // a forgotten recording stops itself
const INLINE_MAX = 13.5 * 1024 * 1024;    // Google takes 20 MB per request, and sending adds a third
const MAX_AI_SECS = 20 * 60;              // when a long recording has to be shrunk, only its start goes to the AI
const API = "https://generativelanguage.googleapis.com/v1beta";
const KEY_URL = "https://aistudio.google.com/apikey";
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

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

/* ---------- getting a recording ready for Google's AI ---------- */
const BY_EXT = { m4a: "audio/m4a", mp4: "audio/m4a", mp3: "audio/mp3", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", weba: "audio/webm", flac: "audio/flac", aac: "audio/aac", aif: "audio/aiff", aiff: "audio/aiff" };
const BY_TYPE = { "audio/webm": "audio/webm", "video/webm": "audio/webm", "audio/ogg": "audio/ogg", "audio/mpeg": "audio/mp3", "audio/mp3": "audio/mp3", "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/flac": "audio/flac", "audio/x-flac": "audio/flac", "audio/aac": "audio/aac", "audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a", "audio/m4a": "audio/m4a", "video/mp4": "audio/m4a", "audio/aiff": "audio/aiff", "audio/x-aiff": "audio/aiff" };
function apiMime(blob, name) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name || "") || [])[1];
  if (ext && BY_EXT[ext.toLowerCase()]) return BY_EXT[ext.toLowerCase()];
  return BY_TYPE[(blob.type || "").split(";")[0].toLowerCase()] || null;
}
function toBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); };
    fr.onerror = () => rej({ code: "decode" });
    fr.readAsDataURL(blob);
  });
}
let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return lameLoading || (lameLoading = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "vendor/lame.min.js";
    s.onload = () => (window.lamejs ? res() : rej({ code: "decode" }));
    s.onerror = () => { lameLoading = null; rej({ code: "decode" }); };
    document.head.appendChild(s);
  }));
}
// Shrinks a recording to a small MP3 (16 kHz, one channel), which Google's AI always accepts. Only the first maxSecs are kept.
async function toMp3(blob, maxSecs, signal) {
  try {
    await loadLame();
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new AC(1, 16000, 16000);
    const bytes = await blob.arrayBuffer();
    const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(bytes, res, rej); if (p && p.catch) p.catch(rej); });
    const rate = audio.sampleRate, n = Math.min(audio.length, Math.floor(maxSecs * rate));
    const chans = []; for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
    const enc = new window.lamejs.Mp3Encoder(1, rate, 48), out = [], B = 1152 * 40, pcm = new Int16Array(B);
    for (let i = 0, k = 0; i < n; i += B, k++) {
      if (signal && signal.aborted) throw { code: "cancelled" };
      const len = Math.min(B, n - i);
      for (let j = 0; j < len; j++) {
        let v = 0; for (let c = 0; c < chans.length; c++) v += chans[c][i + j];
        v /= chans.length; v = v < -1 ? -1 : v > 1 ? 1 : v;
        pcm[j] = v < 0 ? v * 32768 : v * 32767;
      }
      const part = enc.encodeBuffer(len === B ? pcm : pcm.subarray(0, len));
      if (part.length) out.push(new Uint8Array(part));
      if (k % 6 === 5) await sleep(0);
    }
    const tail = enc.flush(); if (tail.length) out.push(new Uint8Array(tail));
    return new Blob(out, { type: "audio/mp3" });
  } catch (e) { throw e && e.code ? e : { code: "decode" }; }
}

/* ---------- talking to Google's AI ---------- */
const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((c) => ({ category: c, threshold: "BLOCK_NONE" }));
const STR = { type: "STRING" }, LIST = { type: "ARRAY", items: { type: "STRING" } };
const SHEET_SCHEMA = { type: "OBJECT", properties: {
  headline: STR,
  assignments: { type: "ARRAY", items: { type: "OBJECT", properties: {
    who: LIST, kind: { type: "STRING", format: "enum", enum: ["crew", "truck", "move", "shop", "other"] },
    steps: { type: "ARRAY", items: { type: "OBJECT", properties: { where: STR, what: STR, how: LIST }, required: ["where", "what", "how"] } },
    bring: LIST, notes: LIST, unsure: LIST }, required: ["who", "kind", "steps", "bring", "notes", "unsure"] } },
  everyone: LIST, unsure: LIST }, required: ["headline", "assignments", "everyone", "unsure"] };
const BUILD_SCHEMA = { type: "OBJECT", properties: { heard: STR, sheet: SHEET_SCHEMA }, required: ["heard", "sheet"] };
const TYPED_SCHEMA = { type: "OBJECT", properties: { sheet: SHEET_SCHEMA }, required: ["sheet"] };
const FIX_SCHEMA = { type: "OBJECT", properties: { sheet: SHEET_SCHEMA, learn: { type: "OBJECT", properties: { people: LIST, places: LIST, gear: LIST }, required: ["people", "places", "gear"] } }, required: ["sheet", "learn"] };

async function gFetch(path, body, signal) {
  let res;
  try {
    res = await fetch(API + path, { method: body ? "POST" : "GET", cache: "no-store", signal,
      headers: body ? { "x-goog-api-key": state.key, "Content-Type": "application/json" } : { "x-goog-api-key": state.key }, body: body || undefined });
  } catch (e) { throw { code: signal && signal.aborted ? "cancelled" : navigator.onLine === false ? "offline" : "unreachable" }; }
  let data = null; try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) { const er = (data && data.error) || {}; throw { code: "http", status: res.status, message: String(er.message || "").slice(0, 300) }; }
  return data || {};
}
function sortErr(e) {     // what kind of "no" this was
  if (!e || e.code !== "http") return (e && e.code) || "failed";
  const m = (e.message || "").toLowerCase(), s = e.status;
  if ((s === 400 && /api key|api_key/.test(m)) || s === 401) return "badkey";
  if (s === 403) return /key|credential|unregistered|permission/.test(m) ? "badkey" : "denied";
  if (s === 404 || (s === 400 && /model/.test(m) && /not found|not supported|unknown|does not exist|unsupported/.test(m))) return "model";
  if (s === 429) return /limit: 0\b/.test(m) ? "quota0" : "quota";
  if (s === 413) return "big";
  if (s >= 500) return "busy";
  if (s === 400) return "bad400";
  return "failed";
}
function pullText(node) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(pullText).join("");
  if (node.type === "thought" || node.type === "user_input" || node.role === "user") return "";
  if (node.type === "text" && typeof node.text === "string") return node.text;
  let out = ""; for (const k in node) if (node[k] && typeof node[k] === "object") out += pullText(node[k]);
  return out;
}
async function callModel(m, part, prompt, mode, schema, signal) {
  if (m.gc === false) {      // a model Google only offers through its newer Interactions route
    const input = []; if (part) input.push({ type: "audio", data: part.inline_data.data, mime_type: part.inline_data.mime_type });
    input.push({ type: "text", text: prompt });
    const d = await gFetch("/interactions", JSON.stringify({ model: m.n, input, store: false }), signal);
    const t = typeof d.output_text === "string" ? d.output_text : pullText(d.steps || d.outputs || []);
    if (!t.trim()) throw { code: "empty" };
    return t;
  }
  const body = { contents: [{ role: "user", parts: part ? [part, { text: prompt }] : [{ text: prompt }] }] };
  if (mode !== "plain") {
    body.safetySettings = SAFETY;
    body.generationConfig = mode === "schema" && schema ? { responseMimeType: "application/json", responseSchema: schema } : { responseMimeType: "application/json" };
  }
  const d = await gFetch("/models/" + encodeURIComponent(m.n) + ":generateContent", JSON.stringify(body), signal);
  const c = d.candidates && d.candidates[0];
  const t = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter((p) => p && typeof p.text === "string" && !p.thought).map((p) => p.text).join("") : "";
  if (!t.trim()) {
    const blocked = (d.promptFeedback && d.promptFeedback.blockReason) || (c && /SAFETY|PROHIBITED|BLOCK|RECITATION/.test(String(c.finishReason || "")));
    throw { code: blocked ? "blocked" : "empty" };
  }
  return t;
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
function rankModels(list) {
  const SKIP = /(image|tts|live|audio|embed|native|omni|transcribe|translate|computer|robot|banana|veo|lyria|imagen|gemma|learnlm|research|customtools|search)/;
  const out = [];
  for (const it of list || []) {
    const n = String((it && it.name) || "").replace(/^models\//, "");
    if (!/^gemini-/.test(n) || !/flash/.test(n) || SKIP.test(n)) continue;
    const meth = it.supportedGenerationMethods || it.supported_generation_methods || it.supportedActions || null;
    const v = /^gemini-(\d+(?:\.\d+)?)/.exec(n);
    out.push({ n, gc: Array.isArray(meth) && meth.length ? meth.indexOf("generateContent") >= 0 : true, ver: v ? parseFloat(v[1]) : 0,
      lite: /lite/.test(n) ? 1 : 0, pre: /(preview|exp|latest|-\d{3,}$|\d{2}-\d{2})/.test(n) ? 1 : 0 });
  }
  out.sort((a, b) => (Number(b.gc) - Number(a.gc)) || (a.lite - b.lite) || (a.pre - b.pre) || (b.ver - a.ver) || (a.n < b.n ? -1 : 1));
  return out.map((x) => ({ n: x.n, gc: x.gc }));
}
async function listModels() {
  const out = []; let token = "";
  for (let i = 0; i < 6; i++) {
    const d = await gFetch("/models?pageSize=200" + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    (d.models || []).forEach((m) => out.push(m));
    token = d.nextPageToken || ""; if (!token) break;
  }
  return out;
}
async function refreshModels() {
  const ranked = rankModels(await listModels());
  if (ranked.length) { state.models = ranked; await S.put("kv", ranked, "models").catch(() => {}); }
  return ranked;
}
// One request, with every fallback: another model, a shrunk recording, a simpler request.
async function askGoogle({ audio, prompt, schema, signal, onStep }) {
  if (!state.key) throw { code: "nokey" };
  let models = (state.models.length ? state.models : DEFAULT_MODELS.map((n) => ({ n, gc: true }))).slice();
  let mi = 0, mode = "schema", useMp3 = false, tries = 0, waited = false, relisted = false, badJson = false;
  const prep = async () => {
    if (!audio) return null;
    let blob = audio.blob, mime = useMp3 ? null : apiMime(blob, audio.name);
    if (!mime || blob.size > INLINE_MAX) { onStep("Shrinking the recording"); blob = await toMp3(audio.blob, MAX_AI_SECS, signal); mime = "audio/mp3"; useMp3 = true; }
    if (blob.size > INLINE_MAX) throw { code: "toolong" };
    onStep("Sending the recording");
    return { inline_data: { mime_type: mime, data: await toBase64(blob) } };
  };
  let part = await prep();
  for (;;) {
    if (++tries > 10) throw { code: "failed" };
    if (signal && signal.aborted) throw { code: "cancelled" };
    const m = models[mi];
    onStep(audio ? "Google's AI is listening to the meeting" : "Sorting out who's doing what");
    try {
      const text = await callModel(m, part, prompt, mode, schema, signal);
      let value;
      try { value = parseJson(text); } catch (e) { if (!badJson) { badJson = true; continue; } throw e; }
      if (mi > 0) { state.models = [m].concat(models.filter((x) => x !== m)); S.put("kv", state.models, "models").catch(() => {}); }
      return { value, model: m.n };
    } catch (e) {
      const kind = sortErr(e);
      if (kind === "model" || kind === "quota0") {
        if (mi + 1 < models.length) { mi++; continue; }
        if (!relisted) { relisted = true; const fresh = await refreshModels().catch(() => null); if (fresh && fresh.length) { models = fresh.slice(); mi = 0; continue; } }
        throw { code: kind === "model" ? "nomodel" : "quota", message: e.message };
      }
      if (kind === "busy" && !waited) { waited = true; onStep("Google's AI is busy, trying again"); await sleep(4000); continue; }
      if (kind === "big" && part && !useMp3) { useMp3 = true; part = await prep(); continue; }
      if (kind === "bad400") {
        const cfg = /schema|generation_?config|response_?mime|safety/.test((e.message || "").toLowerCase());
        if (part && !useMp3 && !cfg) { useMp3 = true; part = await prep(); continue; }
        if (mode === "schema") { mode = "json"; continue; }
        if (mode === "json") { mode = "plain"; continue; }
        if (part && !useMp3) { useMp3 = true; part = await prep(); continue; }
        throw { code: "rejected", message: e.message };
      }
      throw e && e.code && e.code !== "http" ? e : { code: kind, message: e && e.message };
    }
  }
}
function aiErr(e) {
  switch (e && e.code) {
    case "cancelled": return "";
    case "nokey": return "The AI key isn't set up yet. Open Setup and add it, then tap Build the sheet.";
    case "badkey": return "Google didn't accept the AI key. Open Setup and check it.";
    case "denied": return "Google turned the request down.";
    case "offline": return "No signal. This is saved on the phone, and the sheet will build when you have service.";
    case "unreachable": return "Couldn't reach Google's AI. Check your signal and tap Try again.";
    case "quota": case "quota0": return "Google's free limit is used up for now. Wait a minute and tap Try again.";
    case "busy": return "Google's AI is busy. Wait a minute and tap Try again.";
    case "nomodel": return "Google's AI models have changed. Open Setup and tap Check the key, then try again.";
    case "blocked": return "Google's AI refused this one.";
    case "rejected": return "Google's AI wouldn't take the request.";
    case "toolong": return "This recording is too long to send. Trim it to the meeting part in your recorder app and add it again.";
    case "decode": return "The phone couldn't shrink this recording to send it. Trim it to the meeting part in your recorder app and add it again.";
    case "empty": case "badjson": return "Google's AI didn't send back a sheet. Tap Try again.";
    case "empty_sheet": return "No assignments were found in this one.";
    case "nothing": return "There's no recording or text saved for this day.";
    case "save_failed": return "The sheet was built but couldn't be saved on this phone. Free up some space and tap Try again.";
    default: return "Something went wrong building the sheet. Tap Try again.";
  }
}
const googleSaid = (e) => (e && e.message ? "Google said: " + String(e.message).slice(0, 240) : "");

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
      ? "The phone is across a noisy shop, so some words are hard to hear, above all the names of people, places, machines and materials. Use the lists below to work out what was said: a word that sounds like a name on a list is almost always that name. When you still cannot tell what was said, do not guess. Add a short line to \"unsure\" that quotes what it sounded like.\n\n"
      : "Some words in the transcript may be wrong, above all the names of people, places, machines and materials. Use the lists below to work out what was meant: a word that looks like a name on a list is almost always that name. When you still cannot tell, do not guess. Add a short line to \"unsure\" that quotes the words as written.\n\n")
    + listBlock("PEOPLE", n.people) + listBlock("PLACES AND SUPPLIERS", n.places) + listBlock("MACHINES, TOOLS AND MATERIALS", n.gear)
    + (n.me ? "The person using this app is " + n.me + ".\n\n" : "");
}
const COMPANY = "an excavating company (site work, septic, water and sewer lines, and trucking of sand, gravel, stone and topsoil)";
function buildPrompt(day, hasAudio) {
  const n = names(), boss = n.boss || "The boss", when = fmtDate(day.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return (hasAudio ? "This is a phone recording of the morning crew meeting at " : "This is a rough transcript of the morning crew meeting at ") + COMPANY + ". Turn it into the day's job sheet.\n\n"
    + background(n, boss, hasAudio)
    + "Reply with only JSON in this shape:\n" + (hasAudio ? '{"heard": "...", "sheet": SHEET}' : '{"sheet": SHEET}') + "\nwhere SHEET is:\n" + SHAPE + "\n\n"
    + (hasAudio ? "\"heard\": a plain word-for-word transcript of the assignment part of the meeting, as well as you can hear it. Start a new line each time " + boss + " moves on to another person or crew. Leave out the talk before and after the assignments.\n\n" : "")
    + "Rules for the sheet:\n" + rules(boss)
    + (hasAudio ? "The recording was made on " + when + "." : "TRANSCRIPT (" + when + "):\n" + String(day.transcript || "").slice(0, 60000));
}
function fixPrompt(day, fix, hasAudio) {
  const n = names(), boss = n.boss || "The boss";
  return (hasAudio ? "This is a phone recording of the morning crew meeting at " + COMPANY + ". " : "This is about the morning crew meeting at " + COMPANY + ". ")
    + "A job sheet was already built from it, and the person who uses the sheet says something needs fixing.\n\n"
    + background(n, boss, hasAudio)
    + "THE SHEET NOW:\n" + JSON.stringify(day.sheet) + "\n\n"
    + (day.transcript ? "WHAT WAS HEARD THE FIRST TIME:\n" + String(day.transcript).slice(0, 30000) + "\n\n" : "")
    + "WHAT NEEDS FIXING, in " + (n.me || "the user") + "'s words:\n" + fix + "\n\n"
    + "Apply the fix everywhere it matters" + (hasAudio ? ", listening to the recording again where that helps," : "") + " and keep everything else as it is. Reply with only JSON in this shape:\n"
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
    if (!state.key) throw { code: "nokey" };
    const rec = day.hasAudio ? await S.get("audio", id).catch(() => null) : null;
    const audio = rec && rec.blob ? { blob: rec.blob, name: rec.name || "" } : null;
    if (!audio && !String(day.transcript || "").trim()) throw { code: "nothing" };
    const res = await askGoogle({ audio, signal: ctl.signal, onStep,
      prompt: fix ? fixPrompt(day, fix, !!audio) : buildPrompt(day, !!audio),
      schema: fix ? FIX_SCHEMA : audio ? BUILD_SCHEMA : TYPED_SCHEMA });
    const v = res.value || {};
    const sheet = normalizeSheet(v.sheet && !v.assignments ? v.sheet : v);
    const next = Object.assign(clone(dayById(id) || day), { sheet, builtAt: Date.now(), model: res.model });
    if (!fix && audio && typeof v.heard === "string" && v.heard.trim()) next.transcript = v.heard.trim();
    if (fix) next.fixes = (next.fixes || []).concat([fix]).slice(-20);
    try { await saveDay(next); } catch (e) { throw { code: "save_failed" }; }
    if (fix && v.learn) await learnNames(v.learn);
    if (fix) state.fixText = "";
    state.build = Object.assign({}, IDLE_BUILD);
  } catch (e) {
    if (e && e.code === "offline") waiting.add(id);
    state.build = Object.assign({}, IDLE_BUILD, { id, status: "failed", err: aiErr(e), said: googleSaid(e), fix: !!fix });
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

/* ---------- the AI key ---------- */
async function checkKey() {
  const su = state.setup, k = su.draft.trim();
  if (!k) { su.ok = false; su.msg = "Paste the key in the box first."; su.said = ""; render(); return; }
  su.busy = true; su.msg = ""; su.said = ""; render();
  const prev = state.key; state.key = k;
  try {
    let ranked = [];
    try { ranked = rankModels(await listModels()); }
    catch (e) { const kind = sortErr(e); if (kind === "badkey" || kind === "offline" || kind === "unreachable" || kind === "denied") throw { code: kind, message: e.message }; }
    if (!ranked.length) ranked = DEFAULT_MODELS.map((n) => ({ n, gc: true }));
    let good = null, last = null;
    for (const m of ranked.slice(0, 5)) {     // one tiny question, to find a model this key can really use
      try { await callModel(m, null, "Reply with the single word OK.", "plain", null); good = m; break; }
      catch (e) { last = e; const kind = sortErr(e); if (kind === "badkey" || kind === "offline" || kind === "unreachable") throw { code: kind, message: e.message }; }
    }
    if (!good) throw { code: sortErr(last), message: last && last.message };
    state.models = [good].concat(ranked.filter((x) => x !== good));
    await S.put("kv", k, "key"); await S.put("kv", state.models, "models");
    su.draft = ""; su.ok = true; su.msg = "The key works. Sheets will be built with " + good.n + ".";
  } catch (e) {
    state.key = prev; su.ok = false; su.said = googleSaid(e);
    su.msg = e.code === "badkey" ? "Google didn't accept that key. Copy it again from Google and paste the whole thing."
      : e.code === "offline" ? "No signal. Try again when you have service."
      : e.code === "unreachable" ? "Couldn't reach Google. Check your signal and try again."
      : e.code === "quota" || e.code === "quota0" ? "The key is fine, but Google's free limit is used up for now. Try again in a minute."
      : "Google wouldn't use that key for the AI.";
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
    h("p", null, h("strong", null, "One-time setup. "), "The app needs an AI key before it can build sheets. You can record without it, and the recording waits on the phone."),
    h("button", { class: "btn", type: "button", onclick: () => { usage().then(render); go({ view: "setup" }); } }, "Set it up")));
  out.push(recCard());
  if (recBusy()) return out;
  if (state.key && !names().people.trim()) out.push(note("Your names lists are empty, so the AI will have to guess at names. Load your setup file in Setup, or fill them in under Names."));
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
      h("p", null, day.hasAudio ? "The recording is saved on this phone" + (day.audioSecs ? " (" + clock(day.audioSecs * 1000) + ")" : "") + ". The sheet isn't built yet." : "What was said is saved. The sheet isn't built yet."),
      state.key ? h("div", null, h("button", { class: "btn", type: "button", onclick: () => buildSheet(day.id) }, mineBuild && b.status === "failed" ? "Try again" : "Build the sheet"))
        : h("div", null, h("button", { class: "btn", type: "button", onclick: () => { usage().then(render); go({ view: "setup" }); } }, "Set up the AI key"))));
  } else {
    out.push(sheetBlocks(day.sheet));
    out.push(h("div", { class: "row" },
      navigator.share ? h("button", { class: "btn", type: "button", onclick: () => shareSheet(day) }, "Send the sheet") : null,
      h("button", { class: "btn ghost", type: "button", onclick: () => copySheet(day) }, "Copy as text")));
    if (state.copyText) out.push(h("div", { class: "field" }, h("label", { for: "copy-box" }, state.copyText === "ok" ? "Copied. Paste it into a text or email." : "Press and hold to copy:"),
      state.copyText === "ok" ? null : h("textarea", { id: "copy-box", readonly: true, value: state.copyText })));
    if (state.key) out.push(h("div", { class: "field" },
      h("label", { for: "fix-box" }, "Something wrong?"),
      h("span", { class: "hint" }, "Say what to fix in your own words, like a name it got wrong." + (day.hasAudio ? " It listens to the recording again and learns names for next time." : " It learns names for next time.")),
      h("textarea", { id: "fix-box", value: state.fixText, placeholder: "Example: \"Woochi\" is Butch. The hay job was in Cleverdale.", oninput: (e) => { state.fixText = e.target.value; } }),
      h("div", null, h("button", { class: "btn", type: "button", disabled: working, onclick: () => { const t = state.fixText.trim(); if (t) { state.flash = ""; buildSheet(day.id, t); } } }, "Fix the sheet"))));
  }
  out.push(h("details", { id: "said" }, h("summary", null, "What was said"),
    h("div", { class: "said-box" },
      day.hasAudio ? h("div", { id: "player-slot" }, h("p", { class: "muted small" }, "Loading the recording…")) : null,
      h("p", { class: "heard" }, day.transcript || (day.hasAudio ? "The written version shows up here once the sheet is built." : "Nothing was saved for this day.")))));
  out.push(h("div", { class: "row" },
    day.sheet && state.key ? h("button", { class: "btn ghost", type: "button", disabled: working, onclick: () => buildSheet(day.id) }, "Build it again") : null,
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
    goReplace({ view: "day", id }); buildSheet(id);
  } catch (e) { t.err = "Couldn't save it on this phone. Free up some space and try again."; render(); }
}
function addView() {
  const a = state.add;
  return [backLink(),
    h("div", { class: "day-h" }, h("h2", null, "Add a recording"), h("p", null, "Pick a voice memo that's already on your phone, like one from your recorder app.")),
    h("div", { class: "field" }, h("label", { for: "add-file" }, "The recording"),
      h("input", { type: "file", id: "add-file", accept: "audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.webm,.flac,.3gp,.amr",
        onchange: (e) => { const f = e.target.files && e.target.files[0]; a.file = f || null; a.err = ""; if (f && f.lastModified) a.date = dstr(new Date(f.lastModified)); render(); } }),
      a.file ? h("span", { class: "hint" }, a.file.name + " · " + mb(a.file.size) + (a.file.size > INLINE_MAX ? ". It's a long one, so only the first 20 minutes go to the AI." : "")) : null),
    a.file ? h("div", { class: "field" }, h("label", { for: "add-date" }, "Which day was the meeting"), h("input", { type: "date", id: "add-date", value: a.date, oninput: (e) => { a.date = e.target.value; } })) : null,
    a.err ? note(a.err) : null,
    a.file ? h("div", null, h("button", { class: "btn", type: "button", disabled: a.busy, onclick: saveAdded }, state.key ? "Build the sheet" : "Save it")) : null];
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
  const su = state.setup, model = state.models[0] && state.models[0].n;
  return [h("div", { class: "day-h" }, h("h2", null, "Setup")),
    h("h3", { class: "sec-h" }, "The AI key"),
    state.key ? note("The key is on this phone" + (model ? ". Sheets are built with " + model + "." : "."), true) : null,
    h("div", { class: "plain" },
      h("p", null, "The app sends each recording to Google's AI (Gemini) to turn it into the sheet. For that it needs a key from Google, which is free for this much use."),
      h("ol", { class: "howto" },
        h("li", null, h("span", null, "Tap ", h("strong", null, "Get a key from Google"), " and sign in with your Google account.")),
        h("li", null, h("span", null, "Tap ", h("strong", null, "Create API key"), " and copy the key.")),
        h("li", null, h("span", null, "Come back here, paste it in the box and tap ", h("strong", null, "Check the key"), "."))),
      h("div", null, h("a", { class: "btn ghost", href: KEY_URL, target: "_blank", rel: "noopener" }, "Get a key from Google")),
      h("p", { class: "muted small" }, "The key is kept on this phone only. Don't share it. On Google's free plan, Google may use what's sent to improve its products.")),
    h("div", { class: "field" }, h("label", { for: "key-box" }, state.key ? "Put in a different key" : "Paste the key here"),
      h("input", { type: "password", id: "key-box", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: su.draft, oninput: (e) => { su.draft = e.target.value; } })),
    su.msg ? note(su.msg, su.ok === true, su.said) : null,
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", disabled: su.busy, onclick: checkKey }, su.busy ? "Checking with Google…" : "Check the key"),
      state.key ? h("button", { class: "btn danger", type: "button", disabled: su.busy, onclick: forgetKey }, "Take the key off this phone") : null),
    h("h3", { class: "sec-h" }, "Backup and setup files"),
    h("p", { class: "muted small" }, "Sheets, names and recordings live on this phone only" + (su.used ? " (" + su.used + " so far)" : "") + ". A backup file holds the sheets and names lists."),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: saveBackup }, "Save a backup file"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { const i = $("#load-file"); if (i) i.click(); } }, "Load a backup or setup file"),
      h("button", { class: "btn ghost", type: "button", onclick: clearOldRecordings }, "Clear recordings older than 30 days")),
    h("input", { type: "file", id: "load-file", accept: ".json,application/json,text/plain", hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; loadBackup(f); } }),
    su.bmsg ? note(su.bmsg, su.bok === true) : null,
    h("p", { class: "foot" }, "Version " + VERSION)];
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
    const [days, nm, key, models] = await Promise.all([S.all("days"), S.get("kv", "names"), S.get("kv", "key"), S.get("kv", "models")]);
    state.days = sortDays(days || []);
    if (nm && typeof nm === "object") state.names = Object.assign({}, EMPTY_NAMES, nm);
    state.key = typeof key === "string" ? key : "";
    state.models = Array.isArray(models) ? models.filter((m) => m && m.n) : [];
    await recoverCutOff();
  } catch (e) { state.storeErr = true; }
  state.ready = true;
  try { history.replaceState({ mm: 1, base: 1, r: { view: "home" } }, ""); } catch (e) { /* fine */ }
  render();
  registerSw();
}
boot();
})();
