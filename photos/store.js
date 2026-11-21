/* Job Photos: what's kept on this phone, and the trips to the sheet and back.
   The app page and the background helper (sw.js) both use this file, so they always agree.

   Saved on the phone (IndexedDB "job-photos"):
     kv     setup  { key, name, role }          the code this phone uses
            data   { jobs, photos, at, folder } the last copy of the jobs and photo list the sheet sent
            outbox [op, ...]                    things done on this phone that the sheet doesn't have yet
            jobmap { tmp id: real id }          jobs started with no signal, once the sheet has them
            lastOk                              time of the last good trip to the sheet
     blobs  "q:<op id>:d|v|t" a photo waiting to send: the photo, its viewing copy, its thumbnail.
                              Deleted the moment it reaches the cloud. Photos are never kept on the phone
                              otherwise: the app shows them from the cloud and holds them in memory only. */
(function (root) {
  "use strict";
  const DB_NAME = "job-photos";
  const KV = "kv", BL = "blobs";
  const OPEN_MS = 5000;
  let dbp = null, conn = null, gen = 0;

  const list = v => (Array.isArray(v) ? v : []);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Opens this phone's storage. A phone (iPhones especially, right after the app comes back) can be slow to
  // answer for a moment: a stuck open gives up after a few seconds so the next try starts fresh.
  function open() {
    if (dbp) return dbp;
    const my = ++gen;
    const p = new Promise((resolve, reject) => {
      let req, timer = null, done = false;
      const fail = err => { if (done) return; done = true; clearTimeout(timer); reject(err); };
      timer = setTimeout(() => fail(new Error("This phone's storage didn't answer")), OPEN_MS);
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { fail(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV);
        if (!d.objectStoreNames.contains(BL)) d.createObjectStore(BL);
      };
      req.onsuccess = () => {
        const d = req.result;
        if (done || gen !== my) { try { d.close(); } catch (e) { /* nobody is waiting for it */ } fail(new Error("Storage reopened")); return; }
        done = true;
        clearTimeout(timer);
        d.onversionchange = () => { try { d.close(); } catch (e) { /* already closed */ } if (gen === my) { dbp = null; conn = null; } };
        d.onclose = () => { if (gen === my) { dbp = null; conn = null; } };
        conn = d;
        resolve(d);
      };
      req.onerror = () => fail(req.error || new Error("Couldn't open this phone's storage"));
    });
    dbp = p;
    p.catch(() => { if (gen === my) { dbp = null; conn = null; } });
    return p;
  }

  function reset() {
    gen++;
    dbp = null;
    const d = conn;
    conn = null;
    if (d) { try { d.close(); } catch (e) { /* already closed */ } }
  }

  function attempt(stores, mode, body) {
    return open().then(d => new Promise((resolve, reject) => {
      let t;
      try { t = d.transaction(stores, mode); } catch (e) { reject(e); return; }
      let out;
      try { out = body(t); }
      catch (e) {
        try { t.abort(); } catch (x) { /* done */ }
        try { e.mine = true; } catch (x) { /* plain value */ }
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(typeof out === "function" ? out() : out);
      t.onerror = () => reject(t.error || new Error("Storage error"));
      t.onabort = () => reject(t.error || new Error("Storage write was cancelled"));
    }));
  }

  // One transaction. If the phone dropped the storage connection in the background, the step fails whole
  // (nothing half-saved) and gets one more try on a fresh connection.
  function run(stores, mode, body) {
    return attempt(stores, mode, body).catch(err => {
      if (err && (err.mine || err.name === "QuotaExceededError" || err.name === "DataCloneError")) throw err;
      reset();
      return sleep(150).then(() => attempt(stores, mode, body));
    });
  }

  const get = key => run([KV], "readonly", t => { const q = t.objectStore(KV).get(key); return () => q.result; });
  const set = (key, val) => run([KV], "readwrite", t => { t.objectStore(KV).put(val, key); return val; });
  const del = key => run([KV], "readwrite", t => { t.objectStore(KV).delete(key); return true; });
  // Read, change and write one value in a single step, so two writers can't step on each other.
  function update(key, fn) {
    return run([KV], "readwrite", t => {
      let out;
      const s = t.objectStore(KV), q = s.get(key);
      q.onsuccess = () => { out = fn(q.result); s.put(out, key); };
      return () => out;
    });
  }
  const bget = key => run([BL], "readonly", t => { const q = t.objectStore(BL).get(key); return () => q.result; });
  const bput = (key, blob) => run([BL], "readwrite", t => { t.objectStore(BL).put(blob, key); return true; });
  const bdel = keys => run([BL], "readwrite", t => { const s = t.objectStore(BL); keys.forEach(k => s.delete(k)); return true; });
  const bkeys = () => run([BL], "readonly", t => { const q = t.objectStore(BL).getAllKeys(); return () => list(q.result); });
  // Older versions kept copies of photos on the phone ("t:" small, "v:" big). Photos live in the cloud now,
  // so those are cleared out. Only photos still waiting to send ("q:") are ever kept, and only until they go.
  async function purgeSaved() {
    const old = (await bkeys()).filter(k => /^[tv]:/.test(String(k)));
    if (old.length) await bdel(old);
    return old.length;
  }
  function clearAll() {
    return run([KV, BL], "readwrite", t => { t.objectStore(KV).clear(); t.objectStore(BL).clear(); return true; });
  }

  // Saves a waiting change and its photo files in one step: either all of it is on the phone, or none of it.
  function queue(op, files) {
    return run([KV, BL], "readwrite", t => {
      const b = t.objectStore(BL), s = t.objectStore(KV);
      Object.keys(files || {}).forEach(k => { if (files[k]) b.put(files[k], k); });
      // A job started on this phone may have reached the sheet while this photo was being got ready:
      // file it under the job's real number, or it would wait for a job that's already been sent.
      const m = s.get("jobmap");
      m.onsuccess = () => {
        const real = op.job && (m.result || {})[op.job];
        if (real) op.job = real;
        const q = s.get("outbox");
        q.onsuccess = () => s.put(list(q.result).concat([op]), "outbox");
      };
      return op;
    });
  }
  // Mends anything already filed under a started job's temporary number after that job was sent.
  function fixJobNumbers() {
    return run([KV], "readwrite", t => {
      const s = t.objectStore(KV);
      const m = s.get("jobmap");
      m.onsuccess = () => {
        const map = m.result || {};
        const q = s.get("outbox");
        q.onsuccess = () => {
          const ob = list(q.result);
          if (ob.some(o => o && map[o.job])) s.put(ob.map(o => (o && map[o.job] ? Object.assign({}, o, { job: map[o.job] }) : o)), "outbox");
        };
      };
      return true;
    });
  }
  function changeOp(id, fn) {
    return update("outbox", ob => list(ob).map(o => (o && o.id === id ? fn(Object.assign({}, o)) : o)));
  }
  // Takes a change off the list without sending it (and its files with it).
  function removeOp(id) {
    return run([KV, BL], "readwrite", t => {
      const b = t.objectStore(BL), s = t.objectStore(KV);
      ["d", "v", "t"].forEach(x => b.delete("q:" + id + ":" + x));
      const q = s.get("outbox");
      q.onsuccess = () => s.put(list(q.result).filter(o => o && o.id !== id), "outbox");
      return true;
    });
  }

  // ------------------------------------------------------------------ the trip to the sheet
  // The sheet's link is a Google Apps Script web app. Plain text keeps the browser from asking
  // permission first (Google doesn't answer that), and Google redirects to the answer.
  async function post(url, body, ms) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, ms || 45000);
    try {
      const r = await fetch(url, {
        method: "POST", body: JSON.stringify(body), redirect: "follow", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: ctl ? ctl.signal : undefined
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) {
        const err = new Error(r.ok ? "The sheet sent back something unexpected." : "The sheet answered with error " + r.status + ".");
        err.server = true; err.status = r.status;
        throw err;
      }
    } finally { clearTimeout(timer); }
  }

  async function call(action, args, ms, keyOverride) {
    const cfg = root.JP_CONFIG || {};
    const setup = keyOverride ? { key: keyOverride } : await get("setup");
    if (!setup || !setup.key) { const e = new Error("This phone isn't set up yet."); e.code = "NOSETUP"; e.server = true; throw e; }
    if (!cfg.syncUrl) { const e = new Error("This copy of the app isn't linked to the sheet."); e.server = true; throw e; }
    let res;
    try { res = await post(cfg.syncUrl, { key: setup.key, action, args: args || {}, app: root.JP_VERSION || "" }, ms); }
    catch (e) {
      if (e && e.server) throw e;
      const err = new Error("No signal right now.");
      err.offline = true;
      throw err;
    }
    if (!res || res.ok !== true) {
      const err = new Error((res && res.error) || "The sheet said no.");
      err.server = true; err.code = res && res.code;
      throw err;
    }
    return res.data;
  }

  async function blobB64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64Blob(b64, type) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: type || "image/jpeg" });
  }

  // Keeps the job list's photo counts right after a photo lands.
  function addToData(dd, rec) {
    dd.photos = list(dd.photos).filter(p => p.id !== rec.id).concat([rec]);
    const j = list(dd.jobs).find(x => x.id === rec.job);
    if (j) {
      j.count = dd.photos.filter(p => p.job === j.id).length;
      j.last = Math.max(j.last || 0, rec.up || Date.now());
      const when = rec.taken || rec.up;
      if (rec.t && (!j.coverAt || when >= j.coverAt)) { j.cover = rec.t; j.coverAt = when; }
    }
    return dd;
  }

  async function sendJob(op) {
    const r = await call("createJob", { name: op.name, address: op.address || "", customer: op.customer || "", notes: op.notes || "", aliases: op.aliases || "" }, 60000);
    const real = r.job;
    await run([KV], "readwrite", t => {
      const s = t.objectStore(KV);
      const q1 = s.get("outbox");
      q1.onsuccess = () => s.put(list(q1.result).filter(o => o && o.id !== op.id).map(o => (o && o.job === op.tmp ? Object.assign({}, o, { job: real.id }) : o)), "outbox");
      const q2 = s.get("data");
      q2.onsuccess = () => { const dd = q2.result || { jobs: [], photos: [] }; dd.jobs = list(dd.jobs).filter(j => j.id !== real.id).concat([real]); s.put(dd, "data"); };
      const q3 = s.get("jobmap");
      q3.onsuccess = () => { const m = q3.result || {}; m[op.tmp] = real.id; s.put(m, "jobmap"); };
      return true;
    });
    return real;
  }

  async function sendPhoto(op) {
    const id = op.id;
    const files = await run([BL], "readonly", t => {
      const s = t.objectStore(BL), out = {};
      ["d", "v", "t"].forEach(x => { const q = s.get("q:" + id + ":" + x); q.onsuccess = () => { out[x] = q.result || null; }; });
      return () => out;
    });
    if (!files.d) { await removeOp(id); return null; }   // its files are gone: nothing to send
    const args = {
      jobId: op.job, pid: op.pid, mime: op.mime || files.d.type || "image/jpeg",
      data: await blobB64(files.d), thumb: files.t ? await blobB64(files.t) : "", view: files.v ? await blobB64(files.v) : "",
      taken: op.taken, w: op.w || 0, h: op.h || 0, lat: op.lat, lng: op.lng,
      caption: op.caption || "", origName: op.origName || "", origSize: op.origSize || 0
    };
    const rec = await call("upload", args, 180000);
    await run([KV, BL], "readwrite", t => {
      const b = t.objectStore(BL), s = t.objectStore(KV);
      ["d", "v", "t"].forEach(x => b.delete("q:" + id + ":" + x));            // it's in the cloud now: nothing stays on the phone
      const q1 = s.get("outbox");
      q1.onsuccess = () => s.put(list(q1.result).filter(o => o && o.id !== id), "outbox");
      const q2 = s.get("data");
      q2.onsuccess = () => { if (q2.result) s.put(addToData(q2.result, rec), "data"); };
      return true;
    });
    return rec;
  }

  async function sendNote(op) {
    const rec = await call("editPhoto", { id: op.photo, caption: op.caption || "" }, 30000);
    await run([KV], "readwrite", t => {
      const s = t.objectStore(KV);
      const q1 = s.get("outbox");
      q1.onsuccess = () => s.put(list(q1.result).filter(o => o && o.id !== op.id), "outbox");
      const q2 = s.get("data");
      q2.onsuccess = () => {
        const dd = q2.result;
        if (dd) { dd.photos = list(dd.photos).map(p => (p.id === rec.id ? Object.assign({}, p, rec) : p)); s.put(dd, "data"); }
      };
      return true;
    });
    return rec;
  }

  // What can go next: started jobs first, then photos and notes whose job the sheet already has.
  function readyOps(ob) {
    const live = list(ob).filter(o => o && !o.failed);
    const jobs = live.filter(o => o.t === "job");
    if (jobs.length) return jobs.slice(0, 1);
    return live.filter(o => !String(o.job || "").startsWith("tmp-"));
  }

  // Sends everything waiting. Stops at the first sign of no signal; a change the sheet turns down is
  // marked so the person can see why, and the rest keep going.
  async function pushAll(opts) {
    opts = opts || {};
    const step = typeof opts.onStep === "function" ? opts.onStep : () => {};
    const width = Math.max(1, opts.parallel || 1);
    let sent = 0;
    for (let round = 0; round < 3000; round++) {
      await fixJobNumbers();
      const ready = readyOps(await get("outbox"));
      if (!ready.length) return { ok: true, sent };
      const batch = ready[0].t === "photo" ? ready.filter(o => o.t === "photo").slice(0, width) : [ready[0]];
      const results = await Promise.all(batch.map(async op => {
        try {
          step({ op, phase: "start" });
          if (op.t === "job") await sendJob(op);
          else if (op.t === "photo") await sendPhoto(op);
          else if (op.t === "note") await sendNote(op);
          else await removeOp(op.id);
          step({ op, phase: "done" });
          return "ok";
        } catch (e) {
          if (e && e.offline) return "offline";
          if (e && e.code === "NOKEY") return "nokey";
          await changeOp(op.id, o => Object.assign(o, { failed: true, err: (e && e.message) || "The sheet didn't take it." }));
          step({ op, phase: "failed", error: e });
          return "failed";
        }
      }));
      sent += results.filter(r => r === "ok").length;
      if (results.includes("nokey")) return { ok: false, nokey: true, sent };
      if (results.includes("offline")) return { ok: false, offline: true, sent };
    }
    return { ok: true, sent };
  }

  // Gets the sheet's current jobs and photo list.
  async function pull() {
    const d = await call("all", {}, 90000);
    await set("data", { jobs: list(d.jobs), photos: list(d.photos), at: Date.now(), folder: d.folder || "" });
    await update("setup", s => Object.assign({}, s || {}, { name: d.me.name, role: d.me.role }));
    await set("lastOk", Date.now());
    return d;
  }

  async function syncAll(opts) {
    const p = await pushAll(opts);
    if (!p.ok) return p;
    if (opts && opts.noPull) return p;
    try { await pull(); return Object.assign(p, { pulled: true }); }
    catch (e) { return Object.assign(p, { ok: false, offline: !!(e && e.offline), nokey: e && e.code === "NOKEY", error: e && e.message }); }
  }

  // The page and the background helper never send at the same time.
  function withLock(fn) {
    const nav = root.navigator;
    if (nav && nav.locks && typeof nav.locks.request === "function") return nav.locks.request("jp-sync", fn);
    return fn();
  }

  root.JPStore = {
    open, reset, get, set, del, update, bget, bput, bdel, bkeys, purgeSaved, clearAll, queue, changeOp, removeOp,
    post, call, blobB64, b64Blob, pushAll, pull, syncAll, withLock, list
  };
})(typeof self !== "undefined" ? self : globalThis);
