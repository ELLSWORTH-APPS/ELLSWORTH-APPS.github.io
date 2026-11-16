(function () {
"use strict";

// ================================================================ basics
const VERSION = window.JP_VERSION || "dev";
const CFG = self.JP_CONFIG || {};
const DB = window.JPStore;
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = v => String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = v => (Array.isArray(v) ? v : []);
const isTouch = matchMedia("(pointer: coarse)").matches;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/i.test(navigator.userAgent);
function standalone() {
  try { return !!(navigator.standalone || matchMedia("(display-mode: standalone)").matches); } catch (e) { return false; }
}

const S = {
  setup: null,                                   // { key, name, role }
  data: { jobs: [], photos: [], at: 0, folder: "" },
  outbox: [], jobmap: {}, lastOk: 0,
  view: "boot", jobId: null,
  filter: "Active", sort: "recent", q: "", note: "",
  size: "standard",
  online: navigator.onLine !== false,
  syncing: false, again: false, lastErr: "",
  batch: { total: 0, done: 0 },
  processing: [],                                // photos being got ready, not saved yet
  urls: new Map(),                               // blob key -> object URL
  noBlob: new Set(),                             // thumbnails the phone doesn't have yet
  installEvt: null, homeScroll: 0
};

const ls = {
  get(k) { try { return localStorage.getItem("jp_" + k); } catch (e) { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem("jp_" + k); else localStorage.setItem("jp_" + k, v); } catch (e) { /* private mode */ } }
};
S.size = ls.get("size") === "full" ? "full" : "standard";
const me = () => S.setup || {};
const isOwner = () => me().role === "Owner";

const ICON = {
  search: '<path d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM21 21l-4.8-4.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.3" r="3.6"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M4 17.5l5.2-5.2 3.8 3.8 2.7-2.7L20 17.7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pin: '<path d="M12 21s-6.5-6.1-6.5-11A6.5 6.5 0 0 1 18.5 10c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  user: '<circle cx="12" cy="8.2" r="3.8"/><path d="M4.5 20c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M2.8 19.5c.6-3.4 3.1-5.3 6.2-5.3s5.6 1.9 6.2 5.3"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.3c2.6.1 4.3 1.8 4.8 4.6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  down: '<path d="M12 4v12M7 11l5 5 5-5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  check: '<path d="M4.5 12.5l4.8 4.8L19.5 7"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/>',
  move: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  size: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  out: '<path d="M14 4h6v16h-6M10 8l-4 4 4 4M6 12h10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'
};
const icon = (n, cls) => `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ""}</svg>`;

// ================================================================ dates
const DAY = 864e5;
function fmtDay(ms) {
  const d = new Date(ms), now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (that === today) return "Today";
  if (that === today - DAY) return "Yesterday";
  const o = { weekday: "long", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) { delete o.weekday; o.year = "numeric"; }
  return d.toLocaleDateString("en-US", o);
}
function fmtShort(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString("en-US", o);
}
function fmtTime(ms) { return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
function fmtFull(ms) { return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + " at " + fmtTime(ms); }
function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  return fmtShort(ms);
}

// ================================================================ little UI helpers
let toastT;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove("on"), 3800);
}

let sheetEl = null, scrimEl = null, sheetOnClose = null;
function openSheet(html, onClose) {
  closeSheet(true);
  scrimEl = document.createElement("div");
  scrimEl.className = "scrim";
  sheetEl = document.createElement("div");
  sheetEl.className = "sheet";
  sheetEl.setAttribute("role", "dialog");
  sheetEl.setAttribute("aria-modal", "true");
  sheetEl.innerHTML = '<div class="grab"></div>' + html;
  document.body.append(scrimEl, sheetEl);
  scrimEl.addEventListener("click", () => closeSheet());
  sheetOnClose = onClose || null;
  requestAnimationFrame(() => { scrimEl.classList.add("on"); sheetEl.classList.add("on"); });
  const first = sheetEl.querySelector("[autofocus]");
  if (first && !isTouch) setTimeout(() => first.focus(), 60);
  return sheetEl;
}
function closeSheet(instant) {
  if (!sheetEl) return;
  const s = sheetEl, c = scrimEl, fn = sheetOnClose;
  sheetEl = scrimEl = sheetOnClose = null;
  if (instant) { s.remove(); c.remove(); }
  else {
    s.classList.remove("on"); c.classList.remove("on");
    setTimeout(() => { s.remove(); c.remove(); }, 230);
  }
  if (fn) fn();
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (sheetEl) closeSheet(); else if (V.open) closeViewer(); }
});

async function copyText(text, inputEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* not allowed here */ }
  try {
    const ta = inputEl || Object.assign(document.createElement("textarea"), { value: text });
    if (!inputEl) { ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.append(ta); }
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    if (!inputEl) ta.remove();
    return ok;
  } catch (e) { return false; }
}
const smsHref = body => "sms:?&body=" + encodeURIComponent(body);
const mapsHref = q => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
const titleCase = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/(^|[\s\-\/(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const norm = s => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const rid = () => Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
const newPid = () => "P" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

// Things that need the sheet right now (not just later).
function needsSignal(what) {
  toast((what || "That") + " needs signal. Try again when you have service.");
}

// ================================================================ Back button: goes back a screen and never leaves the app
function navInit() {
  try {
    history.replaceState({ jp: "base" }, "");
    history.pushState({ jp: "top" }, "");
  } catch (e) { /* fine */ }
  window.addEventListener("popstate", () => {
    try { history.pushState({ jp: "top" }, ""); } catch (e) { /* fine */ }
    goBack();
  });
}
function goBack() {
  if (sheetEl) { closeSheet(); return; }
  if (V.open) { closeViewer(); return; }
  if (S.view === "job") { showHome(); return; }
  // on the job list already: stay put
}

// Object URLs for photos kept on this phone.
async function blobURL(key) {
  if (S.urls.has(key)) return S.urls.get(key);
  let b = null;
  try { b = await DB.bget(key); } catch (e) { b = null; }
  if (!b) return "";
  const u = URL.createObjectURL(b);
  S.urls.set(key, u);
  return u;
}
function dropURL(key) {
  const u = S.urls.get(key);
  if (u) { URL.revokeObjectURL(u); S.urls.delete(key); }
}



// ================================================================ getting a photo ready (on the phone, before it's saved)
const SIZES = { standard: 2560, full: 4096, view: 1600, thumb: 480 };

/** Date taken and GPS from a JPEG's EXIF block. Everything is optional. */
async function readExif(file) {
  const out = { taken: null, lat: null, lng: null };
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const dv = new DataView(buf);
    if (dv.byteLength < 12 || dv.getUint16(0) !== 0xFFD8) return out;
    let off = 2;
    while (off + 10 < dv.byteLength) {
      const marker = dv.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFDA || marker === 0xFFD9) break;
      const len = dv.getUint16(off + 2);
      if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) { parseTiff(dv, off + 10, out); break; }
      off += 2 + len;
    }
  } catch (e) { /* not a JPEG, or no EXIF */ }
  return out;
}
function parseTiff(dv, start, out) {
  const le = dv.getUint16(start) === 0x4949;
  const u16 = o => dv.getUint16(start + o, le);
  const u32 = o => dv.getUint32(start + o, le);
  if (u16(2) !== 42) return;
  const ifd = o => {
    const n = u16(o), map = {};
    for (let i = 0; i < n && i < 400; i++) {
      const e = o + 2 + i * 12;
      map[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return map;
  };
  const ascii = t => {
    const o = t.count > 4 ? u32(t.at) : t.at;
    let s = "";
    for (let i = 0; i < t.count - 1 && i < 64; i++) s += String.fromCharCode(dv.getUint8(start + o + i));
    return s;
  };
  const rat3 = t => { const o = u32(t.at); return [0, 1, 2].map(k => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1)); };
  const ref = t => t ? String.fromCharCode(dv.getUint8(start + t.at)) : "";
  const ifd0 = ifd(u32(4));
  let dt = "";
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].at));
    const t = ex[0x9003] || ex[0x9004];
    if (t) dt = ascii(t);
  }
  if (!dt && ifd0[0x0132]) dt = ascii(ifd0[0x0132]);
  const m = /(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dt);
  if (m) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (ms > 946684800000 && ms < Date.now() + DAY) out.taken = ms;
  }
  if (ifd0[0x8825]) {
    const g = ifd(u32(ifd0[0x8825].at));
    if (g[2] && g[4]) {
      const a = rat3(g[2]), b = rat3(g[4]);
      let lat = a[0] + a[1] / 60 + a[2] / 3600, lng = b[0] + b[1] / 60 + b[2] / 3600;
      if (ref(g[1]) === "S") lat = -lat;
      if (ref(g[3]) === "W") lng = -lng;
      if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) {
        out.lat = Math.round(lat * 1e6) / 1e6;
        out.lng = Math.round(lng * 1e6) / 1e6;
      }
    }
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("can't read")); };
    img.src = url;
  });
}

/** Draws src into a canvas whose long side is at most max (never bigger than it was). */
function scaled(src, sw, sh, max) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0, w, h);
  return c;
}
function canvasBlob(c, q) {
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error("couldn't make the photo"))), "image/jpeg", q);
  });
}
function guessMime(file) {
  if (file.type) return file.type;
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [])[1] || "";
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp", gif: "image/gif" }[ext.toLowerCase()] || "";
}
const isPhotoFile = f => /^image\//.test(guessMime(f));

/**
 * What gets kept and sent for one photo: the photo itself (Standard = 2560 px; Full size = the untouched
 * original up to 15 MB, or 4096 px past that), a 1600 px copy for looking at, and a small thumbnail.
 */
async function preparePhoto(file, size) {
  const mime = guessMime(file);
  const exif = /jpe?g/i.test(mime) ? await readExif(file) : { taken: null, lat: null, lng: null };
  let taken = exif.taken;
  if (!taken && file.lastModified && file.lastModified < Date.now() + DAY && file.lastModified > 946684800000) taken = file.lastModified;
  const base = { taken: taken || Date.now(), lat: exif.lat, lng: exif.lng, origName: file.name || "", origSize: file.size || 0 };

  let loaded = null;
  try { loaded = await loadImage(file); } catch (e) { loaded = null; }
  if (!loaded) {
    // The phone can't open this kind of photo (HEIC on some Android phones): keep and send it as it is.
    if (file.size > 26 * 1048576) throw new Error("That photo is too big to send (over 26 MB).");
    return Object.assign(base, { mime: mime || "image/jpeg", main: file.slice(0, file.size, mime || "image/jpeg"), view: null, thumb: null, w: 0, h: 0 });
  }
  const { img, url } = loaded;
  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    let main, mainBlob, outMime, w, h;
    const keepOriginal = size === "full" && /^image\/(jpeg|png)$/.test(mime) && file.size <= 15 * 1048576;
    if (keepOriginal) {
      mainBlob = file.slice(0, file.size, mime); outMime = mime; w = W; h = H;
      main = scaled(img, W, H, SIZES.view);
    } else {
      const big = size === "full";
      main = scaled(img, W, H, big ? SIZES.full : SIZES.standard);
      mainBlob = await canvasBlob(main, big ? 0.92 : 0.86); outMime = "image/jpeg"; w = main.width; h = main.height;
    }
    const viewC = Math.max(main.width, main.height) > SIZES.view + 100 ? scaled(main, main.width, main.height, SIZES.view) : main;
    const view = (keepOriginal || viewC !== main) ? await canvasBlob(viewC, 0.8) : null;
    const thumbC = scaled(viewC, viewC.width, viewC.height, SIZES.thumb);
    const thumb = await canvasBlob(thumbC, 0.72);
    [main, viewC, thumbC].forEach(c => { c.width = c.height = 0; });
    return Object.assign(base, { mime: outMime, main: mainBlob, view, thumb, w, h });
  } finally {
    URL.revokeObjectURL(url);
  }
}



// ================================================================ what's on the phone, merged with what's waiting to send
async function loadLocal() {
  const [setup, data, outbox, jobmap, lastOk] = await Promise.all([
    DB.get("setup"), DB.get("data"), DB.get("outbox"), DB.get("jobmap"), DB.get("lastOk")
  ]);
  S.setup = setup || null;
  S.data = data || { jobs: [], photos: [], at: 0, folder: "" };
  S.outbox = list(outbox).filter(Boolean);
  S.jobmap = jobmap || {};
  S.lastOk = lastOk || 0;
  if (S.jobId && S.jobmap[S.jobId]) S.jobId = S.jobmap[S.jobId];   // a job started with no signal got its real number
}

function pendingJobs() {
  return S.outbox.filter(o => o.t === "job").map(o => ({
    id: o.tmp, name: o.name, address: o.address || "", customer: o.customer || "", notes: o.notes || "",
    status: "Active", count: 0, last: o.at, started: o.at, by: o.by || "", aliases: "", pending: true, failed: !!o.failed, err: o.err || ""
  }));
}
function allJobs() {
  const jobs = list(S.data.jobs).map(j => Object.assign({}, j, { waiting: 0 }));
  const byId = new Map(jobs.map(j => [j.id, j]));
  pendingJobs().forEach(j => { if (!byId.has(j.id)) { jobs.push(Object.assign(j, { waiting: 0 })); byId.set(j.id, j); } });
  S.outbox.forEach(o => {
    if (o.t !== "photo") return;
    const j = byId.get(o.job);
    if (j) { j.waiting++; j.last = Math.max(j.last || 0, o.at || 0); if (!j.cover && !j.qcover) j.qcover = "q:" + o.id + ":t"; }
  });
  return jobs;
}
const jobById = id => allJobs().find(j => j.id === id) || null;
const waitingPhotos = () => S.outbox.filter(o => o.t === "photo");
const failedOps = () => S.outbox.filter(o => o.failed);

// ================================================================ start up / sign in
function keyFromLink() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const q = new URLSearchParams(location.search);
  const k = String(h.get("key") || q.get("key") || "").trim().toUpperCase();
  if (k) { try { history.replaceState(history.state, "", location.pathname); } catch (e) { /* fine */ } }
  return /^[A-Z0-9]{4,12}$/.test(k) ? k : "";
}

async function start() {
  navInit();
  try { await loadLocal(); }
  catch (e) {
    $("#app").innerHTML = `<div class="wrap"><div class="empty"><h2>This phone's storage didn't open</h2><p>${esc(e.message)}. Close the app all the way and open it again.</p></div></div>`;
    return;
  }
  const linkKey = keyFromLink();
  if (linkKey && (!S.setup || S.setup.key !== linkKey)) {
    if (S.setup && S.outbox.length) toast("This phone already has photos waiting under another code. Sign out first to switch.");
    else { await signIn(linkKey, true); return; }
  }
  if (!S.setup) { showSignIn(""); return; }
  showHome(true);
  kickSync();
}

function showSignIn(msg, tried) {
  S.view = "signin";
  $("#app").innerHTML = `
    <div class="signin">
      <h1>Job Photos</h1>
      <p>Ellsworth &amp; Son Excavating. Type the code from your link to set up this phone. It needs signal this one time; after that the app works with no service.</p>
      <form id="codeForm" autocomplete="off">
        <label class="sr" for="codeIn">Your code</label>
        <input id="codeIn" class="code-in" maxlength="12" autocapitalize="characters" spellcheck="false" placeholder="CODE" value="${esc(tried || "")}">
        <button class="btn tape block" type="submit">Set up this phone</button>
        ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
      </form>
      ${standalone() ? "" : installCard(true)}
    </div>`;
  $("#codeForm").addEventListener("submit", e => {
    e.preventDefault();
    const k = $("#codeIn").value.trim().toUpperCase();
    if (k) signIn(k, false);
  });
  bindInstall($("#app"));
}

async function signIn(key, fromLink) {
  if (S.view === "signin") { const b = $("#codeForm button"); if (b) { b.disabled = true; b.textContent = "Setting up…"; } }
  else $("#app").innerHTML = `<div class="boot">Setting up this phone…</div>`;
  try {
    const d = await DB.call("all", {}, 90000, key);
    await DB.set("setup", { key, name: d.me.name, role: d.me.role, at: Date.now() });
    await DB.set("data", { jobs: list(d.jobs), photos: list(d.photos), at: Date.now(), folder: d.folder || "" });
    await DB.set("lastOk", Date.now());
    await loadLocal();
    S.online = true;
    showHome(true);
    toast("Set up for " + d.me.name + ". Photos download in the background.");
    prefetchThumbs();
  } catch (e) {
    const msg = e.offline ? "No signal. Setting up needs service this one time." : e.message;
    showSignIn(msg, key);
    if (fromLink && e.offline) toast(msg);
  }
}

async function signOut() {
  if (S.outbox.length) {
    const n = S.outbox.length;
    const el = openSheet(`<h2>${n} ${n === 1 ? "thing hasn't" : "things haven't"} been sent</h2>
      <p class="muted">Signing out takes them off this phone for good. Send them first when you have signal.</p>
      <div class="acts"><button class="btn line" data-x>Keep them</button><button class="btn bad" id="outYes">Sign out anyway</button></div>`);
    $("[data-x]", el).onclick = () => closeSheet();
    $("#outYes", el).onclick = () => { closeSheet(true); doSignOut(); };
    return;
  }
  doSignOut();
}
async function doSignOut() {
  try { await DB.clearAll(); } catch (e) { /* storage already gone */ }
  S.urls.forEach(u => URL.revokeObjectURL(u));
  S.urls.clear();
  S.setup = null; S.data = { jobs: [], photos: [], at: 0, folder: "" }; S.outbox = []; S.jobmap = {};
  showSignIn("Signed out. Type a code to set this phone up again.");
}

// ================================================================ home: job list
function lastActivity(j) { return Math.max(j.last || 0, j.started || 0); }
function visibleJobs() {
  const q = norm(S.q);
  let jobs = allJobs().filter(j => (S.filter === "Done") === (j.status === "Done"));
  if (q) {
    const words = q.split(" ");
    jobs = jobs.filter(j => {
      const hay = norm([j.name, j.address, j.customer, j.aliases, j.notes, j.id].join(" "));
      return words.every(w => hay.includes(w));
    });
  }
  return jobs.sort(S.sort === "az" ? (a, b) => a.name.localeCompare(b.name, "en", { numeric: true }) : (a, b) => lastActivity(b) - lastActivity(a));
}

function statusInfo() {
  const waiting = S.outbox.length + S.processing.length;
  const photos = waitingPhotos().length + S.processing.length;
  const failed = failedOps().length;
  const what = photos ? photos + (photos === 1 ? " photo" : " photos") : waiting + (waiting === 1 ? " change" : " changes");
  if (S.syncing && waiting) return { cls: "busy", text: "Sending " + what + "…" };
  if (failed && failed === S.outbox.length && !S.processing.length) return { cls: "bad", text: failed + " didn't send. Tap to see why" };
  if (waiting && !S.online) return { cls: "wait", text: "No signal. " + what + " waiting to send" };
  if (waiting) return { cls: "wait", text: what + " waiting to send" };
  if (!S.online) return { cls: "", text: "No signal. Showing what's on this phone" };
  if (S.syncing) return { cls: "busy", text: "Checking for new photos…" };
  return { cls: "ok", text: S.lastOk ? "Up to date, " + ago(S.lastOk) : "Up to date" };
}
function statusHTML() {
  const s = statusInfo();
  return `<button class="sync ${s.cls}" id="syncBtn" type="button"><span class="dot"></span><span>${esc(s.text)}</span></button>`;
}
function renderStatus() {
  const b = $("#syncBtn");
  if (b) { b.outerHTML = statusHTML(); $("#syncBtn").onclick = sendingSheet; }
  renderBar();
}

function showHome(first) {
  S.view = "home"; S.jobId = null;
  const all = allJobs(), active = all.filter(j => j.status !== "Done").length, done = all.length - active;
  $("#app").innerHTML = `
    <div class="wrap">
      <div class="top">
        <div class="grow"><h1>Job Photos</h1>${statusHTML()}</div>
        <button class="iconbtn" id="menuBtn" aria-label="Menu">${icon("menu")}</button>
      </div>
      ${standalone() || ls.get("tipDone") ? "" : installCard(false)}
      <button class="btn tape block" id="newJob">${icon("plus")}Start a new job</button>
      <div class="search">${icon("search")}<label class="sr" for="q">Find a job</label>
        <input id="q" type="search" placeholder="Find a job" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search"></div>
      <div class="filters">
        <div class="seg" role="group" aria-label="Show">
          <button data-f="Active" aria-pressed="${S.filter === "Active"}">Active <span class="num">${active}</span></button>
          <button data-f="Done" aria-pressed="${S.filter === "Done"}">Done <span class="num">${done}</span></button>
        </div>
        <button class="sort" id="sortBtn">${S.sort === "az" ? "A to Z" : "Most recent"}</button>
      </div>
      <ul class="jobs" id="jobList"></ul>
    </div>`;
  $("#newJob").onclick = () => newJobSheet();
  $("#menuBtn").onclick = menuSheet;
  $("#syncBtn").onclick = sendingSheet;
  $("#q").addEventListener("input", e => { S.q = e.target.value; renderJobList(); });
  $$(".seg button").forEach(b => b.onclick = () => { S.filter = b.dataset.f; showHome(); });
  $("#sortBtn").onclick = () => { S.sort = S.sort === "az" ? "recent" : "az"; showHome(); };
  bindInstall($("#app"));
  renderJobList();
  renderBar();
  if (!first) window.scrollTo(0, S.homeScroll || 0);
}

function renderJobList() {
  const ul = $("#jobList");
  if (!ul) return;
  const jobs = visibleJobs();
  if (!jobs.length) {
    ul.innerHTML = S.q
      ? `<li class="empty"><h2>No job matches “${esc(S.q)}”</h2><p>Check the spelling, or start it as a new job.</p></li>`
      : S.filter === "Done"
        ? `<li class="empty"><h2>No finished jobs</h2><p>Jobs marked done show up here.</p></li>`
        : `<li class="empty"><h2>No jobs yet</h2><p>Start a job, then add its photos.</p></li>`;
    return;
  }
  ul.innerHTML = jobs.map(j => {
    const key = j.cover ? "t:" + j.cover : (j.qcover || "");
    const n = (j.count || 0) + (j.waiting || 0);
    return `<li><button class="job ${j.status === "Done" ? "done" : ""}" data-id="${esc(j.id)}">
      <span class="ph" ${key ? `data-key="${esc(key)}"` : ""}>${key ? "" : icon("camera")}</span>
      <span class="txt"><span class="nm">${esc(j.name)}${j.pending ? ` <span class="pending">${j.failed ? "Didn't send" : "Not sent yet"}</span>` : ""}</span>
        ${j.address ? `<span class="addr">${esc(j.address)}</span>` : ""}
        <span class="sub"><span>${n ? `<b class="num">${n}</b> photo${n === 1 ? "" : "s"}` : "No photos yet"}${j.waiting ? `, ${j.waiting} waiting` : ""}</span>
        ${j.last ? `<span class="when">${esc(fmtShort(j.last))}</span>` : ""}</span>
      </span></button></li>`;
  }).join("");
  $$(".job", ul).forEach(b => b.onclick = () => { S.homeScroll = window.scrollY; openJob(b.dataset.id); });
  paintKeys(ul);
}

// ================================================================ new job (works with no signal: it's sent later)
function newJobSheet(prefill) {
  const el = openSheet(`
    <h2>Start a new job</h2>
    <form id="nj" autocomplete="off">
      <label class="field"><span>Job name</span><input name="name" required maxlength="80" placeholder="Like 14 Lakeview Dr septic" autofocus value="${esc(prefill || "")}"></label>
      <div id="sim"></div>
      <label class="field"><span>Address <small>(optional)</small></span><input name="address" maxlength="200" placeholder="Street, town"></label>
      <label class="field"><span>Customer <small>(optional)</small></span><input name="customer" maxlength="80"></label>
      <label class="field"><span>Notes <small>(optional)</small></span><textarea name="notes" maxlength="1000"></textarea></label>
      <div class="acts"><button type="button" class="btn line" data-x>Cancel</button><button class="btn tape" type="submit">Start job</button></div>
    </form>`);
  const f = $("#nj", el);
  $("[data-x]", el).onclick = () => closeSheet();
  const showSimilar = () => {
    const v = norm(f.name.value), box = $("#sim", el);
    if (v.length < 3) { box.innerHTML = ""; return; }
    const words = v.split(" ").filter(w => w.length > 2 || /\d/.test(w));
    const hits = allJobs().map(j => {
      const hay = norm(j.name + " " + j.aliases + " " + j.address);
      return { j, n: words.filter(w => hay.includes(w)).length };
    }).filter(x => x.n && x.n >= Math.min(2, words.length)).sort((a, b) => b.n - a.n).slice(0, 3);
    box.innerHTML = hits.length ? `<div class="similar"><p>Already in the list. Tap one to add photos to it:</p>
      ${hits.map(x => `<button type="button" data-id="${esc(x.j.id)}">${esc(x.j.name)}</button>`).join("")}</div>` : "";
    $$("button", box).forEach(b => b.onclick = () => { closeSheet(true); openJob(b.dataset.id); });
  };
  f.name.addEventListener("input", showSimilar);
  if (prefill) showSimilar();
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const name = f.name.value.trim().replace(/\s+/g, " ");
    if (name.length < 2) { toast("Give the job a name."); return; }
    const same = allJobs().find(j => norm(j.name) === norm(name) || String(j.aliases || "").split(/[;,\n]/).some(a => a.trim() && norm(a) === norm(name)));
    if (same) { closeSheet(true); toast("That job is already in the list, so it's open now."); openJob(same.id); return; }
    const tmp = "tmp-" + rid();
    const op = { id: "o" + rid(), t: "job", tmp, name, address: f.address.value.trim(), customer: f.customer.value.trim(), notes: f.notes.value.trim(), at: Date.now(), by: me().name };
    try { await DB.queue(op, {}); }
    catch (err) { toast("This phone couldn't save the job: " + err.message); return; }
    S.outbox.push(op);
    closeSheet(true);
    toast(S.online ? "Job started. Add its photos." : "Job started on this phone. It goes to the sheet when there's signal.");
    openJob(tmp);
    kickSync();
  });
}

// ================================================================ put it on the home screen
const SHARE_SVG = `<svg class="share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share">${ICON.share}</svg>`;
function installSteps() {
  if (isIOS()) return `<ol><li>Open this page in <b>Safari</b>.</li><li>Tap the Share button ${SHARE_SVG}, then <b>Add to Home Screen</b>.</li>
    <li>Open <b>Job Photos</b> from the home screen and type your code there once. The home screen app keeps its own copy, apart from Safari.</li></ol>`;
  if (isAndroid()) return S.installEvt ? `<p>Tap <b>Install</b> below. Job Photos goes in with your other apps.</p>`
    : `<ol><li>In <b>Chrome</b>, tap the ⋮ menu.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Open <b>Job Photos</b> from your apps.</li></ol>`;
  return S.installEvt ? `<p>Click <b>Install</b> below to put Job Photos on this computer.</p>`
    : `<p>iPhone: in Safari, tap Share ${SHARE_SVG}, then <b>Add to Home Screen</b>. Android: in Chrome, tap ⋮, then <b>Install app</b>.</p>`;
}
function installCard(full) {
  const what = isTouch ? "phone" : "computer";
  if (!full) {   // the job list gets a short version; the steps open on request
    return `<div class="install" id="installCard">
      <h2>Put Job Photos on your ${what}</h2>
      <p>Installed, it opens like an app and works with no signal.</p>
      <div class="acts">${S.installEvt ? `<button class="btn tape small" type="button" data-install>Install</button>` : `<button class="btn tape small" type="button" data-how>Show me how</button>`}
        <button class="btn quiet small" type="button" data-tipdone>Hide this</button></div>
    </div>`;
  }
  return `<div class="install" id="installCard">
    <h2>Put Job Photos on your ${what}</h2>
    <p>Installed, it opens like any app and works with no signal. Photos you take wait on the ${what} and send when there's service.</p>
    ${installSteps()}
    ${S.installEvt ? `<div class="acts"><button class="btn tape small" type="button" data-install>Install</button></div>` : ""}
  </div>`;
}
function installSheet() {
  const el = openSheet(installCard(true).replace('class="install"', 'class="install" style="border:0;padding:0;background:none"'));
  bindInstall(el);
}
function bindInstall(root) {
  const b = $("[data-install]", root);
  if (b) b.onclick = async () => {
    const evt = S.installEvt;
    if (!evt) return;
    S.installEvt = null;
    try { evt.prompt(); await evt.userChoice; } catch (e) { /* closed */ }
    if (S.view === "home") showHome(); else if (S.view === "signin") showSignIn("");
  };
  const how = $("[data-how]", root);
  if (how) how.onclick = installSheet;
  const h = $("[data-tipdone]", root);
  if (h) h.onclick = () => { ls.set("tipDone", "1"); const c = $("#installCard"); if (c) c.remove(); };
}
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  S.installEvt = e;
  if (S.view === "home" && !$("[data-install]")) showHome();
});
window.addEventListener("appinstalled", () => { S.installEvt = null; ls.set("tipDone", "1"); });

// ================================================================ menu, photo size, people, space
function menuSheet() {
  const owner = isOwner();
  const el = openSheet(`
    <h2>${esc(me().name || "")}</h2>
    <ul class="menu">
      <li><button data-a="send">${icon("send")}Sending<span class="hint">${S.outbox.length ? S.outbox.length + " waiting" : "All sent"}</span></button></li>
      <li><button data-a="size">${icon("size")}Photo size<span class="hint">${S.size === "full" ? "Full size" : "Standard"}</span></button></li>
      ${owner ? `<li><button data-a="people">${icon("people")}People who can use the app</button></li>` : ""}
      ${owner && !isTouch ? `<li><button data-a="import">${icon("upload")}Load a folder of job photos from this computer</button></li>` : ""}
      ${owner && S.data.folder ? `<li><a href="${esc(S.data.folder)}" target="_blank" rel="noopener">${icon("folder")}Open the photos folder in Google Drive</a></li>` : ""}
      ${standalone() ? "" : `<li><button data-a="install">${icon("phone")}Put the app on your home screen</button></li>`}
      <li><button data-a="space">${icon("down")}Space on this ${isTouch ? "phone" : "computer"}<span class="hint" id="spaceHint"></span></button></li>
      <li><button data-a="out">${icon("out")}Sign out on this ${isTouch ? "phone" : "computer"}</button></li>
    </ul>
    <p class="muted" style="margin-top:12px">Job Photos ${esc(VERSION)}</p>`);
  $$("[data-a]", el).forEach(b => b.onclick = () => {
    const a = b.dataset.a;
    if (a === "send") sendingSheet();
    if (a === "size") sizeSheet();
    if (a === "people") { if (!S.online) needsSignal("People"); peopleSheet(); }
    if (a === "import") importSheet();
    if (a === "install") { closeSheet(true); installSheet(); }
    if (a === "space") spaceSheet();
    if (a === "out") { closeSheet(true); signOut(); }
  });
  storageUse().then(t => { const h = $("#spaceHint"); if (h && t) h.textContent = t; });
}
async function storageUse() {
  try { const e = await navigator.storage.estimate(); return e && e.usage ? Math.round(e.usage / 1048576) + " MB used" : ""; } catch (e) { return ""; }
}
function sizeSheet() {
  const el = openSheet(`
    <h2>Photo size</h2>
    <ul class="menu">
      <li><button data-s="standard">${icon(S.size === "standard" ? "check" : "image")}Standard<span class="hint">Sends fast. Plenty of detail.</span></button></li>
      <li><button data-s="full">${icon(S.size === "full" ? "check" : "image")}Full size<span class="hint">The original. Slower on cell service.</span></button></li>
    </ul>`);
  $$("[data-s]", el).forEach(b => b.onclick = () => {
    S.size = b.dataset.s; ls.set("size", S.size);
    closeSheet(); toast(S.size === "full" ? "Photos will be sent full size." : "Photos will be sent at standard size.");
  });
}

async function spaceSheet() {
  const keys = await DB.bkeys().catch(() => []);
  const views = keys.filter(k => String(k).startsWith("v:")).length, thumbs = keys.filter(k => String(k).startsWith("t:")).length;
  const used = await storageUse();
  const el = openSheet(`
    <h2>Space on this ${isTouch ? "phone" : "computer"}</h2>
    <div class="stats"><div><b>${thumbs}</b><span>small photos for the lists</span></div><div><b>${views}</b><span>photos saved for viewing with no signal</span></div></div>
    <p class="muted">${used ? esc(used) + " in all. " : ""}Photos waiting to send are never removed here.</p>
    <div class="acts"><button class="btn line" data-x>Close</button><button class="btn bad" id="freeYes" ${views ? "" : "disabled"}>Remove saved photos</button></div>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#freeYes", el).onclick = async () => {
    const vk = keys.filter(k => String(k).startsWith("v:"));
    try { await DB.bdel(vk); vk.forEach(dropURL); closeSheet(true); toast("Saved photos removed. They'll download again when you open them with signal."); }
    catch (e) { toast(e.message); }
  };
}

async function peopleSheet() {
  const el = openSheet(`<h2>People who can use the app</h2><div id="pp"><div class="loading-row"></div><div class="loading-row"></div></div>`);
  try {
    const people = await DB.call("people", {}, 30000);
    if (el.isConnected) renderPeople(el, people);
  } catch (err) {
    if (el.isConnected) $("#pp", el).innerHTML = `<p class="err">${esc(err.offline ? "People needs signal. Try again when you have service." : err.message)}</p>`;
  }
}
const inviteText = p => "Job Photos app for Ellsworth & Son: " + p.link + " (your code: " + p.code + ")";
function renderPeople(el, people) {
  $("#pp", el).innerHTML = `
    <p class="muted">Everyone gets their own link and code. Turn a person off and their code stops working.</p>
    ${people.map(p => `<div class="person ${p.role === "Off" ? "off" : ""}">
      <div class="who"><b>${esc(p.name)}</b><span>${p.role === "Off" ? "Turned off" : p.role}. Code ${esc(p.code)}</span></div>
      ${p.role !== "Off" && p.link ? `<a class="btn small line" href="${esc(smsHref(inviteText(p)))}" target="_blank" rel="noopener">Text link</a>
        <button class="btn small quiet" data-copy="${esc(p.link)}">Copy</button>` : ""}
      ${p.role === "Owner" ? "" : `<button class="btn small quiet" data-role="${esc(p.code)}" data-to="${p.role === "Off" ? "Crew" : "Off"}">${p.role === "Off" ? "Turn on" : "Turn off"}</button>`}
    </div>`).join("")}
    <form id="addP" autocomplete="off" style="margin-top:18px">
      <label class="field"><span>Add a person</span><input name="name" maxlength="40" placeholder="Their name"></label>
      <button class="btn tape block" type="submit">${icon("plus")}Add and make their link</button>
    </form>`;
  $$("[data-copy]", el).forEach(b => b.onclick = async () => toast(await copyText(b.dataset.copy) ? "Link copied." : "Couldn't copy. Use Text link instead."));
  $$("[data-role]", el).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { renderPeople(el, await DB.call("setRole", { code: b.dataset.role, role: b.dataset.to }, 30000)); }
    catch (err) { b.disabled = false; toast(err.offline ? "That needs signal." : err.message); }
  });
  $("#addP", el).addEventListener("submit", async e => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    try {
      const p = await DB.call("addPerson", { name, role: "Crew" }, 30000);
      renderPeople(el, await DB.call("people", {}, 30000));
      if (p.link) personAdded(p);
    } catch (err) { btn.disabled = false; toast(err.offline ? "Adding a person needs signal." : err.message); }
  });
}
function personAdded(p) {
  const el = openSheet(`
    <h2>${esc(p.name)} is added</h2>
    <p class="muted">Send ${esc(p.name)} this link. It opens Job Photos and sets up their phone. On an iPhone, after they put it on the home screen, they type the code <b>${esc(p.code)}</b> there once.</p>
    <div class="linkbox"><input id="lk" readonly value="${esc(p.link)}"><button class="btn small line" id="cp">Copy</button></div>
    <div class="acts"><a class="btn tape" href="${esc(smsHref(inviteText(p)))}" target="_blank" rel="noopener">Text the link</a>
      <button class="btn line" id="dn">Done</button></div>`);
  $("#cp", el).onclick = async () => toast(await copyText(p.link, $("#lk", el)) ? "Link copied." : "Press and hold the link to copy it.");
  $("#dn", el).onclick = () => peopleSheet();
}

// ================================================================ what's waiting to send
function sendingSheet() {
  const ops = S.outbox;
  const rows = ops.map(o => {
    const job = jobById(o.job || o.tmp);
    const what = o.t === "job" ? "New job: " + o.name : o.t === "photo" ? "Photo for " + (job ? job.name : "a job") : "Note on a photo";
    return `<div class="qrow">
      <span class="qt" ${o.t === "photo" ? `data-key="q:${esc(o.id)}:t"` : ""}></span>
      <div class="qx"><b>${esc(what)}</b><span>${o.failed ? `<span class="why">${esc(o.err || "The sheet didn't take it.")}</span>` : "Saved on this phone " + esc(ago(o.at || Date.now()))}</span></div>
      ${o.failed ? `<button class="btn small quiet" data-drop="${esc(o.id)}">Remove</button>` : ""}
    </div>`;
  }).join("");
  const el = openSheet(`
    <h2>Sending</h2>
    <p class="muted">${ops.length
      ? (S.online ? "These go to the sheet one at a time." : "No signal right now. These stay on this phone and go on their own when there's service" + (isIOS() ? " and the app is open." : "."))
      : "Everything on this phone is in the sheet."}${S.lastOk ? " Last good trip " + esc(ago(S.lastOk)) + "." : ""}</p>
    ${rows ? `<div>${rows}</div>` : ""}
    <div class="acts" style="margin-top:14px"><button class="btn line" data-x>Close</button>
      <button class="btn tape" id="sendNow">${failedOps().length ? "Try again" : "Send now"}</button></div>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#sendNow", el).onclick = async () => {
    await Promise.all(failedOps().map(o => DB.changeOp(o.id, x => Object.assign(x, { failed: false, err: "" }))));
    await loadLocal();
    closeSheet(true);
    kickSync(true);
  };
  $$("[data-drop]", el).forEach(b => b.onclick = async () => {
    const op = S.outbox.find(o => o.id === b.dataset.drop);
    if (op && op.t === "job" && S.outbox.some(o => o.job === op.tmp)) { toast("Photos are waiting on this job. Remove those first."); return; }
    await DB.removeOp(b.dataset.drop);
    await loadLocal();
    sendingSheet();
    rerender();
  });
  paintKeys(el);
}



// ================================================================ thumbnails: from the phone first, the sheet if missing
const TQ = { want: new Set(), busy: 0 };
function setBg(el, u) {
  el.style.backgroundImage = `url("${u}")`;
  el.dataset.painted = "1";
  if (el.classList.contains("ph")) el.innerHTML = "";
}
async function paintKeys(root) {
  const els = $$("[data-key]", root || document).filter(el => !el.dataset.painted);
  for (const el of els) {
    const key = el.dataset.key;
    const u = await blobURL(key);
    if (u) setBg(el, u);
    else if (key.startsWith("t:")) TQ.want.add(key.slice(2));
  }
  pumpThumbs();
}
function pumpThumbs() {
  if (!S.online || !S.setup) return;
  while (TQ.busy < 2 && TQ.want.size) {
    const batch = Array.from(TQ.want).slice(0, 20);
    batch.forEach(id => TQ.want.delete(id));
    TQ.busy++;
    DB.call("thumbs", { ids: batch }, 60000).then(async map => {
      for (const id of Object.keys(map || {})) {
        const blob = DB.b64Blob(map[id], "image/jpeg");
        try { await DB.bput("t:" + id, blob); } catch (e) { /* phone storage full: still show it now */ }
        const u = URL.createObjectURL(blob);
        dropURL("t:" + id);
        S.urls.set("t:" + id, u);
        $$(`[data-key="t:${CSS.escape(id)}"]`).forEach(el => setBg(el, u));
      }
    }).catch(e => { if (e && e.offline) { S.online = false; batch.forEach(id => TQ.want.add(id)); renderStatus(); } })
      .finally(() => { TQ.busy--; pumpThumbs(); });
  }
}
async function prefetchThumbs() {
  const have = new Set(await DB.bkeys().catch(() => []));
  list(S.data.photos).forEach(p => { const id = p.t || p.f; if (id && !have.has("t:" + id)) TQ.want.add(id); });
  pumpThumbs();
}

// ================================================================ job page
function photoTime(p) { return p.taken || p.up || p.at; }
function dayStart(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
// The grid's order: newest day first, and within a day, in the order they were taken.
const gridSort = (a, b) => (dayStart(b.t) - dayStart(a.t)) || (a.t - b.t);

function noteFor(pid) {
  const n = S.outbox.filter(o => o.t === "note" && o.photo === pid).pop();
  return n ? n.caption : null;
}
function jobItems(jobId) {
  const items = [];
  list(S.data.photos).forEach(p => {
    if (p.job !== jobId) return;
    const pending = noteFor(p.id);
    items.push({ kind: "sent", id: p.id, p, t: photoTime(p), cap: pending === null ? p.cap : pending, by: p.by, key: "t:" + (p.t || p.f) });
  });
  S.outbox.forEach(o => {
    if (o.t === "photo" && o.job === jobId) items.push({ kind: "wait", id: o.id, op: o, t: o.taken || o.at, cap: o.caption || "", by: o.by || me().name, key: "q:" + o.id + ":t" });
  });
  S.processing.forEach(ph => { if (ph.job === jobId) items.push({ kind: "proc", id: ph.pid, t: ph.added }); });
  return items.sort(gridSort);
}

function openJob(id) {
  S.view = "job"; S.jobId = id;
  window.scrollTo(0, 0);
  renderJob();
  if (S.online && !S.syncing) kickSync();   // pick up anyone else's new photos
}
function jobMapLink(j, items) {
  if (j.address) return mapsHref(j.address);
  const g = items.filter(x => x.kind === "sent" && x.p.lat !== null && x.p.lng !== null && (x.p.lat || x.p.lng)).sort((a, b) => b.t - a.t)[0];
  return g ? mapsHref(g.p.lat + "," + g.p.lng) : "";
}

function renderJob() {
  const j = jobById(S.jobId);
  if (!j) { showHome(); return; }
  const owner = isOwner() && !j.pending;
  const items = jobItems(j.id);
  const map = jobMapLink(j, items);
  $("#app").innerHTML = `
    <div class="wrap">
      <button class="back" id="backBtn">${icon("back")}All jobs</button>
      <div class="jobhead">
        <h1>${esc(j.name)}${j.pending ? ` <span class="pending">${j.failed ? "Didn't send" : "Not sent yet"}</span>` : ""}</h1>
        ${statusHTML()}
        ${j.address || map ? `<div class="row">${icon("pin")}<span>${esc(j.address || "Where the photos were taken")}</span>${map ? `<a href="${esc(map)}" target="_blank" rel="noopener">Directions</a>` : ""}</div>` : ""}
        ${j.customer ? `<div class="row">${icon("user")}<span>${esc(j.customer)}</span></div>` : ""}
        ${j.status === "Done" ? `<div class="row"><span class="tag">Job done</span></div>` : ""}
        ${j.notes ? `<p class="notes">${esc(j.notes)}</p>` : ""}
        ${owner ? `<div class="ownerbar">
            <button class="btn small line" id="editJob">${icon("edit")}Edit job</button>
            ${j.folder ? `<a class="btn small quiet" href="${esc(j.folder)}" target="_blank" rel="noopener">${icon("folder")}Drive folder</a>` : ""}
          </div>` : ""}
      </div>
      <div class="adds${isTouch ? "" : " one"}">
        ${isTouch ? `<button class="btn tape" id="camBtn">${icon("camera")}Take photo</button>` : ""}
        <button class="btn ${isTouch ? "line" : "tape"}" id="libBtn">${icon("image")}${isTouch ? "Add from phone" : "Add photos from this computer"}</button>
      </div>
      <label class="sr" for="noteIn">Note for the next photos</label>
      <input class="note-in" id="noteIn" maxlength="300" placeholder="Note for the next photos (optional)" value="${esc(S.note || "")}">
      <div id="saveLine"></div>
      <div id="photos"></div>
      <div style="height:130px"></div>
    </div>`;
  $("#backBtn").onclick = () => showHome();
  $("#syncBtn").onclick = sendingSheet;
  if ($("#camBtn")) $("#camBtn").onclick = () => pick("#pickCam");
  $("#libBtn").onclick = () => pick("#pickLib");
  $("#noteIn").addEventListener("input", e => { S.note = e.target.value; });
  if (owner) $("#editJob").onclick = () => (S.online ? editJobSheet() : needsSignal("Editing a job"));
  renderPhotos();
  renderSaveLine(j);
  renderBar();
}

async function renderSaveLine(j) {
  const box = $("#saveLine");
  if (!box) return;
  const sent = list(S.data.photos).filter(p => p.job === j.id);
  if (!sent.length) { box.innerHTML = ""; return; }
  const have = new Set(await DB.bkeys().catch(() => []));
  const saved = sent.filter(p => have.has("v:" + p.id)).length;
  if (!$("#saveLine") || S.jobId !== j.id) return;
  box.innerHTML = saved >= sent.length
    ? `<div class="saveline">${icon("check")}<span>All ${sent.length} photos are saved on this ${isTouch ? "phone" : "computer"} for no signal.</span></div>`
    : `<div class="saveline"><span>${saved} of ${sent.length} photos saved for no signal.</span><button class="btn small line" id="saveAll">${icon("down")}Save the rest</button></div>`;
  const b = $("#saveAll");
  if (b) b.onclick = () => saveJobOffline(j, sent.filter(p => !have.has("v:" + p.id)));
}
async function saveJobOffline(j, todo) {
  if (!S.online) { needsSignal("Saving photos"); return; }
  const b = $("#saveAll");
  let n = 0, stop = false;
  const next = async () => {
    while (todo.length && !stop) {
      const p = todo.shift();
      try {
        const r = await DB.call("view", { id: p.id, full: false }, 60000);
        await DB.bput("v:" + p.id, DB.b64Blob(r.data, r.mime));
        n++;
        if (b && b.isConnected) b.textContent = "Saving " + n + "…";
      } catch (e) {
        if (e && e.offline) { stop = true; S.online = false; }
        if (e && e.name === "QuotaExceededError") { stop = true; toast("This phone is out of space for saved photos."); }
      }
    }
  };
  if (b) b.disabled = true;
  await Promise.all([next(), next()]);
  if (stop && !S.online) toast("Signal dropped. " + n + " photos saved so far.");
  else toast(n + " photos saved for no signal.");
  if (S.view === "job" && S.jobId === j.id) renderSaveLine(j);
}

function renderPhotos() {
  const box = $("#photos");
  if (!box || S.view !== "job") return;
  const items = jobItems(S.jobId);
  if (!items.length) {
    box.innerHTML = `<div class="empty"><h2>No photos yet</h2><p>Take one, or add some from your ${isTouch ? "phone" : "computer"}. It works with no signal too.</p></div>`;
    return;
  }
  const groups = new Map();
  items.forEach(x => {
    const k = dayKey(x.t);
    if (!groups.has(k)) groups.set(k, { t: x.t, items: [] });
    groups.get(k).items.push(x);
  });
  let html = "";
  groups.forEach(g => {
    html += `<div class="day"><h2>${esc(fmtDay(g.t))}</h2><span class="num">${g.items.length} photo${g.items.length === 1 ? "" : "s"}</span></div><div class="grid">`;
    html += g.items.map(x => {
      if (x.kind === "proc") return `<div class="tile sending"><span class="st"><span class="spin" style="width:14px;height:14px;border-width:2px"></span></span></div>`;
      if (x.kind === "wait") {
        const failed = x.op.failed;
        return `<button class="tile ${failed ? "failed" : "waiting"}" data-v="${esc(x.id)}" data-key="${esc(x.key)}" aria-label="${failed ? "Didn't send" : "Waiting to send"}">
          <span class="st">${failed ? "!" : icon("clock")}</span>${x.cap ? `<span class="cap" title="Has a note">${icon("edit")}</span>` : ""}</button>`;
      }
      return `<button class="tile" data-v="${esc(x.id)}" data-key="${esc(x.key)}" aria-label="Photo from ${esc(fmtFull(x.t))}">${x.cap ? `<span class="cap" title="Has a note">${icon("edit")}</span>` : ""}</button>`;
    }).join("");
    html += "</div>";
  });
  box.innerHTML = html;
  $$(".tile[data-v]", box).forEach(b => b.onclick = () => openViewer(b.dataset.v));
  paintKeys(box);
}

function editJobSheet() {
  const j = jobById(S.jobId);
  const el = openSheet(`
    <h2>Edit job</h2>
    <form id="ej" autocomplete="off">
      <label class="field"><span>Job name</span><input name="name" required maxlength="80" value="${esc(j.name)}"></label>
      <label class="field"><span>Address</span><input name="address" maxlength="200" value="${esc(j.address)}"></label>
      <label class="field"><span>Customer</span><input name="customer" maxlength="80" value="${esc(j.customer)}"></label>
      <label class="field"><span>Notes</span><textarea name="notes" maxlength="1000">${esc(j.notes)}</textarea></label>
      <label class="field"><span>Other names for this job <small>(helps search and folder loading)</small></span><input name="aliases" maxlength="300" value="${esc(j.aliases)}"></label>
      <label class="field"><span>Status</span><select name="status">
        <option value="Active" ${j.status !== "Done" ? "selected" : ""}>Active: shows on the job list</option>
        <option value="Done" ${j.status === "Done" ? "selected" : ""}>Done: moves under Done</option></select></label>
      <div class="acts"><button type="button" class="btn line" data-x>Cancel</button><button class="btn tape" type="submit">Save job</button></div>
    </form>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#ej", el).addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, btn = $("button[type=submit]", f);
    btn.disabled = true;
    try {
      const nj = await DB.call("updateJob", { id: j.id, name: f.name.value, address: f.address.value, customer: f.customer.value, notes: f.notes.value, aliases: f.aliases.value, status: f.status.value }, 30000);
      await DB.update("data", dd => { dd = dd || { jobs: [], photos: [] }; dd.jobs = list(dd.jobs).map(x => (x.id === nj.id ? Object.assign({}, x, nj) : x)); return dd; });
      await loadLocal();
      closeSheet(true); renderJob(); toast("Job saved.");
    } catch (err) { btn.disabled = false; toast(err.offline ? "Saving the job needs signal." : err.message); }
  });
}

// ================================================================ photo viewer
const V = { open: false, i: 0, list: [], z: 1, x: 0, y: 0, el: null, req: 0, warned: false };
function viewerList() { return jobItems(S.jobId).filter(x => x.kind !== "proc"); }
function openViewer(id) {
  V.list = viewerList();
  V.i = Math.max(0, V.list.findIndex(x => x.id === id));
  V.open = true; V.warned = false;
  V.el = document.createElement("div");
  V.el.className = "viewer";
  V.el.setAttribute("role", "dialog");
  V.el.setAttribute("aria-label", "Photo");
  V.el.innerHTML = `
    <div class="vtop"><button class="vbtn" data-v="close" aria-label="Close">${icon("close")}</button><div class="grow num" id="vCount"></div><span style="width:46px"></span></div>
    <div class="stage" id="vStage"><img id="vImg" alt=""><span class="vload hidden" id="vLoad"><span class="spin"></span></span>
      <button class="nav prev" data-v="prev" aria-label="Previous photo">${icon("back")}</button><button class="nav next" data-v="next" aria-label="Next photo">${icon("next")}</button></div>
    <div class="vinfo"><div class="meta" id="vMeta"></div><div class="vcap" id="vCap"></div><div class="vacts" id="vActs"></div></div>`;
  document.body.append(V.el);
  document.body.style.overflow = "hidden";
  document.body.classList.add("viewing");
  V.el.addEventListener("click", e => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    const a = b.dataset.v;
    if (a === "close") closeViewer();
    if (a === "prev") step(-1);
    if (a === "next") step(1);
    if (a === "full") showPhoto(true);
    if (a === "cap") captionSheet();
    if (a === "del") deletePhoto();
    if (a === "move") moveSheet();
    if (a === "unq") unqueuePhoto();
  });
  bindGestures($("#vStage", V.el));
  showPhoto(false);
}
function closeViewer() {
  if (!V.open) return;
  V.open = false;
  V.el.remove(); V.el = null;
  document.body.style.overflow = "";
  document.body.classList.remove("viewing");
  closeSheet(true);
}
document.addEventListener("keydown", e => {
  if (!V.open || sheetEl) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});
function step(d) {
  const n = V.i + d;
  if (n < 0 || n >= V.list.length) return;
  V.i = n; showPhoto(false);
}
function canChange(x) { return !!S.setup && (isOwner() || x.by === me().name); }

async function showPhoto(full) {
  const x = V.list[V.i];
  if (!x || !V.el) return;
  resetZoom();
  const img = $("#vImg", V.el), req = ++V.req;
  const small = await blobURL(x.key);
  if (req !== V.req || !V.el) return;
  if (!full) img.src = small || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  $("#vCount", V.el).textContent = (V.i + 1) + " of " + V.list.length;
  $("#vMeta", V.el).innerHTML = "Taken " + esc(fmtFull(x.t)) + (x.kind === "wait"
    ? "<br>" + (x.op.failed ? "Didn't send: " + esc(x.op.err || "") : "Waiting on this phone to send")
    : (x.by ? "<br>Sent by " + esc(x.by) : ""));
  const cap = $("#vCap", V.el);
  cap.textContent = x.cap || (canChange(x) ? "No note yet" : "");
  cap.className = "vcap" + (x.cap ? "" : " none");
  const acts = [];
  if (canChange(x)) acts.push(`<button data-v="cap">${x.cap ? "Change note" : "Add note"}</button>`);
  if (x.kind === "sent" && x.p.v && !full) acts.push(`<button data-v="full">Full size</button>`);
  if (x.kind === "sent" && isOwner()) acts.push(`<button data-v="move">Move to another job</button>`);
  if (x.kind === "sent" && canChange(x)) acts.push(`<button data-v="del">Delete</button>`);
  if (x.kind === "wait") acts.push(`<button data-v="unq">Don't send this one</button>`);
  $("#vActs", V.el).innerHTML = acts.join("");
  $$(".nav", V.el).forEach(b => { b.style.visibility = (b.dataset.v === "prev" ? V.i > 0 : V.i < V.list.length - 1) ? "visible" : "hidden"; });

  if (x.kind === "wait") {
    const u = (await blobURL("q:" + x.id + ":v")) || (await blobURL("q:" + x.id + ":d"));
    if (req === V.req && V.el && u) img.src = u;
    return;
  }
  if (!full) {
    const saved = await blobURL("v:" + x.id);
    if (req !== V.req || !V.el) return;
    if (saved) { img.src = saved; return; }
  }
  if (!S.online) {
    if (!V.warned) { V.warned = true; toast(full ? "Full size needs signal." : "No signal: showing the small copy. Use “Save the rest” on the job to keep big copies on the phone."); }
    return;
  }
  $("#vLoad", V.el).classList.remove("hidden");
  try {
    const r = await DB.call("view", { id: x.id, full: !!full }, 90000);
    const blob = DB.b64Blob(r.data, r.mime);
    if (!full) { try { await DB.bput("v:" + x.id, blob); } catch (e) { /* no room: show it anyway */ } }
    if (req !== V.req || !V.el) return;
    const u = URL.createObjectURL(blob);
    if (!full) { dropURL("v:" + x.id); S.urls.set("v:" + x.id, u); }
    img.src = u;
  } catch (err) {
    if (err && err.offline) S.online = false;
    if (req === V.req && V.el) toast(err.offline ? "No signal: showing the small copy." : err.message);
  } finally { if (req === V.req && V.el) $("#vLoad", V.el).classList.add("hidden"); }
}

function captionSheet() {
  const x = V.list[V.i];
  const el = openSheet(`<h2>Note for this photo</h2><form id="cf"><label class="field"><span class="sr">Note</span><textarea name="cap" maxlength="300" autofocus>${esc(x.cap)}</textarea></label>
    <div class="acts"><button type="button" class="btn line" data-x>Cancel</button><button class="btn tape" type="submit">Save note</button></div></form>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#cf", el).addEventListener("submit", async e => {
    e.preventDefault();
    const text = e.target.cap.value.trim();
    try {
      if (x.kind === "wait") {
        await DB.changeOp(x.id, o => Object.assign(o, { caption: text }));
      } else if (S.online) {
        try {
          const np = await DB.call("editPhoto", { id: x.id, caption: text }, 30000);
          await DB.update("data", dd => { dd.photos = list(dd.photos).map(p => (p.id === np.id ? Object.assign({}, p, np) : p)); return dd; });
        } catch (err) {
          if (!err.offline) throw err;
          S.online = false;
          await DB.queue({ id: "o" + rid(), t: "note", photo: x.id, job: S.jobId, caption: text, at: Date.now(), by: me().name }, {});
        }
      } else {
        await DB.queue({ id: "o" + rid(), t: "note", photo: x.id, job: S.jobId, caption: text, at: Date.now(), by: me().name }, {});
      }
      await loadLocal();
      closeSheet(true);
      V.list = viewerList();
      showPhoto(false); renderPhotos();
      toast(x.kind === "sent" && !S.online ? "Note saved on this phone. It goes to the sheet when there's signal." : "Note saved.");
      kickSync();
    } catch (err) { toast(err.message); }
  });
}
function moveSheet() {
  if (!S.online) { needsSignal("Moving a photo"); return; }
  const x = V.list[V.i];
  const others = list(S.data.jobs).filter(j => j.id !== S.jobId).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const el = openSheet(`<h2>Move this photo to</h2><ul class="menu">${others.map(j => `<li><button data-j="${esc(j.id)}">${esc(j.name)}</button></li>`).join("")}</ul>`);
  $$("[data-j]", el).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const np = await DB.call("editPhoto", { id: x.id, jobId: b.dataset.j }, 30000);
      await DB.update("data", dd => { dd.photos = list(dd.photos).map(p => (p.id === np.id ? Object.assign({}, p, np) : p)); return dd; });
      await loadLocal();
      closeSheet(true); afterPhotoGone();
      toast("Photo moved to " + ((jobById(b.dataset.j) || {}).name || "the other job") + ".");
      kickSync();
    } catch (err) { b.disabled = false; toast(err.offline ? "Moving needs signal." : err.message); }
  });
}
function deletePhoto() {
  if (!S.online) { needsSignal("Deleting a photo"); return; }
  const x = V.list[V.i];
  const el = openSheet(`<h2>Delete this photo?</h2><p class="muted">It goes to the Google Drive trash, where it stays for 30 days.</p>
    <div class="acts"><button class="btn line" data-x>Keep it</button><button class="btn bad" id="delYes">${icon("trash")}Delete photo</button></div>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#delYes", el).onclick = async () => {
    try {
      await DB.call("deletePhoto", { id: x.id }, 30000);
      await DB.update("data", dd => { dd.photos = list(dd.photos).filter(p => p.id !== x.id); return dd; });
      await DB.bdel(["v:" + x.id]);
      await loadLocal();
      closeSheet(true); afterPhotoGone(); toast("Photo deleted.");
    } catch (err) { toast(err.offline ? "Deleting needs signal." : err.message); }
  };
}
function unqueuePhoto() {
  const x = V.list[V.i];
  const el = openSheet(`<h2>Don't send this photo?</h2><p class="muted">It hasn't reached the sheet yet, so it's only on this phone. This takes it off the phone for good.</p>
    <div class="acts"><button class="btn line" data-x>Keep it</button><button class="btn bad" id="unqYes">${icon("trash")}Don't send it</button></div>`);
  $("[data-x]", el).onclick = () => closeSheet();
  $("#unqYes", el).onclick = async () => {
    await DB.removeOp(x.id);
    ["q:" + x.id + ":t", "q:" + x.id + ":v", "q:" + x.id + ":d"].forEach(dropURL);
    await loadLocal();
    closeSheet(true); afterPhotoGone(); toast("Photo taken off the phone.");
  };
}
function afterPhotoGone() {
  V.list = viewerList();
  if (!V.list.length) { closeViewer(); renderJob(); return; }
  V.i = Math.min(V.i, V.list.length - 1);
  showPhoto(false); renderPhotos();
}

// pinch, double-tap and swipe on the photo
function resetZoom() { V.z = 1; V.x = 0; V.y = 0; applyZoom(); }
function applyZoom() { const img = V.el && $("#vImg", V.el); if (img) img.style.transform = `translate(-50%,-50%) translate(${V.x}px,${V.y}px) scale(${V.z})`; }
function bindGestures(stage) {
  const pts = new Map();
  let start = null, lastTap = 0;
  stage.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { pts: new Map(pts), z: V.z, x: V.x, y: V.y, t: Date.now() };
  });
  stage.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = Array.from(pts.values()), was = Array.from(start.pts.values());
    if (now.length >= 2 && was.length >= 2) {
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      V.z = Math.min(6, Math.max(1, start.z * d(now[0], now[1]) / (d(was[0], was[1]) || 1)));
      applyZoom();
    } else if (now.length === 1 && was.length >= 1) {
      const dx = now[0].x - was[0].x, dy = now[0].y - was[0].y;
      if (V.z > 1) { V.x = start.x + dx; V.y = start.y + dy; applyZoom(); }
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const p0 = start && start.pts.get(e.pointerId), p1 = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (!start) return;
    if (!pts.size) {
      const dx = p1.x - (p0 ? p0.x : p1.x), dy = p1.y - (p0 ? p0.y : p1.y), fast = Date.now() - start.t < 450;
      if (V.z === 1 && start.pts.size === 1 && fast && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
      else if (start.pts.size === 1 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        if (Date.now() - lastTap < 320) { if (V.z > 1) resetZoom(); else { V.z = 2.5; applyZoom(); } lastTap = 0; }
        else lastTap = Date.now();
      }
      if (V.z <= 1.02) resetZoom();
      start = null;
    } else {
      start = { pts: new Map(pts), z: V.z, x: V.x, y: V.y, t: Date.now() };
    }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
}



// ================================================================ taking and adding photos: saved on the phone first, sent after
function pick(sel) {
  if (!S.jobId) return;
  S.pickJob = S.jobId;
  const inp = $(sel);
  inp.value = "";
  inp.click();
}
["#pickCam", "#pickLib"].forEach(sel => $(sel).addEventListener("change", e => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  const jobId = S.pickJob || S.jobId;
  S.pickJob = null;
  if (files.length && jobId) addFiles(files, jobId, S.note || "", S.size);
}));

const PQ = { items: [], running: 0 };
function addFiles(files, jobId, caption, size) {
  const photos = files.filter(isPhotoFile);
  const skipped = files.length - photos.length;
  if (skipped) toast(skipped + (skipped === 1 ? " file isn't a photo, so it was skipped." : " files aren't photos, so they were skipped."));
  photos.forEach(file => {
    const ph = { pid: newPid(), job: jobId, added: Date.now() + PQ.items.length };
    S.processing.push(ph);
    PQ.items.push({ file, ph, jobId, caption, size });
  });
  S.batch.total += photos.length;
  if (caption && S.view === "job" && S.jobId === jobId) { S.note = ""; const n = $("#noteIn"); if (n) n.value = ""; }
  if (S.view === "job") renderPhotos();
  renderStatus();
  requestPersist();
  for (let i = PQ.running; i < (isTouch ? 1 : 2); i++) prepWorker();
}
async function prepWorker() {
  PQ.running++;
  try {
    while (PQ.items.length) {
      // With signal, don't let a big load pile up on the phone: send some before getting more ready.
      while (S.online && waitingPhotos().length >= 40) await sleep(1000);
      const it = PQ.items.shift();
      const { file, ph } = it;
      try {
        const pr = await preparePhoto(file, it.size);
        const opId = "o" + ph.pid;
        const op = {
          id: opId, t: "photo", pid: ph.pid, job: S.jobmap[it.jobId] || it.jobId, caption: it.caption || "",
          taken: pr.taken, lat: pr.lat, lng: pr.lng, w: pr.w, h: pr.h, mime: pr.mime,
          origName: pr.origName, origSize: pr.origSize, at: Date.now(), by: me().name
        };
        const files = { ["q:" + opId + ":d"]: pr.main };
        if (pr.view) files["q:" + opId + ":v"] = pr.view;
        if (pr.thumb) files["q:" + opId + ":t"] = pr.thumb;
        await DB.queue(op, files);
        S.outbox.push(op);
      } catch (e) {
        S.batch.total = Math.max(0, S.batch.total - 1);
        toast(e && e.name === "QuotaExceededError" ? "This phone is out of space. Free some up, then add the photo again." : "Couldn't save “" + (file.name || "a photo") + "”: " + (e.message || e));
      } finally {
        S.processing = S.processing.filter(x => x !== ph);
        softRender();
      }
      registerBgSync();
      kickSync();
    }
  } finally { PQ.running--; }
}

// ================================================================ the trip to the sheet
async function kickSync() {
  if (!S.setup) return;
  if (S.syncing) { S.again = true; return; }
  S.syncing = true;
  renderStatus();
  let r = null;
  try {
    r = await DB.withLock(() => DB.syncAll({ parallel: isTouch ? 2 : 3, onStep: onSyncStep }));
  } catch (e) { r = { ok: false, error: e && e.message }; }
  S.syncing = false;
  if (r && r.nokey) {
    S.setup = null;
    showSignIn("This phone's code isn't working anymore." + (S.outbox.length ? " Photos waiting on it stay here until you set it up again." : ""));
    return;
  }
  S.online = !(r && r.offline);
  if (r && r.ok) S.lastErr = "";
  else if (r && r.error && !r.offline) S.lastErr = r.error;
  try { await loadLocal(); } catch (e) { /* storage hiccup: next round */ }
  rerender();
  if (r && r.pulled) prefetchThumbs();
  if (S.again) { S.again = false; setTimeout(kickSync, 300); }
  else if (S.outbox.some(o => !o.failed)) {
    registerBgSync();
    clearTimeout(S.retryT);
    if (S.online) S.retryT = setTimeout(kickSync, 20000);
  }
  if (S.reloadWhenIdle && !S.outbox.length && !S.processing.length) location.reload();
}
let stepT = null;
function onSyncStep(e) {
  if (e.phase === "done" && e.op.t === "photo") S.batch.done++;
  clearTimeout(stepT);
  stepT = setTimeout(async () => { try { await loadLocal(); } catch (x) { /* next time */ } softRender(); }, 400);
}

// Redraws what changed without jumping the screen around.
function softRender() {
  if (S.view === "home") { renderJobList(); renderStatus(); }
  else if (S.view === "job") { renderPhotos(); renderStatus(); }
  else renderBar();
}
function rerender() {
  if (S.view === "home") { renderJobList(); renderStatus(); }
  else if (S.view === "job") {
    const y = window.scrollY;
    renderJob();
    window.scrollTo(0, y);
  }
}

function renderBar() {
  const bar = $("#upbar");
  if (!bar) return;
  const waiting = waitingPhotos().length + S.processing.length;
  const failed = failedOps().length;
  if (!waiting && !S.batch.total) { bar.classList.add("hidden"); document.body.classList.remove("hasbar"); return; }
  bar.classList.remove("hidden");
  document.body.classList.add("hasbar");
  let l1, l2 = "", pct = 0;
  const total = Math.max(S.batch.total, S.batch.done + waiting);
  if (!waiting) {
    bar.classList.add("ok");
    l1 = `<span class="ic" style="color:var(--ok)">${icon("check")}</span><span class="grow">${S.batch.done} photo${S.batch.done === 1 ? "" : "s"} sent</span>`;
    pct = 100;
    clearTimeout(S.barT);
    S.barT = setTimeout(() => { if (!waitingPhotos().length && !S.processing.length) { S.batch = { total: 0, done: 0 }; renderBar(); } }, 5000);
  } else {
    bar.classList.remove("ok");
    pct = total ? Math.round(100 * S.batch.done / total) : 0;
    if (failed && !S.syncing) {
      l1 = `<span class="ic" style="color:var(--bad)">${icon("alert")}</span><span class="grow">${failed} didn't send</span><button class="btn small tape" id="barWhy">See why</button>`;
    } else if (S.syncing && S.online) {
      l1 = `<span class="spin"></span><span class="grow">Sending ${Math.min(S.batch.done + 1, total)} of ${total}</span>`;
      l2 = isAndroid() ? "You can keep working. With signal it finishes even if you close the app." : "Keep the app open until it says sent.";
    } else if (S.processing.length) {
      l1 = `<span class="spin"></span><span class="grow">Saving ${S.processing.length} photo${S.processing.length === 1 ? "" : "s"} on this phone</span>`;
    } else {
      l1 = `<span class="ic" style="color:var(--warn)">${icon("clock")}</span><span class="grow">${waiting} photo${waiting === 1 ? "" : "s"} waiting for signal</span><button class="btn small line" id="barWhy">Details</button>`;
      l2 = "They're saved on this phone and send on their own when there's service" + (isIOS() ? " and the app is open." : ".");
    }
  }
  bar.innerHTML = `<div class="in"><div class="l1">${l1}</div>${l2 ? `<div class="l2">${l2}</div>` : ""}<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  const w = $("#barWhy", bar);
  if (w) w.onclick = sendingSheet;
}

function registerBgSync() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then(reg => (reg.sync && reg.sync.register ? reg.sync.register("jp-send") : null)).catch(() => { /* not on this phone */ });
}
let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const sm = navigator.storage;
    if (sm && sm.persist) (sm.persisted ? sm.persisted() : Promise.resolve(false)).then(p => p || sm.persist()).catch(() => { /* best effort */ });
  } catch (e) { /* best effort */ }
}

window.addEventListener("online", () => { S.online = true; renderStatus(); kickSync(); pumpThumbs(); });
window.addEventListener("offline", () => { S.online = false; renderStatus(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.setup && Date.now() - (S.lastTry || 0) > 15000) { S.lastTry = Date.now(); kickSync(); }
});
setInterval(() => {
  if (document.visibilityState !== "visible" || !S.setup || S.syncing) return;
  if (S.outbox.some(o => !o.failed) || Date.now() - (S.lastOk || 0) > 5 * 60000) { S.lastTry = Date.now(); kickSync(); }
}, 60000);
window.addEventListener("beforeunload", e => {
  if (S.processing.length) { e.preventDefault(); e.returnValue = ""; }
});

// ================================================================ load a whole folder of job folders (owner, on a computer)
function importSheet() {
  if (!S.online) { needsSignal("Loading a folder"); return; }
  const el = openSheet(`
    <h2>Load job photos from this computer</h2>
    <p class="muted">Choose the folder that has one folder per job inside it, like “locations and pics”. Each folder's photos go into the job with the same name. A folder with no matching job becomes a new job. Photos already in the app get skipped.</p>
    <button class="btn tape block" id="pickD">${icon("folder")}Choose the folder</button>
    <div id="impRes"></div>`);
  $("#pickD", el).onclick = () => { const inp = $("#pickDir"); inp.value = ""; inp.click(); };
}
$("#pickDir").addEventListener("change", e => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  const el = sheetEl && $("#impRes", sheetEl) ? sheetEl : null;
  if (files.length && el) planImport(el, files);
});
function matchJob(folder) {
  const n = norm(folder);
  const names = j => [j.name].concat(String(j.aliases || "").split(/[;,\n]/)).map(norm).filter(Boolean);
  const jobs = allJobs();
  return jobs.find(j => names(j).includes(n))
    || jobs.find(j => names(j).some(x => x.length > 4 && n.length > 4 && (x.includes(n) || n.includes(x))))
    || null;
}
async function planImport(el, files) {
  const box = $("#impRes", el);
  box.innerHTML = '<div class="loading-row"></div>';
  const groups = new Map();
  files.forEach(f => {
    const parts = String(f.webkitRelativePath || f.name).split("/");
    const g = parts.length >= 3 ? parts[1] : parts[0];
    if (!groups.has(g)) groups.set(g, { name: g, photos: [], other: 0 });
    if (isPhotoFile(f)) groups.get(g).photos.push(f); else groups.get(g).other++;
  });
  let index = {};
  try { index = await DB.call("importIndex", {}, 60000); } catch (err) { toast(err.offline ? "No signal: can't check what's already in." : err.message); }
  const waitingNames = new Set(waitingPhotos().map(o => o.job + "|" + String(o.origName || "").toLowerCase() + "|" + o.origSize));
  const rows = Array.from(groups.values()).map(g => {
    const job = matchJob(g.name);
    const have = new Set((job && index[job.id]) || []);
    const fresh = g.photos.filter(f => !have.has(f.name.toLowerCase() + "|" + f.size) && !(job && waitingNames.has(job.id + "|" + f.name.toLowerCase() + "|" + f.size)))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    return { g, job, fresh, already: g.photos.length - fresh.length, on: fresh.length > 0 };
  }).sort((a, b) => a.g.name.localeCompare(b.g.name, "en", { numeric: true }));
  const draw = () => {
    const total = rows.filter(r => r.on).reduce((n, r) => n + r.fresh.length, 0);
    const other = rows.reduce((n, r) => n + r.g.other, 0);
    box.innerHTML = `
      <table class="imp"><thead><tr><th></th><th>Folder, and the job it goes to</th><th class="n">To send</th><th class="n">Already in</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" ${r.on ? "checked" : ""} ${r.fresh.length ? "" : "disabled"} aria-label="Send ${esc(r.g.name)}"></td>
        <td><b>${esc(r.g.name)}</b><br>${r.job ? esc(r.job.name) : `<span class="new">New job: ${esc(titleCase(r.g.name))}</span>`}</td>
        <td class="n num">${r.fresh.length}</td><td class="n num">${r.already}</td></tr>`).join("")}
      </tbody></table>
      ${other ? `<p class="muted">${other} file${other === 1 ? " isn't a photo" : "s aren't photos"} (videos, PDFs and such), so ${other === 1 ? "it stays" : "they stay"} on this computer.</p>` : ""}
      <label class="field"><span>Photo size</span><select id="impSize">
        <option value="standard" ${S.size === "standard" ? "selected" : ""}>Standard (2560 px, sends fast)</option>
        <option value="full" ${S.size === "full" ? "selected" : ""}>Full size (the originals)</option></select></label>
      <button class="btn tape block" id="impGo" ${total ? "" : "disabled"}>${icon("upload")}Send ${total} photo${total === 1 ? "" : "s"}</button>`;
    $$("input[data-i]", box).forEach(c => c.onchange = () => { rows[+c.dataset.i].on = c.checked; draw(); });
    $("#impGo", box).onclick = () => runImport(rows.filter(r => r.on && r.fresh.length), $("#impSize", box).value);
  };
  draw();
}
async function runImport(rows, size) {
  for (const r of rows) {
    let jobId = r.job && r.job.id;
    if (!jobId) {
      const tmp = "tmp-" + rid();
      const op = { id: "o" + rid(), t: "job", tmp, name: titleCase(r.g.name), aliases: r.g.name, at: Date.now(), by: me().name };
      try { await DB.queue(op, {}); S.outbox.push(op); jobId = tmp; }
      catch (err) { toast("Couldn't start " + r.g.name + ": " + err.message); continue; }
    }
    addFiles(r.fresh, jobId, "", size);
  }
  closeSheet(true);
  if (S.view === "home") showHome();
  toast("Loading now. Leave this window open until it says sent.");
}

// ================================================================ the copy of the app kept on this phone
function setupWorker() {
  if (!("serviceWorker" in navigator)) return;
  let had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch(() => { /* the app still works while it's open */ });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!had) { had = true; return; }                  // first install: nothing to reload
    if (!S.processing.length && !S.syncing && !sheetEl && !V.open) location.reload();
    else S.reloadWhenIdle = true;                      // a new version: switch over once things are quiet
  });
  navigator.serviceWorker.addEventListener("message", async e => {
    if (e.data && e.data.t === "synced") { try { await loadLocal(); } catch (x) { /* next time */ } rerender(); }
  });
}

// ================================================================ go
setupWorker();
start();
})();
