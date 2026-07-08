# Spark — one Keep note at a time

PWA that resurfaces Google Keep notes one random note per tap. All data stays on-device
(IndexedDB); the hosted app shell contains no personal data.

## Status (July 8, 2026)
- Build complete and verified (syntax + parser logic tested against the real Takeout zip).
- NOT yet deployed. Remaining: GitHub Pages deploy -> transfer Takeout zip to phone ->
  install PWA -> import (label picker is in-app).

## Files
- `index.html` / `app.css` / `app.js` — the whole app (no build step)
- `sw.js` + `manifest.webmanifest` + `icons/` — PWA install & offline
- Takeout zips live OUTSIDE this folder in `../_data/spark/` (personal data, kept out of
  the repo by keeping them out of this folder). This folder holds ONLY app files, so it can
  be uploaded to GitHub directly.

## Architecture notes
- Import: zip.js (streaming BlobReader, loaded from jsdelivr) — handles the raw 1 GB+ zip
  on a phone. Do not switch back to JSZip (loads whole zip into RAM).
- Note identity: `createdTimestampUsec` (Takeout has no note IDs). Suspend/flag lists are
  keyed on it, so they survive re-imports. Content hash detects edited notes.
- Embeds: X via platform.twitter.com widget, YouTube via youtube-nocookie iframe,
  articles via r.jina.ai reader (cached in IndexedDB store `articles`).
- IndexedDB `spark`: stores `notes`, `media` (blobs, key = zip path), `kv`, `articles`.

## Deploy (when ready)
1. GitHub repo (public), upload the app files (NOT the zips).
2. Settings -> Pages -> deploy from main branch root.
3. On phone: open the Pages URL in Chrome -> "Add to Home screen".
4. Get the Takeout zip onto the phone, open Spark -> menu -> Import.

## Known limitations
- No auto-sync with Keep (consumer accounts have no API): re-export Takeout every few months.
- The 2 voice memos are .3gp (AMR) — Android Chrome may not play them; transcode if needed.
- Deleted/private X posts show as a plain link.
