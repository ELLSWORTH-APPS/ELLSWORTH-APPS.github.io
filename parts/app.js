/* Parts: the filters, teeth and service parts in stock, for the crew's phones.
   Everything lives on this phone first. What you do waits in an outbox and goes to your sheet by itself
   once there's signal. Counts change right away, under your name, and the history can undo any of it.
   Parts (the whole list), Machines (what each machine takes, with Took 1), Order (what's out or low),
   History (everything, with undo), and Count the shelf (one part at a time). */
(function () {
  "use strict";
  const M = window.PLSync;
  const CFG = window.PL_CONFIG || {};
  const VERSION = window.PL_VERSION || "dev";
  const BOOT_AT = Date.now();
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const SHARE_SVG = '<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  const POLL_MS = 120000;
  const LOCK_CHOICES = [[0, "Every time I open it"], [15 * 60000, "After 15 minutes away"], [60 * 60000, "After an hour away"], [-1, "Never"]];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // How the Parts list groups parts. The first one a part's type matches is its group.
  const GROUPS = [
    ["filters", "Filters", /filter|separator|breather|element/i],
    ["teeth", "Teeth and edges", /tooth|teeth|edge|cutter|end bit|adapter|\bpins?\b|retainer/i],
    ["belts", "Belts", /belt/i],
    ["small", "Small engine", /spark|plug|recoil|carb|primer|chain|\bbar\b|blade/i],
    ["fluids", "Fluids and grease", /grease|oil|fluid|coolant|\bdef\b|hydraulic|lube/i],
    ["other", "Other", /^/]
  ];
  // What a machine usually takes, by its category, for the "Add a part it takes" buttons on its page.
  const SLOTS = [
    [/excavator|payloader|skid|loader|dozer|haul|roller/i, ["Oil filter", "Fuel filter", "Fuel/water separator", "Air filter", "Cab air filter", "Hydraulic filter", "Teeth", "Cutting edge", "Belt"]],
    [/dump|tractor|pickup|truck/i, ["Oil filter", "Fuel filter", "Fuel/water separator", "Air filter", "Cab air filter", "DEF filter", "Belt"]],
    [/small engine/i, ["Spark plug", "Air filter", "Fuel filter", "Belt"]],
    [/tow|lift/i, ["Oil filter", "Fuel filter", "Air filter", "Belt"]]
  ];
  const FIELD_LABEL = { pn: "Part #", alt: "Other part #s", desc: "Description", type: "Type", where: "Where it's kept", min: "Keep at least", notes: "Notes", fits: "Fits" };
  const FIELD_WORDS = { pn: "the part number", alt: "the other part numbers", desc: "the description", type: "the type", where: "where it's kept",
    min: "the keep-at-least number", notes: "the notes", fits: "which machines it fits" };
  const DETAIL_FIELDS = ["pn", "alt", "desc", "type", "where", "min", "notes"];

  const S = {
    phase: "boot",   // boot | setup | app
    me: { name: "", isOwner: true },
    parts: new Map(), moves: [], machines: [], machineById: new Map(), loaded: false,
    tab: "parts", q: "", mq: "", st: "all", hFilter: "all", hPart: null, hMore: 0,
    openId: null,    // a part's ID, "m:" and a machine's ID, "new" (adding a part) or "count" (counting the shelf)
    editing: null, detailStale: false, listScroll: 0, count: null, forMachine: null,
    keyBad: false, update: false, confirmReset: false, confirmRemove: false, installEvt: null, storageError: false, shareText: ""
  };
  // The sheet's last copy, plus what this phone did that the sheet hasn't confirmed yet.
  const D = {
    setup: null, ver: "", baseAt: 0, loaded: false, parts: new Map(), moves: [], machines: [], config: {}, sheetUrl: "", movesTotal: 0,
    outbox: [], busy: false, again: null, fails: 0, offline: false, lastOk: 0, tick: 0, timer: null, kickTimer: null, swReg: null
  };
  // The PIN lock.
  const L = { pin: null, open: false, mode: "unlock", entry: "", first: "", msg: "", bad: false, shake: false, fails: 0, until: 0, fromSetup: false };

  function lsGet(k, d) { try { const v = localStorage.getItem("pl." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem("pl." + k, JSON.stringify(v)); } catch (e) { /* this phone's convenience only */ } }
  function lsDel(k) { try { localStorage.removeItem("pl." + k); } catch (e) { /* ignore */ } }

  const firstName = n => String(n || "").trim().split(/\s+/)[0] || "";
  const normKey = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const isOffline = () => D.offline || navigator.onLine === false;
  const clone = o => JSON.parse(JSON.stringify(o));
  function numOrNull(x) {
    if (x === null || x === undefined || x === "") return null;
    if (typeof x === "number") return isFinite(x) ? x : null;
    const s = String(x).replace(/[, ]/g, "");
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  const round = n => Math.round(n * 1000) / 1000;
  function fmtQty(n) {
    if (n === null || n === undefined || n === "") return "";
    const x = Number(n);
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
  }
  const plural = (k, word) => fmtQty(k) + " " + word + (k === 1 ? "" : "s");
  function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  const usDate = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function whoName(by) {
    if (!by) return "Someone";
    if (S.me.name && by === S.me.name) return "You";
    return firstName(by);
  }
  const whoIn = by => (S.me.name && by === S.me.name ? "you" : whoName(by));   // in the middle of a sentence
  function whenText(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((startOfToday() - day) / 86400000);
    if (diff === 0) return "today " + t;
    if (diff === 1) return "yesterday " + t;
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? ", " + d.getFullYear() : ""} ${t}`;
  }
  function shortTime(ms) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((startOfToday() - day) / 86400000);
    return diff === 0 ? t : diff === 1 ? "yesterday " + t : (d.getMonth() + 1) + "/" + d.getDate() + " " + t;
  }
  function standalone() {
    try { return !!(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches); } catch (e) { return false; }
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isAndroid() { return /Android/i.test(navigator.userAgent); }
  function newId(prefix) {
    const r = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
    return prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + r;
  }

  // ---------------------------------------------------------------- parts and machines
  const typesList = () => (D.config && Array.isArray(D.config.types) && D.config.types.length ? D.config.types : ["Other"]);
  function groupOf(type) { const g = GROUPS.find(x => x[2].test(type || "")); return g ? g[0] : "other"; }
  const groupName = k => (GROUPS.find(g => g[0] === k) || [k, k])[1];
  function typeRank(type) { const i = typesList().indexOf(type); return i < 0 ? 999 : i; }
  const partTitle = p => p.pn || p.desc || p.type || "Part";
  // The line under the part number: what it is.
  function partWhat(p) {
    if (!p.pn) return p.type;
    return p.desc && normKey(p.desc) !== normKey(p.type) ? p.desc : p.type;
  }
  const machName = id => { const m = S.machineById.get(id); return m ? m.name : ""; };
  const machLabel = id => { const n = machName(id); return n && n !== id ? id + " " + n : id; };
  function stockOf(p) {
    const on = p.on;
    if (on === null || on === undefined || (!p.counted && on <= 0)) return { st: "none", label: "Not counted" };   // taken before anyone counted
    if (on <= 0) return { st: "out", label: "Out" };
    if (p.min !== null && p.min !== undefined && on <= p.min) return { st: "low", label: "Low" };
    return { st: "ok", label: "In stock" };
  }
  const activeParts = () => [...S.parts.values()].filter(p => !p.removed);
  function sortParts(list) {
    return list.sort((a, b) => typeRank(a.type) - typeRank(b.type) || String(a.type).localeCompare(String(b.type)) ||
      partTitle(a).localeCompare(partTitle(b), undefined, { numeric: true }));
  }
  const lowParts = () => activeParts().filter(p => ["out", "low"].includes(stockOf(p).st))
    .sort((a, b) => (stockOf(a).st === "out" ? 0 : 1) - (stockOf(b).st === "out" ? 0 : 1) || typeRank(a.type) - typeRank(b.type) || partTitle(a).localeCompare(partTitle(b)));
  const movesOf = pid => S.moves.filter(m => m.part === pid);
  const partsFor = mid => sortParts(activeParts().filter(p => (p.fits || []).includes(mid)));
  function slotsFor(m) {
    const s = SLOTS.find(x => x[0].test((m && m.cat) || ""));
    const types = typesList();
    return (s ? s[1] : ["Oil filter", "Air filter", "Fuel filter"]).filter(t => types.includes(t));
  }

  // A field as text, the same way the sheet's history writes it.
  function fieldShown(p, k) {
    if (k === "fits") return (p.fits || []).join(", ");
    if (k === "min") return p.min === null || p.min === undefined ? "" : String(p.min);
    return String(p[k] === null || p[k] === undefined ? "" : p[k]).trim();
  }
  function fieldValue(k, shown) {
    if (k === "fits") return shown ? String(shown).split(",").map(x => x.trim().toUpperCase()).filter(Boolean) : [];
    if (k === "min") { const n = numOrNull(shown); return n === null || n < 0 ? null : round(n); }
    if (k === "type") return String(shown || "").trim() || "Other";
    return String(shown === null || shown === undefined ? "" : shown).trim();
  }

  // ---------------------------------------------------------------- data on this phone
  function loadState(st, ver, at) {
    st = st || {};
    D.parts = new Map((st.parts || []).map(p => [p.id, p]));
    D.moves = st.moves || [];
    D.machines = st.machines || [];
    D.config = st.config || {};
    D.sheetUrl = st.sheetUrl || "";
    D.movesTotal = Number(st.movesTotal) || D.moves.length;
    D.ver = String(ver || "");
    D.baseAt = at || 0;
    D.loaded = true;
    applyConfig();
  }
  function applyConfig() {
    const c = D.config || {};
    S.me.name = c.name || "Me";
    S.me.isOwner = c.role !== "crew";
    S.machines = D.machines;
    S.machineById = new Map(D.machines.map(m => [m.id, m]));
    const mark = $("#brandMark"), name = $("#brandName");
    if (mark) mark.textContent = c.mark || "PT";
    if (name) name.textContent = c.brand || "Parts";
    if (c.brand) document.title = c.brand;
  }

  // The sheet's copy with this phone's waiting updates laid on top, so the screen shows them right away.
  const WHAT = { use: "Took", get: "Got in", count: "Counted", add: "Added part", remove: "Took off the list", restore: "Put back on the list" };
  function pendingMove(op, kind, p, extra) {
    return Object.assign({ id: "M" + String(op.id).slice(1), at: op.at, by: S.me.name, kind, what: WHAT[kind] || "Changed", qty: null, part: p.id,
      partName: [p.type, p.pn || p.desc].filter(Boolean).join(" "), unit: "", unitName: "", note: "", undone: "", undoneBy: "", field: "", from: "", to: "", pending: true }, extra || {});
  }
  function derive() {
    const parts = new Map([...D.parts].map(([id, p]) => [id, Object.assign({}, p)]));
    const pend = [], undos = [];
    D.outbox.forEach(op => {
      if (op.t === "add") {
        const src = op.part || {};
        if (!src.id || parts.has(src.id)) return;
        const q = numOrNull(op.count);
        const p = Object.assign({ type: "Other", pn: "", desc: "", min: null, where: "", fits: [], alt: "", notes: "" }, clone(src),
          { on: q, counted: q !== null, countedAt: q !== null ? op.at : "", countedBy: q !== null ? S.me.name : "", at: op.at, by: S.me.name, removed: false, pending: true });
        parts.set(src.id, p);
        pend.push(pendingMove(op, "add", p, { qty: q }));
      } else if (op.t === "edit") {
        const p = parts.get(op.pid); if (!p) return;
        Object.keys(op.patch || {}).forEach(k => {
          if (!FIELD_LABEL[k]) return;
          const from = fieldShown(p, k);
          p[k] = fieldValue(k, k === "fits" ? (op.patch[k] || []).join(",") : op.patch[k]);
          const to = fieldShown(p, k);
          if (from !== to) pend.push(pendingMove(op, "edit", p, { id: "M" + String(op.id).slice(1) + "." + k, what: "Changed " + FIELD_LABEL[k], field: k, from, to }));
        });
        p.pending = true;
      } else if (op.t === "move") {
        const p = parts.get(op.pid); if (!p) return;
        const q = Number(op.qty) || 0;
        if (op.kind === "count") Object.assign(p, { on: q, counted: true, countedAt: op.at, countedBy: S.me.name });
        else p.on = round((p.on === null || p.on === undefined ? 0 : p.on) + (op.kind === "get" ? q : -q));
        p.pending = true;
        pend.push(pendingMove(op, op.kind, p, { qty: q, unit: op.unit || "", unitName: op.unitName || "", note: op.note || "" }));
      } else if (op.t === "remove") {
        const p = parts.get(op.pid); if (!p) return;
        p.removed = op.val !== false;
        pend.push(pendingMove(op, p.removed ? "remove" : "restore", p));
      } else if (op.t === "undo") undos.push(op);
    });
    const seen = new Set(pend.map(m => m.id));
    const moves = pend.slice().reverse().concat(D.moves.filter(m => !seen.has(m.id)));
    // Undos waiting to send: show them, and change what they change.
    undos.forEach(op => {
      const i = moves.findIndex(m => m.id === op.mid);
      if (i < 0) return;
      const m = moves[i], undo = op.val !== false;
      if (!!m.undone === undo) return;
      moves[i] = Object.assign({}, m, { undone: undo ? op.at : "", undoneBy: undo ? S.me.name : "", pendingUndo: true });
      const p = parts.get(m.part);
      if (!p) return;
      if (m.kind === "use" || m.kind === "get") {
        if (p.countedAt && String(m.at) < String(p.countedAt)) return;   // already inside a later count
        const d = (m.kind === "get" ? 1 : -1) * (Number(m.qty) || 0) * (undo ? -1 : 1);
        p.on = round((p.on === null || p.on === undefined ? 0 : p.on) + d);
      } else if (m.kind === "count") p.stale = true;   // the sheet works out what it goes back to
      else if (m.kind === "add") { p.removed = undo; p.stale = true; }
      else if (m.kind === "remove") p.removed = !undo;
      else if (m.kind === "restore") p.removed = undo;
      else if (m.kind === "edit" && FIELD_LABEL[m.field]) {
        if (fieldShown(p, m.field) === (undo ? m.to : m.from)) p[m.field] = fieldValue(m.field, undo ? m.from : m.to);
      }
      p.pending = true;
    });
    S.parts = parts;
    S.moves = moves;
    S.loaded = D.loaded;
    if (S.openId && !validOpen(S.openId) && !["new", "count"].includes(S.openId)) S.openId = null;
  }
  // What a Back step can go back to: a part or a machine that's still there.
  function validOpen(id) {
    if (!id) return null;
    if (/^m:/.test(id)) return S.machineById.has(id.slice(2)) ? id : null;
    return S.parts.has(id) ? id : null;
  }

  function queueOp(op) {
    op.id = newId("O");
    op.at = new Date().toISOString();
    D.outbox.push(op);
    M.addOp(op).catch(() => toast("Couldn't save that on this phone. Its storage may be full."));
    derive();
    askBackgroundSend();
    kick();
    return op;
  }
  const moveIdOf = op => "M" + String(op.id).slice(1);

  // Android can send waiting updates later even if the app is closed by then.
  function askBackgroundSend() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(reg => (reg.sync && reg.sync.register ? reg.sync.register("pl-push") : null)).catch(() => { /* not on this phone */ });
  }

  async function reloadFromDb() {
    const [base, outbox, lastOk] = await Promise.all([M.get("base"), M.get("outbox"), M.get("lastOk")]);
    D.outbox = Array.isArray(outbox) ? outbox : [];
    if (lastOk) D.lastOk = lastOk;
    if (base && base.state && (String(base.ver || "") !== D.ver || (base.at || 0) !== D.baseAt)) loadState(base.state, base.ver, base.at);
    derive();
  }

  function kick() { clearTimeout(D.kickTimer); D.kickTimer = setTimeout(() => sync(), 800); }
  function schedule(ms) { clearTimeout(D.timer); D.timer = setTimeout(() => sync(), ms); }

  // ---------------------------------------------------------------- talking to the sheet
  async function sync(opts) {
    opts = opts || {};
    if (S.phase !== "app" || !D.setup || S.keyBad) return;
    if (D.busy) { D.again = Object.assign(D.again || {}, opts); return; }
    if (!opts.full && !opts.user && document.visibilityState === "hidden" && !D.outbox.length) { schedule(POLL_MS); return; }
    clearTimeout(D.timer);
    D.busy = true;
    D.tick++;
    renderHeader();
    const full = !!opts.full || D.tick % 8 === 0;
    let r;
    try { r = await M.withLock(() => M.syncAll({ full })); }
    catch (e) { r = { ok: false, error: "storage", message: String((e && e.message) || e) }; }
    D.busy = false;
    try { await reloadFromDb(); } catch (e) { /* keep what's on screen */ }
    const again = D.again; D.again = null;
    if (!r || !r.ok) {
      const err = r ? r.error : "";
      if (err === "bad_key") { S.keyBad = true; D.offline = false; render(true); return; }
      D.fails++;
      D.offline = !!(r && r.offline);
      if (err === "busy") { renderHeader(); schedule(3000); return; }
      if (!D.offline && (opts.user || D.fails === 3)) toast("Couldn't sync with your sheet" + (r && r.message ? ": " + r.message : "") + ". It will keep trying.");
      else if (D.offline && opts.user) toast("No signal right now. Everything's saved on this phone and will send by itself.");
      render(true);
      schedule(navigator.onLine === false ? 60000 : Math.min(60000, 5000 * D.fails));
      return;
    }
    D.fails = 0; D.offline = false; D.lastOk = Date.now();
    (r.rejected || []).forEach(x => toast("Couldn't save one update: " + ((x && x.why) || "the sheet turned it down")));
    render(true);
    if (opts.user) toast(D.outbox.length ? "Still sending…" : "Everything's synced with your sheet.");
    if (again) { sync(again); return; }
    schedule(D.outbox.length ? 1500 : POLL_MS);
  }

  // ---------------------------------------------------------------- boot
  async function init() {
    S.tab = "parts";   // the app always opens on the parts list, where Back stays put
    registerSW();
    wireLifecycle();
    let setup = null, base = null, outbox = [], pin = null, lastOk = 0;
    try { [setup, base, outbox, pin, lastOk] = await Promise.all([M.get("setup"), M.get("base"), M.get("outbox"), M.get("pin"), M.get("lastOk")]); }
    catch (e) { S.storageError = true; }
    D.setup = setup || null;
    D.outbox = Array.isArray(outbox) ? outbox : [];
    L.pin = pin || null;
    D.lastOk = lastOk || 0;
    if (base && base.state) loadState(base.state, base.ver, base.at);
    // If this copy of the app now points at a different sync link, use it.
    if (D.setup && CFG.syncUrl && D.setup.url !== CFG.syncUrl) {
      D.setup = Object.assign({}, D.setup, { url: CFG.syncUrl });
      M.set("setup", D.setup).catch(() => { /* next time */ });
    }
    if (!D.setup || !D.loaded) { S.phase = "setup"; render(); return; }
    S.phase = "app";
    derive();
    navStart();
    if (shouldLock()) openLock("unlock");
    render();
    sync({ full: true });
  }

  function wireLifecycle() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (!L.open) lsSet("seenAt", Date.now());
        if (D.outbox.length) askBackgroundSend();
        return;
      }
      if (S.phase !== "app") return;
      if (!L.open && shouldLock()) openLock("unlock");
      sync({ full: true });
      checkForUpdate(false);
    });
    window.addEventListener("online", () => { D.offline = false; renderHeader(); if (S.phase === "app") sync(); });
    window.addEventListener("offline", () => { D.offline = true; renderHeader(); });
    window.addEventListener("pagehide", () => { if (!L.open) lsSet("seenAt", Date.now()); });
    setInterval(() => { if (!L.open && document.visibilityState === "visible") lsSet("seenAt", Date.now()); }, 30000);
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      S.installEvt = e;
      if (S.phase === "setup") renderSignin(); else if (S.tab === "parts") renderParts(); else if (S.tab === "me") renderMe();
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(reg => { D.swReg = reg; }).catch(() => { /* app still works while open */ });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; }   // first install: nothing to swap
      if (reloading) return;
      if (Date.now() - BOOT_AT < 8000 && !S.editing) { reloading = true; location.reload(); return; }
      S.update = true;
      render(true);
    });
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data && e.data.t === "synced" && S.phase === "app") reloadFromDb().then(() => render(true)).catch(() => { /* fine */ });
    });
  }

  let lastUpdateCheck = 0;
  function checkForUpdate(byHand) {
    const reg = D.swReg;
    if (!reg) { if (byHand) toast("Updates show up here once the app is on your home screen."); return; }
    if (!byHand && Date.now() - lastUpdateCheck < 30 * 60000) return;
    lastUpdateCheck = Date.now();
    reg.update().then(() => {
      if (!byHand) return;
      setTimeout(() => { if (!S.update) toast(reg.installing || reg.waiting ? "Getting the new version…" : "You have the latest version."); }, 2500);
    }).catch(() => { if (byHand) toast("Couldn't check for an update. No signal?"); });
  }

  // ---------------------------------------------------------------- one-time setup on this phone
  async function doSetup(form) {
    const code = normKey(form.elements.code.value);
    if (code.length !== 12) return showWarn(form, "setupWarn", "The setup code is 12 letters and numbers, like ABCD-EF23-GH45.");
    if (!CFG.syncUrl) return showWarn(form, "setupWarn", "This copy of the app isn't linked to your sheet yet.");
    if (navigator.onLine === false) return showWarn(form, "setupWarn", "No signal. You need service for this one-time step.");
    setFormBusy(form, true);
    showWarn(form, "setupWarn", "");
    const btn = form.querySelector("button[type=submit]");
    if (btn) btn.textContent = "Downloading the parts list…";
    const device = newId("D");
    let res;
    try { res = await M.post(CFG.syncUrl, { key: code, device, app: VERSION, full: true, ops: [] }, 60000); }
    catch (e) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", e && e.server ? "Your sheet's sync link had a problem: " + e.message
        : "Couldn't reach your sheet. Check your signal and try again.");
    }
    if (!res || !res.ok || !res.state) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", res && res.error === "bad_key" ? "That code doesn't work. Check it and try again."
        : "Your sheet had a problem" + (res && res.message ? ": " + res.message : "") + ". Try again in a minute.");
    }
    const setup = { key: code, url: CFG.syncUrl, device, at: Date.now() };
    try {
      await M.set("setup", setup);
      await M.set("base", { ver: String(res.ver || ""), state: res.state, at: Date.now() });
      await M.set("lastOk", Date.now());
    } catch (e) {
      setFormBusy(form, false);
      if (btn) btn.textContent = "Connect";
      return showWarn(form, "setupWarn", "This phone wouldn't let the app save anything. In Safari, private browsing blocks it.");
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
    D.setup = setup;
    D.lastOk = Date.now();
    loadState(res.state, res.ver, 0);
    derive();
    S.phase = "app";
    S.tab = "parts";
    navStart();
    lsSet("seenAt", Date.now());
    if (!L.pin) openLock("new", true);
    render();
    const n = activeParts().length;
    toast(`All set. ${plural(n, "part")} ${n === 1 ? "is" : "are"} saved on this phone.`);
    schedule(POLL_MS);
  }

  // ---------------------------------------------------------------- PIN lock
  async function pinHash(salt, pin) {
    const data = new TextEncoder().encode(salt + ":" + pin);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 2166136261;   // very old browsers: a plain checksum is enough for a screen lock
    data.forEach(b => { h ^= b; h = Math.imul(h, 16777619) >>> 0; });
    return "f" + h.toString(16);
  }
  function randomSalt() {
    const a = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else a.forEach((x, i) => { a[i] = Math.floor(Math.random() * 256); });
    return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function shouldLock() {
    if (!L.pin || !(L.pin.after >= 0)) return false;
    const seen = Number(lsGet("seenAt", 0)) || 0;
    return Date.now() - seen >= Math.max(L.pin.after, 10000);
  }
  function openLock(mode, fromSetup) {
    L.open = true; L.mode = mode; L.entry = ""; L.first = ""; L.msg = ""; L.bad = false; L.shake = false; L.fromSetup = !!fromSetup;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderLock();
  }
  function closeLock() {
    L.open = false; L.entry = ""; L.first = ""; L.msg = ""; L.bad = false; L.mode = "unlock"; L.fromSetup = false;
    lsSet("seenAt", Date.now());
    renderLock();
    render();
  }
  function renderLock() {
    const el = $("#lock");
    el.hidden = !L.open;
    document.body.classList.toggle("locked", L.open);
    if (!L.open) { el.innerHTML = ""; return; }
    const mark = esc((D.config && D.config.mark) || "PT");
    if (L.mode === "forgot") {
      el.innerHTML = `<div class="lock-card">
        <div class="brand-mark lg" aria-hidden="true">${mark}</div>
        <h2>Forgot your PIN?</h2>
        <p class="lock-sub">Type this phone's setup code to pick a new PIN.</p>
        <form class="editor" data-form="forgot" autocomplete="off">
          <label for="forgotCode">Setup code<input id="forgotCode" name="code" class="code-input" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
          <p class="warn" id="forgotWarn" hidden></p>
          <div class="row-actions"><button class="btn primary wide" type="submit">Pick a new PIN</button></div>
        </form>
        <div class="lock-links"><button type="button" class="link" data-pin-act="back">Back</button></div>
      </div>`;
      const i = $("#forgotCode"); if (i) i.focus();
      return;
    }
    const title = { unlock: "Enter your PIN", change: "Enter your current PIN", new: "Pick a 4-digit PIN", confirm: "Type it again" }[L.mode] || "Enter your PIN";
    const sub = L.msg || (L.mode === "new" ? "You'll type it to open the app on this phone." : L.mode === "confirm" ? "Same 4 digits, to make sure." : "");
    const cool = L.until > Date.now();
    let links = "";
    if (L.mode === "unlock") links = `<button type="button" class="link" data-pin-act="forgot">Forgot PIN?</button>`;
    else if (L.fromSetup) links = `<button type="button" class="link" data-pin-act="skip">Skip, no PIN on this phone</button>`;
    else links = `<button type="button" class="link" data-pin-act="cancel">Cancel</button>`;
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(n => `<button type="button" data-pin="${n}"${cool ? " disabled" : ""}>${n}</button>`).join("");
    el.innerHTML = `<div class="lock-card">
      <div class="brand-mark lg" aria-hidden="true">${mark}</div>
      <h2>${esc(title)}</h2>
      <p class="lock-sub${L.bad ? " bad" : ""}" aria-live="polite">${esc(sub)}</p>
      <div class="pin-dots${L.shake ? " shake" : ""}" role="img" aria-label="${L.entry.length} of 4 digits">${[0, 1, 2, 3].map(i => `<span class="${i < L.entry.length ? "on" : ""}"></span>`).join("")}</div>
      <div class="pad">${keys}<button type="button" class="blank" tabindex="-1" aria-hidden="true"></button><button type="button" data-pin="0"${cool ? " disabled" : ""}>0</button><button type="button" class="del" data-pin="del" aria-label="Delete a digit">Delete</button></div>
      <div class="lock-links">${links}</div>
    </div>`;
    L.shake = false;
  }
  async function pinKey(k) {
    if (L.until > Date.now() || L.busy) return;
    if (k === "del") { L.entry = L.entry.slice(0, -1); if (L.bad) { L.bad = false; L.msg = ""; } return renderLock(); }
    if (L.entry.length >= 4) return;
    L.entry += k;
    if (L.bad) { L.bad = false; L.msg = ""; }
    renderLock();
    if (L.entry.length < 4) return;
    const entry = L.entry;
    L.busy = true;
    try {
      if (L.mode === "unlock" || L.mode === "change") {
        const ok = !!L.pin && (await pinHash(L.pin.salt, entry)) === L.pin.hash;
        if (ok) {
          L.fails = 0;
          if (L.mode === "change") { L.mode = "new"; L.entry = ""; L.msg = "Now pick the new one."; return renderLock(); }
          return closeLock();
        }
        L.fails++;
        L.entry = ""; L.bad = true; L.shake = true;
        if (L.fails >= 5) {
          L.until = Date.now() + 30000;
          L.msg = "Too many tries. Wait 30 seconds.";
          setTimeout(() => { L.fails = 3; L.msg = ""; L.bad = false; renderLock(); }, 30000);
        } else L.msg = "That's not it. Try again.";
        return renderLock();
      }
      if (L.mode === "new") { L.first = entry; L.mode = "confirm"; L.entry = ""; L.msg = ""; return renderLock(); }
      if (L.mode === "confirm") {
        if (entry !== L.first) { L.mode = "new"; L.entry = ""; L.first = ""; L.bad = true; L.shake = true; L.msg = "Those didn't match. Pick it again."; return renderLock(); }
        const salt = randomSalt();
        const pin = { salt, hash: await pinHash(salt, entry), after: L.pin && L.pin.after !== undefined ? L.pin.after : 15 * 60000 };
        try { await M.set("pin", pin); } catch (e) { L.msg = "Couldn't save the PIN on this phone."; L.bad = true; L.mode = "new"; L.entry = ""; return renderLock(); }
        L.pin = pin;
        closeLock();
        toast("PIN saved. The app asks for it after you've been away 15 minutes. You can change that under the person button.");
      }
    } finally { L.busy = false; }
  }
  function forgotPin(form) {
    const code = normKey(form.elements.code.value);
    if (!D.setup || code !== normKey(D.setup.key)) return showWarn(form, "forgotWarn", "That's not this phone's setup code.");
    L.mode = "new"; L.entry = ""; L.first = ""; L.msg = "Pick your new PIN."; L.bad = false;
    renderLock();
  }

  // ---------------------------------------------------------------- render
  const TAB_IDS = ["parts", "machines", "order", "history"];
  function render(fromSync) {
    const ready = S.phase === "app";
    $("#signin").hidden = ready || S.phase === "boot";
    $("#layout").hidden = !ready;
    $("#tabs").hidden = !ready;
    $("#meBtn").hidden = !ready;
    renderHeader();
    if (!ready) { if (S.phase === "setup") renderSignin(); return; }
    TAB_IDS.forEach(t => $("#tab-" + t).setAttribute("aria-selected", String(S.tab === t)));
    $("#meBtn").setAttribute("aria-pressed", String(S.tab === "me"));
    TABS.forEach(t => { $("#view-" + t).hidden = S.tab !== t; });
    if (S.tab === "parts") renderParts();
    if (S.tab === "machines") renderMachines();
    if (S.tab === "order") renderOrder();
    if (S.tab === "history") renderHistory();
    if (S.tab === "me" && !(fromSync && typingInMe())) renderMe();
    if (fromSync && S.editing) { S.detailStale = true; return; }
    renderDetail();
  }

  function renderHeader() {
    const line = $("#subline");
    let text, warn = false;
    const waiting = D.outbox.length;
    const off = isOffline();
    const ups = k => k + " update" + (k === 1 ? "" : "s");
    if (S.phase === "boot") text = "Loading…";
    else if (S.phase === "setup") text = "Set up this phone";
    else if (!D.loaded) text = "Loading parts…";
    else if (S.keyBad) { text = "Sync paused, setup code changed"; warn = true; }
    else if (waiting && off) { text = "No signal, " + ups(waiting) + " will send"; warn = true; }
    else if (waiting) text = "Sending " + ups(waiting) + "…";
    else if (off) text = "No signal, all saved on this phone";
    else {
      text = plural(activeParts().length, "part");
      if (D.lastOk) text += ", synced " + shortTime(D.lastOk);
    }
    line.textContent = text;
    line.classList.toggle("warn", warn);
    $("#meName").textContent = firstName(S.me.name) || "Me";
    if (S.phase !== "app") return;
    const low = lowParts();
    const oc = $("#orderCount");
    oc.hidden = !low.length;
    oc.textContent = String(low.length);
    oc.classList.toggle("hot", low.some(p => stockOf(p).st === "out"));
  }

  function installSteps() {
    const ios = isIOS(), android = isAndroid();
    const iosSteps = `<div><div class="os">iPhone</div><ol><li>Open this page in <b>Safari</b>.</li><li>Tap the Share button ${SHARE_SVG}, then <b>Add to Home Screen</b>.</li><li>Open <b>Parts</b> from your home screen and set it up there.</li></ol></div>`;
    const andSteps = `<div><div class="os">Android</div><ol><li>In <b>Chrome</b>, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li><li>Open <b>Parts</b> from your home screen.</li></ol></div>`;
    return `<div class="install-steps">${ios ? iosSteps : android ? andSteps : iosSteps + andSteps}</div>`;
  }

  function renderSignin() {
    const el = $("#signin");
    if (el.querySelector("form[data-form='setup']") && el.dataset.v === String(!!S.installEvt)) return;   // keep what they're typing
    el.dataset.v = String(!!S.installEvt);
    const ios = isIOS(), app = standalone();
    let html = `<div class="card signin-card setup-card">
      <div class="brand-mark lg" aria-hidden="true">PT</div>
      <h2>Set up this phone</h2>`;
    if (S.storageError) html += `<p class="signin-msg">This browser won't let the app save anything (private browsing does that). Open it in a regular window.</p>`;
    if (!app && ios) {
      html += `<div class="card card-pad tip"><p><b>First, put it on your home screen.</b> On iPhone the home screen app keeps its own copy of everything, so set it up from there, not here in Safari.</p></div>${installSteps()}
        <p class="muted small">Already on your home screen? Open it from there. Setting up a laptop or iPad instead? Go ahead below.</p>`;
    } else if (!app) {
      html += `<p class="muted">Put it on your home screen so it opens like an app.${S.installEvt ? "" : " " + (isAndroid() ? "In Chrome, tap ⋮, then <b>Add to Home screen</b>." : "")}</p>`;
      if (S.installEvt) html += `<div class="row-actions"><button class="btn" type="button" data-action="install">Add to home screen</button></div>`;
    }
    html += `<p>Type the setup code you were given. It's the same code as the Machine List app. You only do this once on each phone, and it needs signal to download the parts list.</p>
      <form class="editor" data-form="setup" autocomplete="off">
        <label for="setupCode">Setup code<input id="setupCode" name="code" class="code-input" type="text" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
        <p class="warn" id="setupWarn" hidden></p>
        <div class="row-actions"><button class="btn primary wide" type="submit">Connect</button></div>
      </form>
      ${CFG.syncUrl ? "" : `<p class="warn-text">This copy of the app isn't linked to your sheet yet.</p>`}
      <p class="muted small">After this, the app works with no signal. What you do goes to your sheet by itself once you have service.</p>
    </div>`;
    el.innerHTML = html;
  }

  // Notes at the top of a list: a new version of the app, or sync paused.
  function noticeCards() {
    let html = "";
    if (S.update) html += `<div class="card card-pad notice upd"><p><b>A new version of the app is ready.</b> Reload to use it. Nothing you saved is lost.</p><button class="btn small primary" type="button" data-action="reload-app">Reload</button></div>`;
    if (S.keyBad) html += `<div class="card card-pad notice paused"><p><b>Sync is paused.</b> This phone's setup code was changed or turned off. Everything's still saved on this phone.</p><button class="btn small" type="button" data-tab="me">Fix it</button></div>`;
    return html;
  }
  function tipCard() {
    if (S.tipClosed || standalone() || lsGet("tipDone", false)) return "";
    const how = isIOS() ? "In Safari, tap Share, then <b>Add to Home Screen</b>. The home screen app keeps its own copy, so you'll type the setup code there once."
      : isAndroid() ? "In Chrome, tap ⋮, then <b>Add to Home screen</b>."
      : "iPhone: tap Share, then <b>Add to Home Screen</b>. Android: tap ⋮, then <b>Add to Home screen</b>.";
    return `<div class="card card-pad tip"><p><b>Put this on your home screen</b> so it opens like an app, even with no signal. ${S.installEvt ? "" : how}${S.installEvt ? ` <button class="btn small primary" type="button" data-action="install" style="margin-top:8px">Add to home screen</button>` : ""}</p><button class="btn small quiet" type="button" data-action="tip-close" aria-label="Hide this tip">✕</button></div>`;
  }

  // ---------------------------------------------------------------- the parts tag: how many are on hand
  function tagHtml(p, big) {
    const s = stockOf(p), on = p.on;
    const num = s.st === "none" && (on === null || on === undefined || on <= 0) ? "?" : fmtQty(Math.max(0, on));
    const word = big ? { none: "not counted", out: "out", low: "low", ok: "on hand" }[s.st] : { none: "count", out: "out", low: "low", ok: "" }[s.st];
    return `<span class="tag ${s.st}${big ? " big" : ""}${p.stale ? " stale" : ""}" aria-hidden="true"><b>${esc(num)}</b>${word ? `<small>${word}</small>` : ""}</span>`;
  }
  function fitsShort(p) {
    const f = p.fits || [];
    if (!f.length) return "";
    const names = f.slice(0, 3).map(id => machName(id) || id);
    return "Fits " + names.join(", ") + (f.length > 3 ? ` and ${f.length - 3} more` : "");
  }
  function partAria(p) {
    const s = stockOf(p);
    return `${partTitle(p)}, ${partWhat(p)}. ${p.on === null || p.on === undefined ? "Not counted" : fmtQty(Math.max(0, p.on)) + " on hand"}${s.st === "low" || s.st === "out" ? ", " + s.label.toLowerCase() : ""}.`;
  }
  function binMain(p, extra) {
    const fits = [fitsShort(p), p.where].filter(Boolean).join(" · ");
    return `<span class="bin-pn${p.pn ? "" : " word"}">${esc(partTitle(p))}</span>
      <span class="bin-what">${esc(partWhat(p))}</span>${fits && !(extra && extra.noFits) ? `<span class="bin-fits">${esc(fits)}</span>` : ""}`;
  }
  // A part on a list, as a bin label: the part number and what it is, and its tag.
  function binRow(p) {
    return `<button class="bin" type="button" data-open="${esc(p.id)}"${S.openId === p.id ? ' aria-current="true"' : ""} aria-label="${esc(partAria(p))}">
      <span class="bin-main">${binMain(p)}</span>${tagHtml(p)}
    </button>`;
  }

  // ---------------------------------------------------------------- parts
  function haystack(p) {
    return [p.pn, p.alt, p.desc, p.type, p.where, p.notes, groupName(groupOf(p.type))].concat((p.fits || []).map(id => id + " " + machName(id))).join(" ").toLowerCase();
  }
  function matches(p, terms) {
    if (!terms.length) return true;
    const hay = haystack(p), nums = normKey((p.pn || "") + " " + (p.alt || ""));
    return terms.every(t => hay.includes(t) || (normKey(t).length >= 3 && nums.includes(normKey(t))));
  }
  // A search that is exactly a machine (its ID or its name, like EX-08 or 306) lists the parts for that machine.
  function machineFor(q) {
    const t = String(q || "").trim().toLowerCase();
    if (!t) return null;
    const n = normKey(t);
    return S.machines.find(m => normKey(m.id) === n) || S.machines.find(m => String(m.name).toLowerCase() === t) || null;
  }
  function renderParts() {
    const body = $("#partsBody");
    if (!S.loaded) { body.innerHTML = `<div class="card empty"><h3>Loading parts</h3></div>`; return; }
    const all = activeParts();
    const n = k => all.filter(p => stockOf(p).st === k).length;
    const chips = [["all", "All", all.length], ["out", "Out", n("out")], ["low", "Low", n("low")], ["none", "Not counted", n("none")]];
    if (!chips.some(c => c[0] === S.st)) S.st = "all";
    $("#stChips").innerHTML = chips.map(([k, l, c]) => `<button class="chip ${k}" type="button" data-st="${k}" aria-pressed="${S.st === k}">${k === "out" || k === "low" ? '<span class="dot" aria-hidden="true"></span>' : ""}${l} <span class="n">${c}</span></button>`).join("");
    const mach = machineFor(S.q);
    S.forMachine = mach ? mach.id : null;
    const terms = mach ? [] : S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = sortParts(all.filter(p => (S.st === "all" || stockOf(p).st === S.st) && (mach ? (p.fits || []).includes(mach.id) : matches(p, terms))));
    let html = noticeCards() + tipCard() + countTip(all);
    const countFirst = n("none") > 0;   // while there are parts nobody has counted, counting is the main job
    html += `<div class="quick">
      <button class="btn${countFirst ? " primary" : ""}" type="button" data-action="count-start"${all.length ? "" : " disabled"}>Count the shelf</button>
      <button class="btn${countFirst ? "" : " primary"}" type="button" data-action="add"${mach ? ` data-for="${esc(mach.id)}"` : ""}>Add a part</button>
    </div>`;
    if (mach) {
      html += `<button class="bin mach-hit" type="button" data-open="m:${esc(mach.id)}"><span class="bin-main"><span class="bin-pn word">${esc(mach.name)}</span>
        <span class="bin-what"><span class="idchip">${esc(mach.id)}</span> ${esc(mach.cat)}</span><span class="bin-fits">Open its page to log parts for it</span></span></button>`;
    }
    if (!all.length) html += `<div class="card empty"><h3>No parts yet</h3><p>Add the filters, teeth and service parts you keep on hand.</p></div>`;
    else if (!rows.length) html += `<div class="card empty"><h3>Nothing here</h3><p>${mach ? `No parts on the list say they fit the ${esc(mach.name)} yet.` : "Nothing fits that search and filter."}</p>
      ${mach ? "" : `<button class="btn" type="button" data-action="clear-filters">Clear the search</button>`}</div>`;
    else {
      const section = (title, list) => `<div class="sec-h"><h2>${esc(title)}</h2><span>${list.length}</span></div><div class="bins">${list.map(binRow).join("")}</div>`;
      if (mach) html += section("Fits the " + mach.name, rows);
      else GROUPS.forEach(([k, l]) => { const g = rows.filter(p => groupOf(p.type) === k); if (g.length) html += section(l, g); });
    }
    body.innerHTML = html;
  }
  function countTip(all) {
    const none = all.filter(p => stockOf(p).st === "none").length;
    if (!none || lsGet("countTipDone", false) || S.st !== "all" || S.q) return "";
    return `<div class="card card-pad tip"><p><b>${plural(none, "part")} ${none === 1 ? "isn't" : "aren't"} counted yet.</b> Tap <b>Count the shelf</b> and go down the list. After that, every one taken or brought in changes the number.</p><button class="btn small quiet" type="button" data-action="count-tip-close" aria-label="Hide this tip">✕</button></div>`;
  }

  // ---------------------------------------------------------------- machines
  function machStats(id) {
    const list = partsFor(id);
    return { n: list.length, out: list.filter(p => stockOf(p).st === "out").length, low: list.filter(p => stockOf(p).st === "low").length };
  }
  function renderMachines() {
    const body = $("#machBody");
    if (!S.loaded) { body.innerHTML = `<div class="card empty"><h3>Loading machines</h3></div>`; return; }
    const q = S.mq.trim().toLowerCase();
    const list = S.machines.filter(m => !q || (m.id + " " + m.name + " " + m.cat).toLowerCase().includes(q) || normKey(m.id).includes(normKey(q)));
    if (!S.machines.length) { body.innerHTML = `<div class="card empty"><h3>No machines</h3><p>Your sheet's Machines tab is empty.</p></div>`; return; }
    if (!list.length) { body.innerHTML = `<div class="card empty"><h3>No machine by that name</h3><p>Try its number, like 306, or its ID, like EX-08.</p></div>`; return; }
    const cats = [];
    list.forEach(m => { let c = cats.find(x => x.cat === m.cat); if (!c) { c = { cat: m.cat || "Other", list: [] }; cats.push(c); } c.list.push(m); });
    let html = noticeCards();
    if (!q) html += `<p class="muted small" style="padding:0 4px">Pick a machine to see what it takes and log parts for it.</p>`;
    cats.forEach(c => {
      html += `<div class="sec-h"><h2>${esc(c.cat)}</h2><span>${c.list.length}</span></div><div class="mach-grid">${c.list.map(m => {
        const s = machStats(m.id);
        const line = !s.n ? "No parts yet" : [plural(s.n, "part"), s.out ? `<b>${s.out} out</b>` : "", s.low ? `<b>${s.low} low</b>` : ""].filter(Boolean).join(", ");
        const cls = "mach" + (s.out ? " has-out" : s.low ? " has-low" : "") + (s.n ? "" : " none");
        return `<button class="${cls}" type="button" data-open="m:${esc(m.id)}"${S.openId === "m:" + m.id ? ' aria-current="true"' : ""}><span class="mn">${esc(m.name)}</span><span class="mid">${esc(m.id)}</span><span class="ms">${line}</span></button>`;
      }).join("")}</div>`;
    });
    body.innerHTML = html;
  }
  function machinePage(m) {
    const list = partsFor(m.id);
    const have = new Set(list.map(p => p.type));
    const slots = slotsFor(m);
    const missing = slots.filter(t => !have.has(t));
    let html = `<div class="d-head">
      <button class="btn quiet back" type="button" data-action="close">← Back</button>
      <div class="d-title"><div class="d-type"><span class="idchip">${esc(m.id)}</span> ${esc(m.cat)}</div><h2 class="word">${esc(m.name)}</h2></div>
    </div>`;
    if (list.length) {
      html += `<div class="sec-h"><h2>Parts it takes</h2><span>${list.length}</span></div><div class="bins mach-parts">${list.map(p => `<div class="bin">
        <button class="bin-main as-btn" type="button" data-open="${esc(p.id)}" aria-label="${esc(partAria(p))}">${binMain(p, { noFits: true })}${p.where ? `<span class="bin-fits">${esc(p.where)}</span>` : ""}</button>
        ${tagHtml(p)}
        ${p.removed || S.keyBad ? "" : `<button class="btn small primary took1" type="button" data-action="took1" data-id="${esc(p.id)}" aria-label="Took 1 ${esc(partTitle(p))} for the ${esc(m.name)}">Took 1</button>`}
      </div>`).join("")}</div>`;
    } else {
      html += `<div class="card empty"><h3>No parts listed for it yet</h3><p>Add the filters and parts the ${esc(m.name)} takes. Then you can log them here with one tap.</p></div>`;
    }
    if (!S.keyBad) {
      html += `<div class="card card-pad adds"><p>${list.length ? "Add another part it takes" : "Add a part it takes"}</p><div class="chips">${missing.map(t =>
        `<button class="chip" type="button" data-action="add" data-for="${esc(m.id)}" data-type="${esc(t)}">+ ${esc(t)}</button>`).join("")}<button class="chip" type="button" data-action="add" data-for="${esc(m.id)}">+ Something else</button></div></div>`;
    }
    return html;
  }

  // ---------------------------------------------------------------- order: what's out or low
  function orderText() {
    const lines = lowParts().map(p => {
      const left = Math.max(0, Number(p.on) || 0);
      const fits = (p.fits || []).map(id => machName(id) || id);
      return "- " + [p.type, p.pn].filter(Boolean).join(" ") + (p.pn ? (p.desc && normKey(p.desc) !== normKey(p.type) ? " (" + p.desc + ")" : "") : (p.desc ? " " + p.desc : "")) +
        ": " + (left ? fmtQty(left) + " left" : "none left") + (p.min !== null && p.min !== undefined ? ", keep " + fmtQty(p.min) : "") +
        (fits.length ? " - fits " + fits.join(", ") : "");
    });
    return "Parts to order - " + usDate(new Date()) + "\n" + lines.join("\n");
  }
  function orderRow(p) {
    return `<div class="bin">
      <button class="bin-main as-btn" type="button" data-open="${esc(p.id)}" aria-label="${esc(partAria(p))}">${binMain(p)}${p.min !== null && p.min !== undefined ? `<span class="bin-fits">Keep at least ${esc(fmtQty(p.min))}</span>` : ""}</button>
      ${tagHtml(p)}
      ${S.keyBad ? "" : `<button class="btn small" type="button" data-action="get-for" data-id="${esc(p.id)}">Got some in</button>`}
    </div>`;
  }
  function renderOrder() {
    const el = $("#view-order");
    if (!S.loaded) { el.innerHTML = `<div class="card empty"><h3>Loading parts</h3></div>`; return; }
    const low = lowParts(), out = low.filter(p => stockOf(p).st === "out"), some = low.filter(p => stockOf(p).st === "low");
    const none = sortParts(activeParts().filter(p => stockOf(p).st === "none"));
    let html = noticeCards() + `<div class="card card-pad intro">
      <p>Parts that are out, or down to the number you keep on hand. Set <b>Keep at least</b> on a part so it shows up here before it runs out.</p>
      ${low.length ? `<div class="row-actions"><button class="btn primary" type="button" data-action="share-order">${SHARE_SVG} Send the order list</button></div>` : ""}
      ${S.shareText ? `<label class="share-box" for="shareText">Copy this list<textarea id="shareText" rows="${Math.min(10, low.length + 2)}" readonly>${esc(S.shareText)}</textarea></label>` : ""}
    </div>`;
    const section = (title, list) => !list.length ? "" : `<div class="sec-h"><h2>${esc(title)}</h2><span>${list.length}</span></div><div class="bins mach-parts">${list.map(orderRow).join("")}</div>`;
    if (!low.length) html += `<div class="card empty"><h3>Nothing to order</h3><p>${none.length ? "Nothing counted is low. Parts that aren't counted yet can't show up here." : "Everything is above the number you keep on hand."}</p></div>`;
    html += section("Out", out) + section("Low", some);
    if (none.length) html += `<details class="card card-pad none-list"><summary>Not counted yet (${none.length})</summary><p class="muted small">Count these so this list knows about them.</p><div class="bins">${none.map(binRow).join("")}</div></details>`;
    el.innerHTML = html;
  }
  async function shareOrder() {
    const text = orderText();
    if (navigator.share) {
      try { await navigator.share({ title: "Parts to order", text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied the order list. Paste it in a text or an email.");
      return;
    } catch (e) { /* show it to copy by hand */ }
    S.shareText = text;
    renderOrder();
    const t = $("#shareText"); if (t) { t.focus(); t.select(); }
  }

  // ---------------------------------------------------------------- history
  const H_FILTERS = [["all", "All"], ["use", "Took"], ["get", "Got in"], ["count", "Counted"], ["change", "Changes"]];
  function hKind(m) { return m.kind === "use" || m.kind === "get" || m.kind === "count" ? m.kind : "change"; }
  function moveVerb(m) {
    const who = whoName(m.by), q = fmtQty(m.qty);
    switch (m.kind) {
      case "use": return `${who} took ${q}`;
      case "get": return `${who} got ${q} in`;
      case "count": return `${who} counted ${q}`;
      case "add": return `${who} added it${m.qty !== null && m.qty !== undefined ? `, ${q} on hand` : ""}`;
      case "remove": return `${who} took it off the list`;
      case "restore": return `${who} put it back on the list`;
      case "edit": return `${who} changed ${FIELD_WORDS[m.field] || "it"}`;
      default: return `${who}: ${m.what || "changed it"}`;
    }
  }
  const canUndo = m => !S.keyBad && (S.me.isOwner || m.by === S.me.name);
  function moveItem(m, opts) {
    const p = S.parts.get(m.part);
    const name = p ? partTitle(p) : (m.partName || m.part);
    const forUnit = m.kind === "use" ? (m.unit ? "for " + machLabel(m.unit) : "no machine") : "";
    const bits = [forUnit, whenText(m.at), m.note].filter(Boolean);
    if (m.after !== null && m.after !== undefined && !m.undone && !m.pending) bits.push(fmtQty(Math.max(0, m.after)) + (m.kind === "use" ? " left" : " on hand"));
    if (m.pending || m.pendingUndo) bits.push(isOffline() ? "saved on this phone, will send" : "sending…");
    const diff = m.kind === "edit" ? `<div class="diff"><span class="from">${esc(m.from || "empty")}</span><span aria-label="changed to">→</span><span class="to">${esc(m.to || "cleared")}</span></div>` : "";
    let acts = "";
    if (canUndo(m)) acts = m.undone ? `<button class="btn small" type="button" data-action="redo" data-id="${esc(m.id)}">Put back</button>`
      : `<button class="btn small" type="button" data-action="undo" data-id="${esc(m.id)}">Undo</button>`;
    const badge = m.kind === "use" ? `<span class="mv-q minus">−${esc(fmtQty(m.qty))}</span>` : m.kind === "get" ? `<span class="mv-q plus">+${esc(fmtQty(m.qty))}</span>`
      : m.kind === "count" ? `<span class="mv-q set">=${esc(fmtQty(m.qty))}</span>` : "";
    return `<div class="mv${m.undone ? " undone" : ""}">
      <div class="mv-top"><span class="mv-what">${esc(moveVerb(m))}</span>${badge}</div>
      ${opts && opts.inPart ? "" : `<div class="mv-part"><button class="link" type="button" data-open="${esc(m.part)}">${esc(name)}</button>${p ? ` <span class="muted">${esc(partWhat(p))}</span>` : ""}</div>`}
      ${diff}
      <div class="mv-foot"><div class="mv-meta">${esc(bits.join(", "))}${m.undone ? `<span class="mv-undone">Undone ${esc(whenText(m.undone))} by ${esc(whoIn(m.undoneBy))}</span>` : ""}</div>${acts}</div>
    </div>`;
  }
  function renderHistory() {
    const el = $("#view-history");
    if (!S.loaded) { el.innerHTML = `<div class="card empty"><h3>Loading history</h3></div>`; return; }
    let list = S.moves;
    if (S.hPart) list = list.filter(m => m.part === S.hPart);
    const n = k => (k === "all" ? list.length : list.filter(m => hKind(m) === k).length);
    const shown = S.hFilter === "all" ? list : list.filter(m => hKind(m) === S.hFilter);
    const p = S.hPart ? S.parts.get(S.hPart) : null;
    let html = noticeCards();
    if (S.hPart) html += `<div class="card card-pad notice"><p>Just <b>${esc(p ? partTitle(p) : S.hPart)}</b>${p ? ", " + esc(partWhat(p)) : ""}.</p><button class="btn small" type="button" data-action="hist-all">Show everything</button></div>`;
    else html += `<p class="muted small" style="padding:0 4px">Everything taken, brought in, counted or changed, newest first. ${S.me.isOwner ? "You can undo any of it." : "You can undo your own."}</p>`;
    html += `<div class="chips" role="group" aria-label="Show part of the history">${H_FILTERS.map(([k, l]) =>
      `<button class="chip" type="button" data-hf="${k}" aria-pressed="${S.hFilter === k}">${l} <span class="n">${n(k)}</span></button>`).join("")}</div>`;
    if (!shown.length) html += `<div class="card empty"><h3>Nothing yet</h3><p>When someone takes a part, brings some in or counts them, it shows up here.</p></div>`;
    else {
      const limit = 150 + S.hMore;
      html += `<div class="mv-list">${shown.slice(0, limit).map(m => moveItem(m)).join("")}</div>`;
      if (shown.length > limit) html += `<div class="row-actions"><button class="btn wide" type="button" data-action="hist-more">Show more</button></div>`;
      if (D.movesTotal > D.moves.length && !S.hPart && shown.length <= limit) html += `<p class="muted small" style="padding:0 4px">Older moves are on the Moves tab of your sheet.</p>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- you: sync, app lock, backup
  function renderMe() {
    const el = $("#view-me");
    const waiting = D.outbox.length;
    const off = isOffline();
    const lockAfter = L.pin ? L.pin.after : null;
    let html = "";
    if (S.keyBad) {
      html += `<section class="card card-pad me-card">
        <h3>Sync is paused</h3>
        <p>This phone's setup code was changed or turned off, so it can't sync until you type the new one. Everything's still saved here${waiting ? `, including ${waiting} update${waiting === 1 ? "" : "s"} waiting to send` : ""}.</p>
        <form class="editor" data-form="newkey" autocomplete="off">
          <label for="newKey">New setup code<input id="newKey" name="code" class="code-input" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>
          <p class="warn" id="newKeyWarn" hidden></p>
          <div class="row-actions"><button class="btn primary" type="submit">Save and sync</button></div>
        </form>
      </section>`;
    }
    const all = activeParts();
    html += `<section class="card card-pad me-card">
      <h3>On this phone</h3>
      <div class="me-name">${esc(S.me.name || "Me")}<span class="role">${S.me.isOwner ? "Owner" : "Crew"}</span></div>
      <p>Everything is saved right here, so the app works with no signal. What you do goes to your sheet by itself when you have service.</p>
      <dl class="sync-lines">
        <div><dt>Waiting to send</dt><dd class="${waiting ? "wait" : "ok"}">${waiting ? waiting + " update" + (waiting === 1 ? "" : "s") : "Nothing, all sent"}</dd></div>
        <div><dt>Last synced</dt><dd>${D.lastOk ? esc(shortTime(D.lastOk)) : "Not yet"}</dd></div>
        <div><dt>Signal</dt><dd>${D.busy ? "Syncing…" : off ? "None right now" : "Connected"}</dd></div>
        <div><dt>Saved here</dt><dd>${plural(all.length, "part")}, ${lowParts().length} to order</dd></div>
      </dl>
      <div class="row-actions"><button class="btn primary" type="button" data-action="sync-now"${S.keyBad ? " disabled" : ""}>Sync now</button>${D.sheetUrl ? `<a class="btn" href="${esc(D.sheetUrl)}" target="_blank" rel="noopener">Open my sheet</a>` : ""}</div>
      ${standalone() ? "" : `<details class="howto"><summary>Put the app on your home screen</summary>${installSteps()}${S.installEvt ? `<div class="row-actions" style="margin-top:8px"><button class="btn" type="button" data-action="install">Add to home screen</button></div>` : ""}</details>`}
    </section>
    <section class="card card-pad me-card">
      <h3>App lock</h3>
      ${L.pin ? `<label class="field" for="lockAfter">Ask for my PIN<select id="lockAfter">${LOCK_CHOICES.map(([ms, label]) => `<option value="${ms}"${ms === lockAfter ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <div class="row-actions"><button class="btn" type="button" data-action="pin-change">Change PIN</button>${lockAfter >= 0 ? `<button class="btn quiet" type="button" data-action="lock-now">Lock now</button>` : ""}</div>`
        : `<p>No PIN on this phone. Anyone who picks up your unlocked phone can open the app.</p><div class="row-actions"><button class="btn primary" type="button" data-action="pin-set">Set a PIN</button></div>`}
    </section>
    <section class="card card-pad me-card">
      <h3>Backup</h3>
      <p>Your sheet is the backup, and it fills in by itself. You can also save a file of everything on this phone, including anything that hasn't sent yet.</p>
      <div class="row-actions"><button class="btn" type="button" data-action="backup">Save a backup file</button>
        <button class="btn quiet${S.confirmReset ? " danger" : ""}" type="button" data-action="reset">${S.confirmReset ? (waiting ? `${waiting} update${waiting === 1 ? " hasn't" : "s haven't"} sent. Tap again to remove anyway` : "Tap again to remove") : "Remove from this phone"}</button></div>
      <p class="ver-line">Parts ${esc(VERSION)}. <button class="link" type="button" data-action="check-update">Check for an app update</button></p>
    </section>`;
    el.innerHTML = html;
  }
  function typingInMe() {
    const i = $("#newKey");
    return !!(i && (i.value || document.activeElement === i));
  }
  async function saveNewKey(form) {
    const code = normKey(form.elements.code.value);
    if (code.length !== 12) return showWarn(form, "newKeyWarn", "The setup code is 12 letters and numbers.");
    if (navigator.onLine === false) return showWarn(form, "newKeyWarn", "No signal. Try again when you have service.");
    setFormBusy(form, true);
    let res;
    try { res = await M.post(D.setup.url, { key: code, device: D.setup.device, app: VERSION, ver: D.ver, full: false, ops: [] }, 45000); }
    catch (e) { setFormBusy(form, false); return showWarn(form, "newKeyWarn", "Couldn't reach your sheet. Check your signal and try again."); }
    if (!res || !res.ok) { setFormBusy(form, false); return showWarn(form, "newKeyWarn", res && res.error === "bad_key" ? "That code doesn't work." : "Your sheet had a problem. Try again in a minute."); }
    D.setup = Object.assign({}, D.setup, { key: code });
    await M.set("setup", D.setup);
    S.keyBad = false;
    toast("Code saved. Syncing now.");
    render();
    sync({ full: true, user: true });
  }
  function downloadBackup() {
    const data = { app: "Parts", version: VERSION, savedAt: new Date().toISOString(), parts: [...S.parts.values()], moves: S.moves, machines: S.machines, waitingToSend: D.outbox };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "parts-backup-" + isoDate(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast("Backup saved.");
  }
  async function resetPhone() {
    if (!S.confirmReset) {
      S.confirmReset = true;
      renderMe();
      clearTimeout(S.resetTimer);
      S.resetTimer = setTimeout(() => { S.confirmReset = false; if (S.tab === "me") renderMe(); }, 8000);
      return;
    }
    try { await M.clearAll(); } catch (e) { /* reload anyway */ }
    ["seenAt", "tipDone", "countTipDone"].forEach(lsDel);
    location.reload();
  }

  // ---------------------------------------------------------------- the detail pane: a part, a machine, adding, counting
  function renderDetail() {
    const el = $("#detail");
    S.detailStale = false;
    const id = S.openId;
    let html = "";
    if (id === "new") html = addPage();
    else if (id === "count") html = countPage();
    else if (id && /^m:/.test(id) && S.machineById.has(id.slice(2))) html = machinePage(S.machineById.get(id.slice(2)));
    else if (id && S.parts.has(id)) html = partPage(S.parts.get(id));
    document.body.classList.toggle("detail-open", !!html);
    if (!html) {
      el.innerHTML = S.loaded && S.parts.size ? `<div class="card empty"><h3>Pick a part or a machine</h3><p>See how many are on hand, what fits what, and log what you take or bring in.</p></div>` : "";
      return;
    }
    el.innerHTML = html;
    if (S.editing && S.editing.focus) {
      const inp = el.querySelector(".editor input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=search]), .editor select, .editor textarea");
      if (inp) { inp.focus(); if (inp.select && inp.type === "text") inp.select(); }
      S.editing.focus = false;
    }
  }

  function partPage(p) {
    const s = stockOf(p);
    const facts = [];
    if (s.st === "none") facts.push(`<span class="big">Not counted yet</span><span>Tap Count to put in how many there are.</span>`);
    else {
      facts.push(`<span class="big">${s.st === "out" ? "Out" : s.st === "low" ? "Low, time to order" : "In stock"}</span>`);
      if (p.min !== null && p.min !== undefined) facts.push(`<span>Keep at least ${esc(fmtQty(p.min))}</span>`);
      facts.push(p.countedAt ? `<span>Counted ${esc(whenText(p.countedAt))} by ${esc(whoIn(p.countedBy))}</span>` : `<span>Not counted yet</span>`);
    }
    if (p.where) facts.push(`<span>Kept: ${esc(p.where)}</span>`);
    if (p.counted && p.on < 0) facts.push(`<span class="warn-text">More were taken than the count shows. Count them to fix it.</span>`);
    if (p.stale) facts.push(`<span>Updating once it's synced</span>`);
    const editing = S.editing && ["use", "get", "count"].includes(S.editing.type) ? S.editing.type : "";
    let html = `<div class="d-head">
      <button class="btn quiet back" type="button" data-action="close">← Back</button>
      <div class="d-title"><div class="d-type">${esc(p.type)}</div><h2${p.pn ? "" : ' class="word"'}>${esc(partTitle(p))}</h2>
        ${p.pn && p.desc && normKey(p.desc) !== normKey(p.type) ? `<p class="d-desc">${esc(p.desc)}</p>` : ""}
        ${p.pending ? `<p class="d-pending">${isOffline() ? "Saved on this phone, will send" : "Sending…"}</p>` : ""}</div>
    </div>`;
    if (p.removed) html += `<div class="card card-pad notice paused"><p><b>This part is off the list.</b> It doesn't show under Parts or Order.</p>${S.me.isOwner ? `<button class="btn small" type="button" data-action="restore">Put it back</button>` : ""}</div>`;
    html += `<section class="card card-pad onhand ${s.st}"><div class="onhand-top">${tagHtml(p, true)}<div class="onhand-facts">${facts.join("")}</div></div>`;
    if (!editing && !p.removed && !S.keyBad) html += `<div class="move-btns">
        <button class="btn primary" type="button" data-action="use">− Took some</button>
        <button class="btn" type="button" data-action="get">+ Got some in</button>
        <button class="btn" type="button" data-action="count">Count</button></div>`;
    if (editing === "use") html += useEditor(p);
    if (editing === "get") html += getEditor();
    if (editing === "count") html += countEditor(p);
    html += `</section>` + fitsCard(p) + detailsCard(p) + historyCard(p);
    if (S.me.isOwner && !p.removed) html += `<div class="row-actions remove-row"><button class="btn quiet${S.confirmRemove ? " danger" : ""}" type="button" data-action="remove">${S.confirmRemove ? "Tap again to take it off the list" : "Take this part off the list"}</button></div>`;
    return html;
  }
  function qtyRow(label, val, id) {
    return `<div class="qty-row"><label class="qty-label" for="${id || "ed-qty"}">${esc(label)}</label>
      <div class="qty"><button type="button" class="qbtn" data-action="qty" data-d="-1" aria-label="One less">−</button>
        <input id="${id || "ed-qty"}" name="qty" type="text" inputmode="decimal" autocomplete="off" value="${esc(val)}">
        <button type="button" class="qbtn" data-action="qty" data-d="1" aria-label="One more">+</button></div></div>`;
  }
  function machineOptions(selected, skip) {
    const cats = [];
    S.machines.forEach(m => { if (skip && skip.has(m.id)) return; let c = cats.find(x => x.cat === m.cat); if (!c) { c = { cat: m.cat || "Other", list: [] }; cats.push(c); } c.list.push(m); });
    return `<option value="">Pick one…</option>` + cats.map(c => `<optgroup label="${esc(c.cat)}">${c.list.map(m => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.name)} (${esc(m.id)})</option>`).join("")}</optgroup>`).join("");
  }
  function useEditor(p) {
    const fits = (p.fits || []).filter(id => S.machineById.has(id));
    const want = S.forMachine || (fits.length === 1 ? fits[0] : "");
    const inFits = want && fits.includes(want);
    return `<form class="editor" data-form="move" data-kind="use" autocomplete="off">
      ${qtyRow("How many did you take?", "1")}
      <fieldset class="picks"><legend>Which machine is it for?</legend>
        ${fits.map(id => `<label class="pick"><input type="radio" name="unit" value="${esc(id)}"${id === want ? " checked" : ""}><span><b>${esc(machName(id))}</b> <span class="mono muted">${esc(id)}</span></span></label>`).join("")}
        <label class="pick"><input type="radio" name="unit" value="__none"><span>No machine (spare, shop, other)</span></label>
      </fieldset>
      <label for="ed-other">${fits.length ? "Or another machine" : "Machine"}<select id="ed-other" name="other">${machineOptions(inFits ? "" : want, new Set(fits))}</select></label>
      <label for="ed-note">Note, if you want<input id="ed-note" name="note" type="text" placeholder="Like 500 hour service"></label>
      <p class="warn" id="moveWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  function getEditor() {
    return `<form class="editor" data-form="move" data-kind="get" autocomplete="off">
      ${qtyRow("How many came in?", "1")}
      <label for="ed-note">Where from, if you want<input id="ed-note" name="note" type="text" placeholder="Like Cat dealer"></label>
      <p class="warn" id="moveWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  function countEditor(p) {
    return `<form class="editor" data-form="move" data-kind="count" autocomplete="off">
      ${qtyRow("How many are there right now?", p.on !== null && p.on !== undefined && p.on >= 0 ? fmtQty(p.on) : "")}
      <p class="hint">A count sets the number. Do one whenever you check the shelf.</p>
      <p class="warn" id="moveWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save count</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  function fitsPicker(selected, opts) {
    const sel = new Set(selected || []);
    const cats = [];
    S.machines.forEach(m => { let c = cats.find(x => x.cat === m.cat); if (!c) { c = { cat: m.cat || "Other", list: [] }; cats.push(c); } c.list.push(m); });
    const extra = [...sel].filter(id => !S.machineById.has(id));
    return `<div class="fit-pick${opts && opts.inline ? " inline" : ""}">
      <input class="fit-q" type="search" placeholder="Find a machine, like 306" aria-label="Find a machine" data-role="fit-q" autocomplete="off">
      <div class="fit-box">
        ${extra.map(id => `<label class="pick"><input type="checkbox" name="fit" value="${esc(id)}" checked><span class="mono">${esc(id)}</span></label>`).join("")}
        ${cats.map(c => `<div class="fit-cat"><div class="fit-cat-h">${esc(c.cat)}</div>${c.list.map(m => `<label class="pick" data-hay="${esc((m.id + " " + m.name).toLowerCase())}"><input type="checkbox" name="fit" value="${esc(m.id)}"${sel.has(m.id) ? " checked" : ""}><span><b>${esc(m.name)}</b> <span class="mono muted">${esc(m.id)}</span></span></label>`).join("")}</div>`).join("")}
      </div>
    </div>`;
  }
  function fitsCard(p) {
    const editing = S.editing && S.editing.type === "fits";
    const list = p.fits || [];
    let html = `<section class="card card-pad fits-card">
      <div class="card-h"><h3>Fits these machines</h3>${!editing && !p.removed && !S.keyBad ? `<button class="btn small" type="button" data-action="fits-edit">${list.length ? "Change" : "Pick machines"}</button>` : ""}</div>`;
    if (editing) {
      html += `<form class="editor" data-form="fits">${fitsPicker(list)}
        <div class="row-actions sticky-acts"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div></form>`;
    } else if (list.length) {
      html += `<div class="fit-list">${list.map(id => `<button class="fit" type="button" data-open="m:${esc(id)}"${S.machineById.has(id) ? "" : " disabled"}><span class="idchip">${esc(id)}</span>${machName(id) ? `<span>${esc(machName(id))}</span>` : ""}</button>`).join("")}</div>`;
    } else html += `<p class="muted">No machines picked yet.</p>`;
    return html + `</section>`;
  }
  function detailsCard(p) {
    return `<section class="card details-card"><div class="card-h"><h3>Details</h3></div>${DETAIL_FIELDS.map(k => `<div class="f-row">${fieldCell(p, k)}</div>`).join("")}</section>`;
  }
  function fieldCell(p, k) {
    const label = `<div class="f-label">${esc(FIELD_LABEL[k])}</div>`;
    if (S.editing && S.editing.type === "field" && S.editing.key === k) return label + fieldEditor(p, k);
    const shown = fieldShown(p, k);
    const cls = `f-val${k === "pn" || k === "alt" ? " pn" : ""}${shown ? "" : " empty"}`;
    if (p.removed || S.keyBad) return label + `<div class="${cls} ro">${esc(shown || "None")}</div>`;
    return label + `<button class="${cls}" type="button" data-action="edit" data-key="${k}" aria-label="${esc(FIELD_LABEL[k])}: ${esc(shown || "empty")}. Change it">${esc(shown || "Add")}</button>`;
  }
  function wherePicks() {
    const counts = new Map();
    S.parts.forEach(x => { const w = String(x.where || "").trim(); if (w) counts.set(w, (counts.get(w) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]).slice(0, 12);
  }
  function fieldEditor(p, k) {
    const id = "ed-" + k;
    const val = fieldShown(p, k);
    let input;
    if (k === "type") {
      const opts = typesList();
      const all = val && !opts.includes(val) ? [val].concat(opts) : opts;
      input = `<select id="${id}" name="val" aria-label="${esc(FIELD_LABEL[k])}">${all.map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (k === "notes") input = `<textarea id="${id}" name="val" rows="3" aria-label="${esc(FIELD_LABEL[k])}">${esc(val)}</textarea>`;
    else if (k === "min") input = `<input id="${id}" name="val" type="text" inputmode="decimal" autocomplete="off" value="${esc(val)}" placeholder="Like 2" aria-label="${esc(FIELD_LABEL[k])}">`;
    else if (k === "where") input = `<input id="${id}" name="val" type="text" autocomplete="off" list="dl-where" value="${esc(val)}" placeholder="Like shop, shelf B" aria-label="${esc(FIELD_LABEL[k])}"><datalist id="dl-where">${wherePicks().map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist>`;
    else input = `<input id="${id}" name="val" type="text" autocomplete="off" value="${esc(val)}"${k === "pn" || k === "alt" ? ' autocapitalize="characters" spellcheck="false"' : ""} aria-label="${esc(FIELD_LABEL[k])}">`;
    const hint = k === "min" ? `<p class="hint">When it gets down to this many, it shows up on the Order list.</p>` : k === "alt" ? `<p class="hint">Cross-references or other brands' numbers, with commas between them.</p>` : "";
    return `<form class="editor" data-form="field" data-key="${k}">
      ${input}${hint}
      <p class="warn" id="fieldWarn" hidden></p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-action="cancel">Cancel</button></div>
    </form>`;
  }
  function historyCard(p) {
    const list = movesOf(p.id);
    return `<section class="card card-pad hist-card">
      <div class="card-h"><h3>History</h3>${list.length > 8 ? `<button class="btn small quiet" type="button" data-action="hist-part">See all</button>` : ""}</div>
      ${list.length ? `<div class="mv-list in-card">${list.slice(0, 8).map(m => moveItem(m, { inPart: true })).join("")}</div>` : `<p class="muted">Nothing yet.</p>`}
    </section>`;
  }

  function addPage() {
    const ed = S.editing || {};
    const fits = ed.addFor ? [ed.addFor] : [];
    const types = typesList();
    const forName = fits.length ? machName(fits[0]) : "";
    return `<div class="d-head">
      <button class="btn quiet back" type="button" data-action="close">← Back</button>
      <div class="d-title"><h2 class="word">Add a part</h2>${forName ? `<p class="d-desc">For the ${esc(forName)}. You can pick more machines below.</p>` : ""}</div>
    </div>
    <section class="card card-pad">
      <form class="editor add-form" data-form="add" autocomplete="off">
        <label for="add-type">Type<select id="add-type" name="type">${types.map(t => `<option${t === ed.addType ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
        <label for="add-pn">Part number<input id="add-pn" name="pn" type="text" autocapitalize="characters" spellcheck="false" placeholder="As printed on the part or the box"></label>
        <label for="add-desc">What it is<input id="add-desc" name="desc" type="text" placeholder="Like engine oil filter"></label>
        <div class="inputs">
          <label for="add-count">How many are there now?<input id="add-count" name="count" type="text" inputmode="decimal" placeholder="Blank if not counted"></label>
          <label for="add-min">Keep at least<input id="add-min" name="min" type="text" inputmode="decimal" placeholder="Like 2"></label>
        </div>
        <label for="add-where">Where it's kept<input id="add-where" name="where" type="text" list="dl-where-add" placeholder="Like shop, shelf B"><datalist id="dl-where-add">${wherePicks().map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist></label>
        <fieldset class="picks"><legend>Which machines does it fit?</legend>${fitsPicker(fits, { inline: true })}</fieldset>
        <label for="add-alt">Other part numbers, if you know them<input id="add-alt" name="alt" type="text" autocapitalize="characters" spellcheck="false" placeholder="Cross-references, other brands"></label>
        <label for="add-notes">Notes<textarea id="add-notes" name="notes" rows="2"></textarea></label>
        <p class="warn" id="addWarn" hidden></p>
        <div class="row-actions"><button class="btn primary" type="submit">Add part</button><button class="btn" type="button" data-action="close">Cancel</button></div>
      </form>
    </section>`;
  }

  // ---------------------------------------------------------------- counting the shelf, one part at a time
  // Goes by where things are kept, so you can walk the shelf, then by type. A count of the same number still counts:
  // it says someone checked.
  function countList() {
    return activeParts().sort((a, b) => {
      const wa = String(a.where || "").toLowerCase(), wb = String(b.where || "").toLowerCase();
      if (!wa !== !wb) return wa ? -1 : 1;
      return wa.localeCompare(wb) || typeRank(a.type) - typeRank(b.type) || partTitle(a).localeCompare(partTitle(b), undefined, { numeric: true });
    }).map(p => p.id);
  }
  function startCount() {
    const list = countList();
    if (!list.length || !canWrite()) return;
    S.count = { list, i: 0, saved: 0, skipped: 0 };
    if (!S.openId) S.listScroll = window.scrollY;
    S.openId = "count";
    S.editing = { type: "countmode", focus: true };
    navPush();
    render();
    window.scrollTo(0, 0);
    rootWatch();
  }
  function countPage() {
    const c = S.count;
    if (!c) return "";
    const total = c.list.length;
    if (c.i >= total) {
      return `<div class="count-top"><h2>Count the shelf</h2><button class="btn small" type="button" data-action="close">Done</button></div>
        <div class="bar" aria-hidden="true"><span style="width:100%"></span></div>
        <section class="card count-card count-done"><h2>${c.saved ? `Counted ${plural(c.saved, "part")}` : "Nothing counted"}</h2>
          <p class="muted">${c.skipped ? `${plural(c.skipped, "part")} skipped. ` : ""}Every count is in the history under your name.</p>
          <button class="btn primary" type="button" data-action="close">Back to the parts</button></section>`;
    }
    const p = S.parts.get(c.list[c.i]);
    if (!p) { c.i++; return countPage(); }
    const s = stockOf(p);
    const last = s.st === "none" ? "Never counted" : `Last count ${fmtQty(Math.max(0, p.on))}${p.countedAt ? `, ${whenText(p.countedAt)} by ${whoIn(p.countedBy)}` : ""}`;
    return `<div class="count-top"><div><h2>Count the shelf</h2><span class="of">${c.i + 1} of ${total}</span></div><button class="btn small" type="button" data-action="close">Done</button></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${c.i}" aria-label="Counted so far"><span style="width:${Math.round(c.i / total * 100)}%"></span></div>
      <section class="card count-card">
        <div class="cinfo">${p.where ? `<div class="where">${esc(p.where)}</div>` : ""}
          <div class="cpn${p.pn ? "" : " word"}">${esc(partTitle(p))}</div><div class="cwhat">${esc(partWhat(p))}</div>
          ${fitsShort(p) ? `<div class="clast">${esc(fitsShort(p))}</div>` : ""}<div class="clast">${esc(last)}</div></div>
        <form class="editor" data-form="countmode" autocomplete="off">
          ${qtyRow("How many are there?", s.st === "none" ? "" : fmtQty(Math.max(0, p.on)), "cm-qty")}
          <p class="warn" id="moveWarn" hidden></p>
          <button class="btn primary wide" type="submit">${c.i + 1 < total ? "Save and go to the next one" : "Save, that's the last one"}</button>
          <div class="row-actions"><button class="btn" type="button" data-action="count-skip">Skip this one</button>${c.i ? `<button class="btn quiet" type="button" data-action="count-prev">Go back one</button>` : ""}</div>
        </form>
      </section>`;
  }
  function saveCountMode(form) {
    const c = S.count; if (!c || !canWrite()) return;
    const p = S.parts.get(c.list[c.i]); if (!p) return;
    const q = numOrNull(form.elements.qty.value);
    if (q === null || q < 0) return showWarn(form, "moveWarn", "Type how many there are, like 4. Or skip this one.");
    queueOp({ t: "move", pid: p.id, kind: "count", qty: round(q), note: "Counting the shelf" });
    c.saved++;
    c.i++;
    S.editing = { type: "countmode", focus: true };
    renderDetail();
    renderHeader();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- saving
  function toast(msg, act) {
    const el = $("#toast"), tx = $("#toastText"), b = $("#toastAct");
    tx.textContent = msg;
    toast._fn = act ? act.fn : null;
    b.hidden = !act;
    if (act) b.textContent = act.label;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.classList.remove("show"); toast._fn = null; }, act ? 7000 : 4200);
  }
  $("#toastAct").addEventListener("click", () => {
    const fn = toast._fn;
    toast._fn = null;
    $("#toast").classList.remove("show");
    if (fn) fn();
  });
  function setFormBusy(form, busy) { if (form) form.querySelectorAll("button").forEach(b => { b.disabled = busy; }); }
  function showWarn(form, id, text) { const w = form.querySelector("#" + id); if (w) { w.textContent = text; w.hidden = !text; } }
  const offlineNote = () => (isOffline() ? " No signal right now, so it's saved on this phone and will send on its own." : "");
  const canWrite = () => { if (S.keyBad) { toast("Sync is paused. Fix the setup code under the person button first."); return false; } return true; };
  const undoAct = op => ({ label: "Undo", fn: () => undoMove(moveIdOf(op), true) });

  // What a take, a delivery or a count leaves you with, in a sentence.
  function moveToast(kind, q, p0, unit) {
    const now = S.parts.get(p0.id), s = stockOf(now), t = partTitle(now);
    const counted = stockOf(p0).st !== "none";
    if (kind === "use") return `Took ${fmtQty(q)} · ${t}${unit ? " for the " + (machName(unit) || unit) : ""}.` + (!counted ? " It isn't counted yet, so count it when you can."
      : ` ${fmtQty(Math.max(0, now.on))} left.` + (s.st === "out" ? " That was the last one. It's on the Order list." : s.st === "low" ? " That's low. It's on the Order list." : ""));
    if (kind === "get") return `Got ${fmtQty(q)} in · ${t}. ${fmtQty(now.on)} on hand.` + (!counted ? " Count it if there were some already." : "");
    return `Counted ${fmtQty(q)} · ${t}.`;
  }
  function saveMove(form) {
    const p = S.parts.get(S.openId); if (!p || !canWrite()) return;
    const kind = form.dataset.kind;
    const q = numOrNull(form.elements.qty.value);
    if (q === null || q < 0) return showWarn(form, "moveWarn", kind === "count" ? "Type how many there are, like 4." : "Type how many, like 1.");
    if (kind !== "count" && q === 0) return showWarn(form, "moveWarn", "It has to be at least 1.");
    if (q > 100000) return showWarn(form, "moveWarn", "That's a lot. Check the number.");
    const op = { t: "move", pid: p.id, kind, qty: round(q), note: form.elements.note ? form.elements.note.value.trim().slice(0, 300) : "" };
    if (kind === "use") {
      const pick = form.querySelector('input[name="unit"]:checked');
      const other = form.elements.other ? form.elements.other.value : "";
      const unit = other || (pick && pick.value !== "__none" ? pick.value : "");
      if (!other && !pick) return showWarn(form, "moveWarn", "Pick the machine it's for, or No machine.");
      op.unit = unit;
      op.unitName = unit ? machName(unit) : "";
    }
    const before = Object.assign({}, p);
    queueOp(op);
    endEdit();
    render();
    toast(moveToast(kind, q, before, op.unit) + offlineNote(), undoAct(op));
  }
  // Took 1, right from a machine's page.
  function tookOne(pid, mid) {
    const p = S.parts.get(pid); if (!p || !canWrite()) return;
    const before = Object.assign({}, p);
    const op = queueOp({ t: "move", pid, kind: "use", qty: 1, unit: mid, unitName: machName(mid), note: "" });
    render();
    toast(moveToast("use", 1, before, mid) + offlineNote(), undoAct(op));
  }

  function saveField(form) {
    const p = S.parts.get(S.openId); if (!p || !canWrite()) return;
    const k = form.dataset.key;
    let val = form.elements.val.value.trim();
    if (k === "min" && val !== "") {
      const n = numOrNull(val);
      if (n === null || n < 0) return showWarn(form, "fieldWarn", "Type a number, like 2, or leave it blank.");
      val = round(n);
    }
    if ((k === "pn" && !val && !p.desc) || (k === "desc" && !val && !p.pn)) return showWarn(form, "fieldWarn", "A part needs a part number or a description.");
    const shownNew = k === "min" ? (val === "" ? "" : String(val)) : val;
    if (shownNew === fieldShown(p, k)) { endEdit(); renderDetail(); return; }
    queueOp({ t: "edit", pid: p.id, patch: { [k]: val } });
    endEdit();
    render();
    const said = k === "min" ? (val === "" ? "Saved. It shows on the Order list only when it's out." : `Saved. It shows on the Order list at ${fmtQty(val)} or fewer.`)
      : k === "pn" ? "Saved the part number." : k === "where" ? "Saved where it's kept." : "Saved.";
    toast(said + offlineNote());
  }
  function pickedFits(root) { return [...root.querySelectorAll('input[name="fit"]:checked')].map(i => i.value); }
  function saveFits(form) {
    const p = S.parts.get(S.openId); if (!p || !canWrite()) return;
    const list = pickedFits(form);
    if (list.join(",") === (p.fits || []).join(",")) { endEdit(); renderDetail(); return; }
    queueOp({ t: "edit", pid: p.id, patch: { fits: list } });
    endEdit();
    render();
    toast((list.length ? `Fits ${list.map(id => machName(id) || id).join(", ")}.` : "No machines picked.") + offlineNote());
  }
  function addPart(form) {
    if (!canWrite()) return;
    const f = form.elements;
    const pn = f.pn.value.trim(), desc = f.desc.value.trim();
    if (!pn && !desc) return showWarn(form, "addWarn", "Give it a part number or say what it is.");
    const count = numOrNull(f.count.value), min = numOrNull(f.min.value);
    if (f.count.value.trim() && (count === null || count < 0)) return showWarn(form, "addWarn", "How many there are now has to be a number, or blank.");
    if (f.min.value.trim() && (min === null || min < 0)) return showWarn(form, "addWarn", "Keep at least has to be a number, or blank.");
    const key = normKey(pn);
    const dup = key && activeParts().find(x => normKey(x.pn) === key || String(x.alt || "").split(/[,;\s]+/).some(a => normKey(a) === key));
    if (dup && form.dataset.dup !== key) {
      form.dataset.dup = key;
      const w = form.querySelector("#addWarn");
      w.innerHTML = `${esc(partTitle(dup))} is already on the list (${esc(dup.type)}). <button class="link" type="button" data-open="${esc(dup.id)}">Open it</button>, or tap Add part again to add this one anyway.`;
      w.hidden = false;
      return;
    }
    const id = newId("P");
    const part = { id, type: f.type.value || "Other", pn, desc, fits: pickedFits(form), min: min === null ? null : round(min), where: f.where.value.trim(), alt: f.alt.value.trim(), notes: f.notes.value.trim() };
    queueOp({ t: "add", part, count: count === null ? null : round(count) });
    S.editing = null;
    S.openId = id;
    try { if (NAV.on && history.state && history.state.ml) history.replaceState(screenNow(), ""); } catch (e) { /* fine */ }
    render();
    window.scrollTo(0, 0);
    rootWatch();
    toast(`Added ${partTitle(part)}.${count === null ? " Count it when you know how many there are." : ""}` + offlineNote());
  }
  function undoMove(id, undo) {
    const m = S.moves.find(x => x.id === id);
    if (!m || !canWrite()) return;
    if (!canUndo(m)) { toast("Only the owner can undo someone else's."); return; }
    if (!!m.undone === undo) return;
    const before = S.parts.get(m.part);
    const changedSince = m.kind === "edit" && before && fieldShown(before, m.field) !== (undo ? m.to : m.from);
    queueOp({ t: "undo", mid: id, val: undo });
    render();
    const p = S.parts.get(m.part);
    toast((undo ? "Undone." : "Put back.") + (changedSince ? " It was changed again since, so it stays as it is now." : "") +
      (p && !p.stale && (m.kind === "use" || m.kind === "get") ? ` ${partTitle(p)}: ${fmtQty(Math.max(0, p.on))} on hand.` : "") + offlineNote());
  }
  function removePart(gone) {
    const p = S.parts.get(S.openId);
    if (!p || !S.me.isOwner || !canWrite()) return;
    if (gone && !S.confirmRemove) {
      S.confirmRemove = true;
      renderDetail();
      clearTimeout(S.removeTimer);
      S.removeTimer = setTimeout(() => { S.confirmRemove = false; renderDetail(); }, 6000);
      return;
    }
    S.confirmRemove = false;
    queueOp({ t: "remove", pid: p.id, val: gone });
    render();
    toast(gone ? `${partTitle(p)} is off the list. Its history stays, and you can undo it there.` : `${partTitle(p)} is back on the list.`);
  }

  // ---------------------------------------------------------------- the phone's Back button
  // Back steps back through what you did in the app: it closes an open editor, then goes from a part or a machine
  // back to the list, then back through the tabs you were on. On the main list it does nothing, so Back never
  // takes you out of the app; the home button does. (Same as the Machine List.)
  const NAV = { on: false, atBase: true, pushed: false, ignore: 0, rootW: null };
  const TABS = ["parts", "machines", "order", "history", "me"];
  const screenNow = extra => Object.assign({ pl: 1, ml: 1, tab: S.tab, openId: S.openId || null, hPart: S.hPart || null }, extra || {});
  const inlineEditor = () => S.editing && !["add", "countmode"].includes(S.editing.type);

  function navStart() {
    if (NAV.on) return;
    NAV.on = true;
    try { history.scrollRestoration = "manual"; } catch (e) { /* older browsers */ }
    try { history.replaceState({ pl: 1, ml: 1, base: 1, tab: "parts", openId: null }, ""); } catch (e) { /* fine */ }
    NAV.atBase = true;
    const tapped = () => { NAV.pushed = false; setTimeout(navArm, 0); };
    document.addEventListener("click", tapped, true);
    document.addEventListener("keydown", tapped, true);
    window.addEventListener("popstate", onBack);
    rootWatch();
  }
  function navArm() {
    if (!NAV.on || !NAV.atBase || NAV.pushed || S.phase !== "app") return;
    try { history.pushState(screenNow(inlineEditor() ? { ed: 1 } : null), ""); NAV.atBase = false; } catch (e) { /* fine */ }
  }
  function navPush(extra) {
    if (!NAV.on) return;
    NAV.pushed = true;
    try {
      const cur = history.state;
      if (cur && cur.ml && cur.ed && !(extra && extra.ed)) { history.replaceState(screenNow(extra), ""); return; }
      if (cur && cur.ml) history.replaceState(Object.assign({}, cur, { y: window.scrollY }), "");
      history.pushState(screenNow(extra), "");
      NAV.atBase = false;
    } catch (e) { /* fine */ }
  }
  function goBackOne() {
    const st = history.state;
    if (!NAV.on || !st || !st.ml || st.base) return false;
    if (S.editing) S.editing = null;
    history.go(st.ed ? -2 : -1);
    return true;
  }
  function onBack(e) {
    if (NAV.ignore > 0) { NAV.ignore--; return; }
    const st = e.state && e.state.ml ? e.state : null;
    if (!st) return;
    NAV.atBase = !!st.base;
    const hadEditor = !!S.editing;
    if (S.editing && !st.ed) S.editing = null;   // Back closes an editor without saving, like Cancel
    const tab = TABS.includes(st.tab) ? st.tab : "parts";
    const id = validOpen(st.openId);
    const moved = tab !== S.tab || id !== (S.openId || null) || (st.hPart || null) !== (S.hPart || null);
    if (!moved) { if (hadEditor) renderDetail(); rootWatch(); return; }
    S.tab = tab;
    S.openId = id;
    S.hPart = st.hPart || null;
    S.confirmReset = false; S.confirmRemove = false;
    render();
    window.scrollTo(0, typeof st.y === "number" ? st.y : 0);
    const pl = document.querySelector(".pane-list"); if (pl && !id) pl.scrollTop = 0;
    rootWatch();
  }
  function endEdit() {
    S.editing = null;
    if (NAV.on && history.state && history.state.ml && history.state.ed) { NAV.ignore++; history.back(); }
  }
  function rootWatch() {
    const atRoot = NAV.on && S.phase === "app" && S.tab === "parts" && !S.openId && !S.editing;
    if (atRoot && !NAV.rootW && typeof window.CloseWatcher === "function") {
      try {
        const w = new window.CloseWatcher();
        w.addEventListener("cancel", ev => { if (ev.cancelable) ev.preventDefault(); });
        w.addEventListener("close", () => { if (NAV.rootW === w) NAV.rootW = null; setTimeout(rootWatch, 0); });
        NAV.rootW = w;
      } catch (err) { NAV.rootW = null; }
    } else if (!atRoot && NAV.rootW) {
      const w = NAV.rootW;
      NAV.rootW = null;
      try { w.destroy(); } catch (err) { /* already gone */ }
    }
  }

  // ---------------------------------------------------------------- navigation
  function setTab(t) {
    if (!TABS.includes(t)) t = "parts";
    if (t === S.tab && (!S.openId || window.innerWidth >= 980)) { window.scrollTo(0, 0); return; }
    S.editing = null;
    S.tab = t;
    S.confirmReset = false; S.confirmRemove = false;
    if (window.innerWidth < 980 && S.openId) closeDetail(true);
    navPush();
    render();
    window.scrollTo(0, 0);
    const pl = document.querySelector(".pane-list"); if (pl) pl.scrollTop = 0;
    rootWatch();
  }
  function openDetail(id) {
    if (!validOpen(id) || id === S.openId) return;
    if (!S.openId) S.listScroll = window.scrollY;
    if (/^m:/.test(id)) S.forMachine = id.slice(2);
    else if (!/^m:/.test(S.openId || "")) S.forMachine = machineFor(S.q) ? machineFor(S.q).id : null;
    S.editing = null; S.confirmRemove = false;
    S.openId = id;
    navPush();
    render();
    if (window.innerWidth < 980) window.scrollTo(0, 0);
    else { const d = $("#detail"); if (d) d.scrollTop = 0; }
    rootWatch();
  }
  function openAdd(forId, type) {
    if (!canWrite()) return;
    if (!S.openId) S.listScroll = window.scrollY;
    S.openId = "new";
    S.editing = { type: "add", focus: !type, addFor: forId && S.machineById.has(forId) ? forId : null, addType: type || "" };
    navPush();
    render();
    window.scrollTo(0, 0);
    if (type) { const i = $("#add-pn"); if (i) i.focus(); }
    rootWatch();
  }
  function closeDetail(silent) {
    S.openId = null; S.editing = null; S.confirmRemove = false; S.count = null;
    if (silent) return;
    render();
    window.scrollTo(0, S.listScroll || 0);
    rootWatch();
  }
  function startEdit(obj) {
    if (S.keyBad) return;
    const fresh = !S.editing;
    S.editing = Object.assign({ focus: true }, obj);
    if (fresh) navPush({ ed: 1 });
    renderDetail();
    rootWatch();
  }
  function showHistoryFor(pid) {
    S.hPart = pid; S.hFilter = "all"; S.hMore = 0;
    S.editing = null;
    S.tab = "history";
    if (window.innerWidth < 980) S.openId = null;
    navPush();
    render();
    window.scrollTo(0, 0);
    rootWatch();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", e => {
    if (L.open) {
      const p = e.target.closest("[data-pin],[data-pin-act]");
      if (!p) return;
      if (p.dataset.pin) return pinKey(p.dataset.pin);
      const a = p.dataset.pinAct;
      if (a === "forgot") { L.mode = "forgot"; return renderLock(); }
      if (a === "back") { L.mode = "unlock"; L.msg = ""; L.bad = false; return renderLock(); }
      if (a === "skip") { closeLock(); toast("No PIN on this phone. You can set one under the person button."); return; }
      if (a === "cancel") { closeLock(); return; }
      return;
    }
    const t = e.target.closest("[data-tab],[data-open],[data-st],[data-hf],[data-action]");
    if (!t) return;
    if (t.dataset.tab) {
      if (t.dataset.tab === "me" && S.tab === "me") { if (!goBackOne()) setTab("parts"); return; }
      if (t.dataset.tab === "history") S.hPart = null;
      return setTab(t.dataset.tab);
    }
    if (t.dataset.open) return openDetail(t.dataset.open);
    if (t.dataset.st) { S.st = t.dataset.st; return renderParts(); }
    if (t.dataset.hf) { S.hFilter = t.dataset.hf; S.hMore = 0; return renderHistory(); }
    const a = t.dataset.action;
    if (a === "close") {   // the Back and Done buttons work like the phone's Back
      const st = history.state;
      if (NAV.on && st && st.ml && !st.base && (st.openId || null) === (S.openId || null) && goBackOne()) return;
      return closeDetail();
    }
    if (a === "clear-filters") { S.q = ""; S.st = "all"; $("#q").value = ""; return renderParts(); }
    if (a === "add") return openAdd(t.dataset.for || (S.openId && /^m:/.test(S.openId) ? S.openId.slice(2) : S.forMachine), t.dataset.type || "");
    if (a === "count-start") return startCount();
    if (a === "count-skip") { if (S.count) { S.count.skipped++; S.count.i++; S.editing = { type: "countmode", focus: true }; renderDetail(); window.scrollTo(0, 0); } return; }
    if (a === "count-prev") { if (S.count && S.count.i > 0) { S.count.i--; S.editing = { type: "countmode", focus: true }; renderDetail(); window.scrollTo(0, 0); } return; }
    if (a === "use" || a === "get" || a === "count") return startEdit({ type: a, focus: a === "count" });   // no keyboard popping up for the + and - ones
    if (a === "took1") return tookOne(t.dataset.id, S.openId.slice(2));
    if (a === "get-for") { openDetail(t.dataset.id); return startEdit({ type: "get", focus: false }); }
    if (a === "qty") {
      const i = t.closest(".qty").querySelector("input"); if (!i) return;
      const n = numOrNull(i.value);
      const min = t.closest("form").dataset.form === "move" && t.closest("form").dataset.kind !== "count" ? 1 : 0;
      i.value = fmtQty(Math.max(min, round((n === null ? 0 : n) + Number(t.dataset.d))));
      return;
    }
    if (a === "edit") return startEdit({ type: "field", key: t.dataset.key });
    if (a === "fits-edit") return startEdit({ type: "fits", focus: false });
    if (a === "cancel") { endEdit(); renderDetail(); if (S.detailStale) render(); rootWatch(); return; }
    if (a === "undo") return undoMove(t.dataset.id, true);
    if (a === "redo") return undoMove(t.dataset.id, false);
    if (a === "remove") return removePart(true);
    if (a === "restore") return removePart(false);
    if (a === "hist-part") return showHistoryFor(S.openId);
    if (a === "hist-all") { S.hPart = null; S.hMore = 0; return renderHistory(); }
    if (a === "hist-more") { S.hMore += 150; return renderHistory(); }
    if (a === "share-order") return shareOrder();
    if (a === "sync-now") { if (navigator.onLine === false) { toast("No signal right now. Everything's saved on this phone and will send by itself."); return; } toast("Syncing…"); return sync({ full: true, user: true }); }
    if (a === "lock-now") return openLock("unlock");
    if (a === "pin-change") return openLock("change");
    if (a === "pin-set") return openLock("new");
    if (a === "backup") return downloadBackup();
    if (a === "reset") return resetPhone();
    if (a === "check-update") { toast("Checking for an app update…"); return checkForUpdate(true); }
    if (a === "reload-app") return location.reload();
    if (a === "install") {
      const ev = S.installEvt;
      if (!ev) return;
      S.installEvt = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(() => render()).catch(() => { /* closed */ });
      return;
    }
    if (a === "tip-close") { S.tipClosed = true; lsSet("tipDone", true); return renderParts(); }
    if (a === "count-tip-close") { lsSet("countTipDone", true); return renderParts(); }
  });
  document.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form === "setup") return doSetup(f);
    if (f.dataset.form === "forgot") return forgotPin(f);
    if (f.dataset.form === "newkey") return saveNewKey(f);
    if (L.open) return;
    if (f.dataset.form === "move") return saveMove(f);
    if (f.dataset.form === "countmode") return saveCountMode(f);
    if (f.dataset.form === "field") return saveField(f);
    if (f.dataset.form === "fits") return saveFits(f);
    if (f.dataset.form === "add") return addPart(f);
  });
  document.addEventListener("change", e => {
    const el = e.target;
    if (el.id === "lockAfter" && L.pin) {
      L.pin = Object.assign({}, L.pin, { after: Number(el.value) });
      M.set("pin", L.pin).catch(() => { /* try again next change */ });
      lsSet("seenAt", Date.now());
      toast(L.pin.after < 0 ? "The app won't ask for your PIN." : L.pin.after === 0 ? "The app asks for your PIN every time you open it." : "Saved.");
      renderMe();
    }
    // Took some: picking another machine from the list unpicks the ones above, and the other way around.
    if (el.id === "ed-other" && el.value) el.form.querySelectorAll('input[name="unit"]').forEach(r => { r.checked = false; });
    if (el.name === "unit" && el.checked) { const o = el.form.elements.other; if (o) o.value = ""; }
  });
  document.addEventListener("input", e => {
    const i = e.target;
    if (i.classList && i.classList.contains("code-input")) {   // setup codes: capitals and dashes as you type
      const raw = normKey(i.value).slice(0, 12);
      const pretty = raw.replace(/(.{4})(?=.)/g, "$1-");
      if (i.value !== pretty) i.value = pretty;
      return;
    }
    if (i.dataset && i.dataset.role === "fit-q") {   // finding a machine in the Fits list
      const q = i.value.trim().toLowerCase();
      const box = i.closest(".fit-pick");
      box.querySelectorAll("label.pick[data-hay]").forEach(l => { l.hidden = !!q && !l.dataset.hay.includes(q) && !l.querySelector("input").checked; });
      box.querySelectorAll(".fit-cat").forEach(c => { c.hidden = ![...c.querySelectorAll("label.pick")].some(l => !l.hidden); });
    }
  });
  document.addEventListener("keydown", e => {
    if (L.open && L.mode !== "forgot") {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinKey(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); pinKey("del"); }
      return;
    }
    if (e.key === "Escape" && inlineEditor()) { endEdit(); renderDetail(); }
    if (e.key === "Enter" && e.target.dataset && e.target.dataset.role === "fit-q") e.preventDefault();   // Enter in the machine search doesn't save
  });
  $("#q").addEventListener("input", e => { S.q = e.target.value; renderParts(); });
  $("#mq").addEventListener("input", e => { S.mq = e.target.value; renderMachines(); });

  // for the local test harness only
  window.__PL = { S, D, L, NAV, sync, reloadFromDb, stockOf, orderText };
  init();
})();
