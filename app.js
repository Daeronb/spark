/* ============================================================
   Spark — resurface your Google Keep notes, one at a time.
   All data lives on-device (IndexedDB). No servers, no upload.
   ============================================================ */
"use strict";

/* ---------------- tiny IndexedDB wrapper ---------------- */
const DB_NAME = "spark", DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("articles")) db.createObjectStore("articles");
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = _db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
const idbPut = (store, val, key) => tx(store, "readwrite", s => key !== undefined ? s.put(val, key) : s.put(val));
const idbDel = (store, key) => tx(store, "readwrite", s => s.delete(key));
const idbGet = (store, key) => new Promise((res, rej) => {
  const rq = _db.transaction(store).objectStore(store).get(key);
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const idbGetAll = (store) => new Promise((res, rej) => {
  const rq = _db.transaction(store).objectStore(store).getAll();
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});

/* ---------------- app state ---------------- */
const S = {
  notes: new Map(),          // id -> note
  suspended: new Set(),
  flagged: new Set(),
  activeLabels: new Set(),
  importedLabels: [],        // label names ever imported
  currentId: null,
  history: [],
  lastAction: null,          // {type, id} for undo
  mediaURLs: [],             // objectURLs to revoke on re-render
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hashStr(s) { // djb2
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const noteHash = (n) => hashStr((n.title || "") + "" + (n.text || "") + "" + JSON.stringify(n.list || null) + "" + (n.edited || 0));

async function saveKV(key, val) { await idbPut("kv", val, key); }

/* ---------------- startup ---------------- */
window.addEventListener("DOMContentLoaded", init);
async function init() {
  _db = await openDB();
  const [susp, flag, act, imp] = await Promise.all([
    idbGet("kv", "suspended"), idbGet("kv", "flagged"),
    idbGet("kv", "activeLabels"), idbGet("kv", "importedLabels"),
  ]);
  S.suspended = new Set(susp || []);
  S.flagged = new Set(flag || []);
  S.activeLabels = new Set(act || []);
  S.importedLabels = imp || [];
  const all = await idbGetAll("notes");
  for (const n of all) S.notes.set(n.id, n);

  wireEvents();
  refreshHome(true);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function pool() {
  const out = [];
  for (const n of S.notes.values()) {
    if (S.suspended.has(n.id)) continue;
    if (n.labels.some(l => S.activeLabels.has(l))) out.push(n.id);
  }
  return out;
}

function refreshHome(fresh) {
  const has = S.notes.size > 0;
  $("viewEmpty").hidden = has;
  $("viewNote").hidden = !has;
  $("actionBar").hidden = !has;
  $("chipsRow").hidden = !has;
  if (!has) return;
  renderChips();
  const p = pool();
  $("poolCount").textContent = p.length ? `· ${p.length} in rotation` : "";
  if (fresh || !S.currentId || !p.includes(S.currentId)) {
    nextNote(false);
  }
}

/* ---------------- label chips ---------------- */
function labelCounts() {
  const counts = {};
  for (const n of S.notes.values())
    for (const l of n.labels) counts[l] = (counts[l] || 0) + 1;
  return counts;
}
function renderChips() {
  const counts = labelCounts();
  const row = $("chipsRow");
  row.innerHTML = "";
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const name of names) {
    const b = document.createElement("button");
    b.className = "chip" + (S.activeLabels.has(name) ? " active" : "");
    b.innerHTML = `${esc(name)}<span class="chip-n">${counts[name]}</span>`;
    b.onclick = async () => {
      S.activeLabels.has(name) ? S.activeLabels.delete(name) : S.activeLabels.add(name);
      await saveKV("activeLabels", [...S.activeLabels]);
      refreshHome(false);
    };
    row.appendChild(b);
  }
}

/* ---------------- random note ---------------- */
function nextNote(animate = true) {
  const p = pool();
  const card = $("noteCard");
  if (!p.length) {
    S.currentId = null;
    card.className = "note-card";
    $("noteMedia").innerHTML = "";
    $("noteMeta").innerHTML = "";
    $("noteBody").innerHTML = `<p style="color:var(--text-dim);text-align:center;padding:30px 0">
      ${S.activeLabels.size ? "Nothing in rotation — all notes here are suspended." : "Select at least one label above to start."}</p>`;
    return;
  }
  let id;
  if (p.length === 1) id = p[0];
  else do { id = p[Math.floor(Math.random() * p.length)]; } while (id === S.currentId);
  if (S.currentId) { S.history.push(S.currentId); if (S.history.length > 50) S.history.shift(); }
  showNote(id, animate ? "next" : null);
}
function prevNote() {
  const id = S.history.pop();
  if (id && S.notes.has(id)) showNote(id, "prev");
}
function showNote(id, anim) {
  S.currentId = id;
  const card = $("noteCard");
  if (anim) {
    card.classList.add("leaving");
    setTimeout(() => { renderNote(S.notes.get(id)); card.classList.remove("leaving"); restartCardAnim(card); }, 150);
  } else {
    renderNote(S.notes.get(id));
    restartCardAnim(card);
  }
  const p = pool();
  $("poolCount").textContent = p.length ? `· ${p.length} in rotation` : "";
}
function restartCardAnim(card) {
  card.style.animation = "none"; void card.offsetHeight; card.style.animation = "";
}

/* ---------------- rendering ---------------- */
function cleanUrl(u) {
  u = u.replace(/[.,!?;:]+$/, "");                       // trailing punctuation
  while (u.endsWith(")") && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length)
    u = u.slice(0, -1);                                  // unbalanced closing paren
  return u;
}
function linkify(text) {
  const parts = [];
  let last = 0;
  const re = /https?:\/\/[^\s<>"']+/g;
  let m;
  while ((m = re.exec(text))) {
    const url = cleanUrl(m[0]);
    parts.push(esc(text.slice(last, m.index)));
    parts.push(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`);
    parts.push(esc(m[0].slice(url.length)));
    last = m.index + m[0].length;
  }
  parts.push(esc(text.slice(last)));
  return parts.join("");
}
function extractUrls(text) {
  return ((text || "").match(/https?:\/\/[^\s<>"']+/g) || []).map(cleanUrl);
}
const ytId = (url) => {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/))([\w-]{11})/);
  return m ? m[1] : null;
};
const tweetUrl = (url) => {
  const m = url.match(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
  return m ? `https://twitter.com/${m[1]}/status/${m[2]}` : null;
};

async function renderNote(note) {
  // revoke previous blob URLs
  for (const u of S.mediaURLs) URL.revokeObjectURL(u);
  S.mediaURLs = [];

  /* media */
  const mediaEl = $("noteMedia");
  mediaEl.innerHTML = "";
  for (const att of note.attachments || []) {
    const blob = await idbGet("media", att.file);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    S.mediaURLs.push(url);
    const type = att.type || blob.type || "";
    if (type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url; img.loading = "lazy";
      img.onclick = () => { $("lightboxImg").src = url; $("lightbox").hidden = false; };
      mediaEl.appendChild(img);
    } else if (type.startsWith("audio/")) {
      const au = document.createElement("audio");
      au.controls = true; au.src = url; au.preload = "metadata";
      mediaEl.appendChild(au);
    } else if (type.startsWith("video/")) {
      const v = document.createElement("video");
      v.controls = true; v.src = url; v.style.width = "100%"; v.style.borderRadius = "14px";
      mediaEl.appendChild(v);
    }
  }

  /* body */
  let html = "";
  if (note.title) html += `<h2 class="note-title">${esc(note.title)}</h2>`;
  if (note.list && note.list.length) {
    html += `<div class="checklist">` + note.list.map(i =>
      `<div class="check-item${i.checked ? " checked" : ""}"><div class="check-box"></div><span>${linkify(i.text || "")}</span></div>`
    ).join("") + `</div>`;
  }
  if (note.text) html += `<div>${linkify(note.text)}</div>`;
  $("noteBody").innerHTML = html;

  /* links (embeds) */
  const seen = new Set();
  const links = [];
  for (const l of note.links || []) { if (!seen.has(l.url)) { seen.add(l.url); links.push(l); } }
  for (const u of extractUrls(note.text)) { if (!seen.has(u)) { seen.add(u); links.push({ url: u }); } }

  const linkSec = document.createElement("div");
  linkSec.className = "link-section";
  let needTwitter = false;
  for (const l of links) {
    const yid = ytId(l.url);
    const tw = tweetUrl(l.url);
    if (yid) {
      const w = document.createElement("div");
      w.className = "embed-wrap";
      w.innerHTML = `<iframe class="yt-frame" loading="lazy" src="https://www.youtube-nocookie.com/embed/${yid}" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      linkSec.appendChild(w);
    } else if (tw) {
      const w = document.createElement("div");
      w.className = "tweet-wrap";
      w.innerHTML = `<blockquote class="twitter-tweet" data-theme="dark" data-dnt="true"><a href="${esc(tw)}">${esc(tw)}</a></blockquote>`;
      linkSec.appendChild(w);
      needTwitter = true;
    } else {
      let host = "";
      try { host = new URL(l.url).hostname.replace(/^www\./, ""); } catch {}
      const card = document.createElement("div");
      card.className = "link-card";
      card.innerHTML =
        (l.title ? `<div class="lc-title">${esc(l.title)}</div>` : "") +
        (l.desc ? `<div class="lc-desc">${esc(l.desc)}</div>` : "") +
        `<div class="lc-host">${esc(host || l.url)}</div>
         <div class="lc-actions">
           <button class="text-btn lc-read">Read here</button>
           <a class="text-btn" href="${esc(l.url)}" target="_blank" rel="noopener">Open ↗</a>
         </div>`;
      card.querySelector(".lc-read").onclick = () => openReader(l.url, l.title || host);
      linkSec.appendChild(card);
    }
  }
  const oldSec = $("noteCard").querySelector(".link-section");
  if (oldSec) oldSec.remove();
  if (linkSec.children.length) $("noteBody").after(linkSec);
  if (needTwitter) loadTwitterWidgets(linkSec);

  /* meta */
  const d = note.created ? new Date(note.created) : null;
  $("noteMeta").innerHTML =
    note.labels.map(l => `<span class="meta-label">${esc(l)}</span>`).join("") +
    (d ? `<span>${d.toLocaleDateString(undefined, { year: "numeric", month: "short" })}</span>` : "");
}

let _twLoading = null;
function loadTwitterWidgets(container) {
  if (window.twttr && window.twttr.widgets) { window.twttr.widgets.load(container); return; }
  if (!_twLoading) {
    _twLoading = new Promise((res) => {
      const s = document.createElement("script");
      s.src = "https://platform.twitter.com/widgets.js";
      s.async = true; s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    });
  }
  _twLoading.then(() => { if (window.twttr && window.twttr.widgets) window.twttr.widgets.load(container); });
}

/* ---------------- suspend / flag / undo ---------------- */
async function suspendCurrent(alsoFlag) {
  const id = S.currentId;
  if (!id) return;
  S.suspended.add(id);
  if (alsoFlag) S.flagged.add(id);
  await Promise.all([
    saveKV("suspended", [...S.suspended]),
    alsoFlag ? saveKV("flagged", [...S.flagged]) : Promise.resolve(),
  ]);
  S.lastAction = { type: alsoFlag ? "flag" : "suspend", id };
  toast(alsoFlag ? "Flagged for deletion & suspended" : "Suspended", true);
  nextNote();
}
async function undoLast() {
  const a = S.lastAction;
  if (!a) return;
  S.suspended.delete(a.id);
  S.flagged.delete(a.id);
  await Promise.all([saveKV("suspended", [...S.suspended]), saveKV("flagged", [...S.flagged])]);
  S.lastAction = null;
  hideToast();
  showNote(a.id, "prev");
}

let _toastTimer = null;
function toast(msg, undoable = false) {
  $("toastMsg").textContent = msg;
  $("toastUndo").hidden = !undoable;
  $("toast").hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 3500);
}
function hideToast() { $("toast").hidden = true; }

/* ---------------- menu sheet ---------------- */
function openSheet() {
  $("suspCount").textContent = S.suspended.size;
  $("flagCount").textContent = S.flagged.size;
  $("aboutStats").textContent =
    `${S.notes.size} notes stored · ${pool().length} in rotation · everything stays on this device`;
  $("sheet").hidden = false; $("sheetBackdrop").hidden = false;
}
function closeSheet() { $("sheet").hidden = true; $("sheetBackdrop").hidden = true; }

/* ---------------- suspended / flagged lists ---------------- */
function noteSnippet(n) {
  return n.title || (n.text || "").split("\n").find(l => l.trim()) ||
    (n.list && n.list[0] && n.list[0].text) || "(image / media note)";
}
async function openList(mode) {
  closeSheet();
  const ids = [...(mode === "flagged" ? S.flagged : S.suspended)];
  $("listTitle").textContent = mode === "flagged" ? "Flagged for deletion" : "Suspended notes";
  $("listHint").textContent = mode === "flagged"
    ? "These are suspended here AND on your cleanup list. Copy a note's text, search it in Google Keep, delete it there, then tap ✓ Done. Notes stay hidden in Spark either way."
    : "Suspended notes never appear in rotation — even after future imports. Restore puts one back.";
  $("btnCopyAll").hidden = mode !== "flagged";
  const wrap = $("listItems");
  wrap.innerHTML = ids.length ? "" : `<p style="color:var(--text-dim);text-align:center;padding:30px">Nothing here.</p>`;
  for (const id of ids) {
    const n = S.notes.get(id);
    if (!n) continue;
    const item = document.createElement("div");
    item.className = "list-item";
    const imgAtt = (n.attachments || []).find(a => (a.type || "").startsWith("image/"));
    item.innerHTML =
      `${imgAtt ? `<img class="li-thumb" alt="">` : ""}
       <div class="li-text">
         <div class="li-title">${esc(noteSnippet(n))}</div>
         <div class="li-date">${n.created ? new Date(n.created).toLocaleDateString() : ""}</div>
       </div>
       <div class="li-actions"></div>`;
    if (imgAtt) {
      idbGet("media", imgAtt.file).then(b => {
        if (b) { const u = URL.createObjectURL(b); item.querySelector(".li-thumb").src = u; }
      });
    }
    const actions = item.querySelector(".li-actions");
    if (mode === "flagged") {
      const bCopy = document.createElement("button");
      bCopy.className = "text-btn"; bCopy.textContent = "Copy";
      bCopy.onclick = () => { navigator.clipboard.writeText(noteSnippet(n)); toast("Copied — search it in Keep"); };
      const bDone = document.createElement("button");
      bDone.className = "text-btn"; bDone.textContent = "✓ Done";
      bDone.onclick = async () => {
        S.flagged.delete(id);
        await saveKV("flagged", [...S.flagged]);
        item.remove();
        toast("Removed from cleanup list");
      };
      actions.append(bCopy, bDone);
    } else {
      const bRestore = document.createElement("button");
      bRestore.className = "text-btn"; bRestore.textContent = "Restore";
      bRestore.onclick = async () => {
        S.suspended.delete(id); S.flagged.delete(id);
        await Promise.all([saveKV("suspended", [...S.suspended]), saveKV("flagged", [...S.flagged])]);
        item.remove();
        refreshHome(false);
        toast("Back in rotation");
      };
      actions.append(bRestore);
    }
    wrap.appendChild(item);
  }
  $("listView").hidden = false;
}

/* ---------------- backup / restore ---------------- */
function downloadBackup() {
  const data = {
    app: "spark", v: 1, date: new Date().toISOString(),
    suspended: [...S.suspended], flagged: [...S.flagged],
    activeLabels: [...S.activeLabels], importedLabels: S.importedLabels,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spark-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast("Backup downloaded");
}
async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "spark") throw new Error("not a spark backup");
    for (const id of data.suspended || []) S.suspended.add(id);
    for (const id of data.flagged || []) S.flagged.add(id);
    if (data.activeLabels) S.activeLabels = new Set(data.activeLabels);
    await Promise.all([
      saveKV("suspended", [...S.suspended]), saveKV("flagged", [...S.flagged]),
      saveKV("activeLabels", [...S.activeLabels]),
    ]);
    refreshHome(true);
    toast("Backup restored");
  } catch (e) { toast("Couldn't read that backup file"); }
}

/* ---------------- article reader ---------------- */
async function openReader(url, title) {
  $("readerTitle").textContent = title || "Reader";
  $("readerOpenLive").href = url;
  $("readerContent").innerHTML = `<div class="reader-loading">Fetching readable version…</div>`;
  $("readerView").hidden = false;
  try {
    let cached = await idbGet("articles", url);
    if (!cached) {
      const r = await fetch("https://r.jina.ai/" + url, { headers: { "Accept": "text/plain" } });
      if (!r.ok) throw new Error("fetch failed");
      let text = await r.text();
      const idx = text.indexOf("Markdown Content:");
      if (idx >= 0) text = text.slice(idx + "Markdown Content:".length);
      cached = text.trim();
      if (cached.length > 200) await idbPut("articles", cached, url);
    }
    $("readerContent").innerHTML = mdToHtml(cached);
  } catch (e) {
    $("readerContent").innerHTML =
      `<div class="reader-loading">Couldn't fetch a readable version (site may block it, or you're offline).<br><br>
       <a class="text-btn" href="${esc(url)}" target="_blank" rel="noopener">Open the live page ↗</a></div>`;
  }
}
/* minimal markdown → html (headings, bold, italic, links, images, lists, paragraphs) */
function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "", inList = false, para = [];
  const inline = (s) => {
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, `<img src="$2" alt="$1" loading="lazy">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    return s;
  };
  const flush = () => {
    if (para.length) { html += `<p>${inline(para.join(" "))}</p>`; para = []; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (h) { flush(); if (inList) { html += "</ul>"; inList = false; } html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; }
    else if (li) { flush(); if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; }
    else if (!line.trim()) { flush(); if (inList) { html += "</ul>"; inList = false; } }
    else para.push(line);
  }
  flush(); if (inList) html += "</ul>";
  return html;
}

/* ============================================================
   IMPORT — parse a Google Takeout (Keep) zip, on-device.
   Uses zip.js with a BlobReader: entries stream from the file,
   so multi-GB Takeout zips import fine even on a phone.
   ============================================================ */
let _reader = null;       // zip.js ZipReader kept between steps
let _entries = null;      // Map: path -> zip entry (streaming, low memory)
let _scanned = null;      // [{json, prefix}] parsed candidates

function loadZipLib() {
  const cfg = () => { try { window.zip.configure({ useWebWorkers: false }); } catch {} };
  if (window.zip) { cfg(); return Promise.resolve(); }
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2/dist/zip.min.js";
    s.onload = () => { cfg(); res(); };
    s.onerror = () => rej(new Error("Couldn't load zip library — are you online?"));
    document.head.appendChild(s);
  });
}
async function closeZip() {
  try { if (_reader) await _reader.close(); } catch {}
  _reader = null; _entries = null; _scanned = null;
}

function openImport() {
  closeSheet();
  showImportStep("importPick");
  $("importView").hidden = false;
}
function showImportStep(id) {
  for (const step of ["importPick", "importProgress", "importLabels", "importDone"])
    $(step).hidden = step !== id;
}
function setProgress(msg, frac) {
  $("importStatus").textContent = msg;
  $("progressBar").style.width = Math.round(frac * 100) + "%";
}

async function scanZip(file) {
  showImportStep("importProgress");
  setProgress("Loading zip library…", 0.02);
  await loadZipLib();
  await closeZip();
  /* Load the whole zip into RAM once, then read entries from memory.
     Random-access reads on a multi-GB File are very slow on phones
     (~hundreds of ms each); in-memory reads are instant. Falls back to
     streaming from the File on low-memory devices. */
  let _src;
  try {
    setProgress("Loading zip into memory (one-time — a few seconds)…", 0.03);
    const buf = await file.arrayBuffer();
    _src = new window.zip.Uint8ArrayReader(new Uint8Array(buf));
  } catch (memErr) {
    _src = new window.zip.BlobReader(file);
  }
  setProgress("Reading zip index…", 0.05);
  _reader = new window.zip.ZipReader(_src);
  const all = await _reader.getEntries();
  _entries = new Map();
  for (const e of all) if (!e.directory) _entries.set(e.filename, e);

  const jsonEntries = [];
  for (const path of _entries.keys())
    if (/(^|\/)Keep\/[^/]+\.json$/i.test(path)) jsonEntries.push(path);
  if (!jsonEntries.length) throw new Error("No Keep notes found in this zip. Make sure it's a Google Takeout export that includes Keep.");

  _scanned = [];
  const labelCount = {};
  const _t0 = performance.now();
  for (let i = 0; i < jsonEntries.length; i++) {
    if (i % 25 === 0) {
      const _sec = (performance.now() - _t0) / 1000;
      const _rate = _sec > 0.2 ? Math.round(i / _sec) : 0;
      setProgress(`Scanning notes… ${i}/${jsonEntries.length} · ${_rate}/s · BUILD 5`, 0.05 + 0.55 * (i / jsonEntries.length));
      await new Promise(r => setTimeout(r, 0));
    }
    let j;
    try { j = JSON.parse(await _entries.get(jsonEntries[i]).getData(new window.zip.TextWriter())); }
    catch { continue; }
    if (j.isTrashed) continue;
    const prefix = jsonEntries[i].replace(/[^/]+$/, "");
    const labels = (j.labels || []).map(l => l.name).filter(Boolean);
    if (!labels.length) labels.push("(no label)");
    for (const l of labels) labelCount[l] = (labelCount[l] || 0) + 1;
    _scanned.push({ j, prefix, labels });
  }

  /* label picker */
  const listEl = $("labelPickList");
  listEl.innerHTML = "";
  const prev = new Set(S.importedLabels);
  const names = Object.keys(labelCount).sort((a, b) => labelCount[b] - labelCount[a]);
  for (const name of names) {
    const lab = document.createElement("label");
    lab.className = "label-pick";
    lab.innerHTML = `<input type="checkbox" value="${esc(name)}" ${prev.has(name) ? "checked" : ""}>
      <span>${esc(name)}</span><span class="lp-n">${labelCount[name]} notes</span>`;
    listEl.appendChild(lab);
  }
  showImportStep("importLabels");
}

async function doImport() {
  const picked = new Set(
    [...$("labelPickList").querySelectorAll("input:checked")].map(i => i.value)
  );
  if (!picked.size) { toast("Pick at least one label"); return; }
  showImportStep("importProgress");

  const candidates = _scanned.filter(c => c.labels.some(l => picked.has(l)));
  let added = 0, updated = 0, unchanged = 0, stillSuspended = 0, mediaCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { j, prefix, labels } = candidates[i];
    if (i % 10 === 0) {
      setProgress(`Importing notes & media… ${i}/${candidates.length}`, 0.6 + 0.4 * (i / candidates.length));
      await new Promise(r => setTimeout(r, 0));
    }
    const created = j.createdTimestampUsec ? Math.floor(j.createdTimestampUsec / 1000) : 0;
    const edited = j.userEditedTimestampUsec ? Math.floor(j.userEditedTimestampUsec / 1000) : 0;
    const note = {
      id: j.createdTimestampUsec ? String(j.createdTimestampUsec)
        : "h" + hashStr((j.title || "") + (j.textContent || "") + created),
      title: j.title || "",
      text: j.textContent || "",
      list: Array.isArray(j.listContent) ? j.listContent.map(x => ({ text: x.text || "", checked: !!x.isChecked })) : null,
      labels,
      created, edited,
      archived: !!j.isArchived,
      links: (j.annotations || [])
        .filter(a => a.source === "WEBLINK" && a.url)
        .map(a => ({ url: a.url, title: a.title || "", desc: a.description || "" })),
      attachments: [],
    };
    note.hash = noteHash(note);

    /* attachments → media store */
    for (const att of j.attachments || []) {
      if (!att.filePath) continue;
      const entry = findZipEntry(prefix, att.filePath);
      if (!entry) continue;
      const key = entry.filename;
      note.attachments.push({ file: key, type: att.mimetype || "" });
      const existing = await idbGet("media", key);
      if (!existing) {
        const blob = await entry.getData(new window.zip.BlobWriter(att.mimetype || undefined));
        await idbPut("media", blob, key);
        mediaCount++;
      }
    }

    const prevNote = S.notes.get(note.id);
    if (prevNote && prevNote.hash === note.hash) { unchanged++; continue; }
    if (prevNote) updated++; else added++;
    if (S.suspended.has(note.id)) stillSuspended++;
    S.notes.set(note.id, note);
    await idbPut("notes", note);
  }

  /* remember imported labels; default active = picked if nothing set */
  S.importedLabels = [...new Set([...S.importedLabels, ...picked])];
  await saveKV("importedLabels", S.importedLabels);
  if (!S.activeLabels.size) {
    S.activeLabels = new Set(picked);
    await saveKV("activeLabels", [...S.activeLabels]);
  }

  await closeZip();
  $("importSummary").innerHTML =
    `<strong>${added}</strong> new note${added === 1 ? "" : "s"} imported` +
    (updated ? `, <strong>${updated}</strong> updated` : "") +
    (unchanged ? `, ${unchanged} unchanged` : "") +
    (mediaCount ? `<br>${mediaCount} media files stored` : "") +
    (stillSuspended ? `<br>${stillSuspended} previously-suspended notes stay filtered out` : "");
  showImportStep("importDone");
}

function findZipEntry(prefix, filePath) {
  let e = _entries.get(prefix + filePath);
  if (e) return e;
  /* Takeout quirk: JSON sometimes says .jpeg while the file is .jpg (and vice versa) */
  const base = filePath.replace(/\.[^.]+$/, "");
  for (const alt of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".3gp", ".3gpp", ".m4a", ".mp3"]) {
    e = _entries.get(prefix + base + alt);
    if (e) return e;
  }
  /* last resort: match by basename anywhere under the same folder */
  for (const [path, entry] of _entries) {
    if (path.startsWith(prefix) && path.slice(prefix.length).startsWith(base + ".")) return entry;
  }
  return null;
}

/* ---------------- wipe ---------------- */
async function wipeAll() {
  if (!confirm("Delete ALL app data on this device? Your Google Keep is not affected.")) return;
  if (!confirm("Really sure? Suspensions and flags are deleted too (back them up first!).")) return;
  _db.close();
  await new Promise((res) => { const rq = indexedDB.deleteDatabase(DB_NAME); rq.onsuccess = res; rq.onerror = res; });
  location.reload();
}

/* ---------------- events ---------------- */
function wireEvents() {
  $("btnNext").onclick = () => nextNote();
  $("btnSuspend").onclick = () => suspendCurrent(false);
  $("btnFlag").onclick = () => suspendCurrent(true);
  $("btnMenu").onclick = openSheet;
  $("sheetBackdrop").onclick = closeSheet;
  $("toastUndo").onclick = undoLast;
  $("lightbox").onclick = () => { $("lightbox").hidden = true; };
  $("btnFirstImport").onclick = openImport;
  $("btnListBack").onclick = () => { $("listView").hidden = true; refreshHome(false); };
  $("btnReaderBack").onclick = () => { $("readerView").hidden = true; };
  $("btnImportBack").onclick = () => { $("importView").hidden = true; closeZip(); refreshHome(false); };
  $("btnPickZip").onclick = () => $("zipInput").click();
  $("zipInput").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { await scanZip(f); }
    catch (err) { toast(err.message || "Import failed"); showImportStep("importPick"); }
  };
  $("btnDoImport").onclick = () => doImport().catch(err => { toast(err.message || "Import failed"); showImportStep("importPick"); });
  $("btnImportFinish").onclick = () => { $("importView").hidden = true; refreshHome(true); };
  $("btnCopyAll").onclick = () => {
    const lines = [...S.flagged].map(id => S.notes.get(id)).filter(Boolean).map(n => "• " + noteSnippet(n));
    navigator.clipboard.writeText(lines.join("\n"));
    toast("Cleanup list copied");
  };

  document.querySelectorAll(".sheet-item").forEach(el => {
    el.onclick = () => {
      const a = el.dataset.action;
      if (a === "import") openImport();
      else if (a === "suspended") openList("suspended");
      else if (a === "flagged") openList("flagged");
      else if (a === "backup") { closeSheet(); downloadBackup(); }
      else if (a === "restore") { closeSheet(); $("stateInput").click(); }
      else if (a === "wipe") { closeSheet(); wipeAll(); }
    };
  });
  $("stateInput").onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) restoreBackup(f);
  };

  /* swipe gestures on the note area */
  let tx0 = null, ty0 = null;
  $("main").addEventListener("touchstart", (e) => {
    tx0 = e.touches[0].clientX; ty0 = e.touches[0].clientY;
  }, { passive: true });
  $("main").addEventListener("touchend", (e) => {
    if (tx0 === null || $("viewNote").hidden) return;
    const dx = e.changedTouches[0].clientX - tx0;
    const dy = e.changedTouches[0].clientY - ty0;
    tx0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      if (dx < 0) nextNote(); else prevNote();
    }
  }, { passive: true });

  /* keyboard (desktop testing) */
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || !$("importView").hidden || !$("readerView").hidden) return;
    if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); nextNote(); }
    if (e.key === "ArrowLeft") prevNote();
  });
}
/* eof */
