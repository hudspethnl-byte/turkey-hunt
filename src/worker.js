// The Turkey Hunt's small server (a Cloudflare Worker).
//
// It does two jobs:
//   1. Serves the pages in ./docs (the players' page and the organizer page).
//   2. Holds the hunt's settings, the hiding spot and the hints, and answers:
//        GET  /api/state      anyone      the settings a player's phone needs,
//                                         plus the hints posted so far.
//                                         The spot is never included, only
//                                         whether one is saved and when.
//        POST /api/direction  anyone      "I am at this position: which way is
//                                         the turkey?" Answered only while the
//                                         compass is live. The reply is a
//                                         direction, never the spot. The
//                                         position is used for the sum and
//                                         then forgotten; nothing is stored
//                                         or logged.
//        GET  /api/photo/ID   anyone      the photo that goes with a hint.
//        GET  /api/admin      organizer   every setting, spot included.
//        POST /api/admin      organizer   change settings.
//        POST /api/admin/hints            organizer   post a hint: the text in
//                                         the X-Hint-Text header, a JPEG photo
//                                         (optional) as the body.
//        DELETE /api/admin/hints/ID       organizer   take a hint down.
//      The organizer proves who they are with a passcode, stored on
//      Cloudflare as the secret ADMIN_KEY (never in this code).

import { DurableObject } from "cloudflare:workers";

const DEFAULTS = {
  name: "The Turkey Hunt",
  target: null,          // { lat, lon } or null for "no spot yet"
  spotAt: null,          // when the spot was saved (set here, never by the organizer page)
  start: null,
  end: null,             // null: the hunt runs until the organizer ends it
  everyMinutes: 30,
  liveSeconds: 30,
  direction: "general",  // or "exact"
  alwaysOn: false,
  testMode: true,        // rehearsal mode: the compass answers at any time
};
const GRACE_MS = 1500;    // a phone whose clock runs a touch fast can ask this early
const MAX_ASKS = 60;      // direction requests allowed per address...
const ASK_WINDOW_MS = 30000;  // ...in this long. A speed bump against scripted guessing.
const MAX_HINTS = 40;
const MAX_HINT_TEXT = 500;
const MAX_PHOTO_BYTES = 3000000;   // the organizer page shrinks photos to well under this

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rad = d => d * Math.PI / 180;

// Is the compass answering right now?
//
// The compass clock starts when the spot is saved: the first window opens one
// full gap (everyMinutes) after that, and never before the hunt's start. From
// then on there is a window every everyMinutes. Settings saved before this
// rule existed have no spotAt, and count from the start as they always did.
function compassIsOpen(s, now) {
  if (!s.target) return false;
  if (s.testMode) return true;
  const start = Date.parse(s.start);
  const end = s.end ? Date.parse(s.end) : Infinity;
  if (!(start < end) || now >= end || now < start - GRACE_MS) return false;
  if (s.alwaysOn) return true;
  const cycle = s.everyMinutes * 60000, live = s.liveSeconds * 1000;
  const first = Number.isFinite(s.spotAt) ? Math.max(start, s.spotAt + cycle) : start;
  if (now < first - GRACE_MS) return false;                    // the first window hasn't come round yet
  const into = (((now - first) % cycle) + cycle) % cycle;      // time since the last window opened
  if (now >= first && into < live) return true;                // a window is open
  const nextOpens = now - into + cycle;
  return nextOpens < end && nextOpens - now <= GRACE_MS;       // about to open
}

// Compass bearing in degrees from one point to another.
function bearingDeg(from, to) {
  const p1 = rad(from.lat), p2 = rad(to.lat), dl = rad(to.lon - from.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// A phone camera saves where the photo was taken inside the photo itself, which
// would give a hiding spot away. The organizer page already redraws every photo
// before sending it, which leaves that out. This is the second lock: walk the
// JPEG piece by piece, keep only the picture, and drop every piece that can
// carry camera data (EXIF with GPS, XMP, IPTC, comments) plus anything tacked on
// after the end of the picture. Returns the clean bytes and the picture's size,
// or null if this is not a JPEG.
function cleanJpeg(u8) {
  const n = u8.length;
  if (n < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  const keep = [[0, 2]];
  let i = 2, w = 0, h = 0, scans = 0, ended = false;
  while (!ended) {
    if (i + 1 >= n || u8[i] !== 0xFF) return null;
    let m = u8[i + 1];
    while (m === 0xFF) { i++; if (i + 1 >= n) return null; m = u8[i + 1]; }   // padding between pieces
    if (m === 0xD9) { keep.push([i, i + 2]); ended = true; break; }           // end of the picture
    if (m === 0x00 || m === 0xD8) return null;
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { keep.push([i, i + 2]); i += 2; continue; }
    if (i + 3 >= n) return null;
    const len = (u8[i + 2] << 8) | u8[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > n) return null;

    const sizeHeader = m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
    if (sizeHeader && len >= 7 && !w) { h = (u8[i + 5] << 8) | u8[i + 6]; w = (u8[i + 7] << 8) | u8[i + 8]; }

    if (m === 0xDA) {
      // A scan: its header, then the compressed picture up to the next real marker.
      scans++;
      let j = end;
      for (;;) {
        j = u8.indexOf(0xFF, j);
        if (j < 0 || j + 1 >= n) return null;
        const x = u8[j + 1];
        if (x === 0x00 || (x >= 0xD0 && x <= 0xD7)) { j += 2; continue; }   // still picture data
        if (x === 0xFF) { j += 1; continue; }
        break;
      }
      keep.push([i, j]);
      i = j;
      continue;
    }

    // APP2 is kept only when it is a colour profile; APP14 tells a viewer how the colours are stored.
    const colourProfile = m === 0xE2 && len >= 14 &&
      String.fromCharCode(...u8.subarray(i + 4, i + 15)) === "ICC_PROFILE";
    const cameraData = (m >= 0xE1 && m <= 0xEF && m !== 0xEE && !colourProfile) || m === 0xFE;
    if (!cameraData) keep.push([i, end]);
    i = end;
  }
  if (!w || !h || !scans) return null;
  const size = keep.reduce((sum, [a, b]) => sum + (b - a), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const [a, b] of keep) { out.set(u8.subarray(a, b), at); at += b - a; }
  return { bytes: out, w, h };
}

// One tiny always-consistent store for the settings, the hints and their photos.
export class Hunt extends DurableObject {
  async read() {
    const stored = await this.ctx.storage.get("settings");
    return Object.assign({ v: 0 }, DEFAULTS, stored || {});
  }

  async write(changes) {
    const current = await this.read();
    const now = Date.now();
    const next = Object.assign({}, current, changes, { v: (current.v || 0) + 1, updated: now });
    // The compass clock: stamped when a spot is saved where there was none,
    // kept when the spot is moved, cleared when the spot is taken away.
    next.spotAt = !next.target ? null : current.target ? (current.spotAt ?? null) : now;
    await this.ctx.storage.put("settings", next);
    return next;
  }

  async hints() {
    return (await this.ctx.storage.get("hints")) || [];
  }

  // Everything a player's phone may see, in one go.
  async view() {
    return { settings: await this.read(), hints: await this.hints() };
  }

  // Post a hint: text, a photo, or both. Oldest first in the list.
  async addHint(text, photo, now) {
    const list = await this.hints();
    if (list.length >= MAX_HINTS) return { error: "full" };
    const hint = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), text, at: now };
    if (photo) {
      const clean = cleanJpeg(new Uint8Array(photo));
      if (!clean) return { error: "notphoto" };
      await this.ctx.storage.put("photo:" + hint.id, clean.bytes);
      hint.photo = { w: clean.w, h: clean.h };
    }
    list.push(hint);
    await this.ctx.storage.put("hints", list);
    return { hints: list };
  }

  async removeHint(id) {
    const list = await this.hints();
    const next = list.filter(hint => hint.id !== id);
    if (next.length === list.length) return { error: "missing" };
    await this.ctx.storage.put("hints", next);
    await this.ctx.storage.delete("photo:" + id);
    return { hints: next };
  }

  async photo(id) {
    return (await this.ctx.storage.get("photo:" + id)) || null;
  }

  // Which way is the turkey from here? Returns a direction, never the spot.
  async direction(who, lat, lon, now) {
    const s = await this.read();
    if (!compassIsOpen(s, now)) return { open: false };

    // Count recent requests per address, in memory only.
    this.asks ??= new Map();
    const recent = (this.asks.get(who) || []).filter(t => now - t < ASK_WINDOW_MS);
    if (recent.length >= MAX_ASKS) { this.asks.set(who, recent); return { open: true, slow: true }; }
    recent.push(now);
    this.asks.set(who, recent);
    if (this.asks.size > 5000) this.asks.clear();

    const exact = bearingDeg({ lat, lon }, s.target);
    const bearing = s.direction === "exact" ? Math.round(exact) % 360 : (Math.round(exact / 45) * 45) % 360;
    return { open: true, bearing, mode: s.direction };
  }
}

// Keep only known settings, in sane ranges.
function clean(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  if ("name" in input) out.name = String(input.name || DEFAULTS.name).slice(0, 60);
  if ("target" in input) {
    const t = input.target;
    const lat = t ? Number(t.lat) : NaN, lon = t ? Number(t.lon) : NaN;
    out.target = t && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      ? { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) } : null;
  }
  for (const k of ["start", "end"]) {
    if (k in input) out[k] = input[k] && !Number.isNaN(Date.parse(input[k])) ? new Date(input[k]).toISOString() : null;
  }
  if ("everyMinutes" in input) out.everyMinutes = clamp(Math.round(Number(input.everyMinutes)) || 30, 1, 180);
  if ("liveSeconds" in input) out.liveSeconds = clamp(Math.round(Number(input.liveSeconds)) || 30, 5, 900);
  if ("direction" in input) out.direction = input.direction === "exact" ? "exact" : "general";
  if ("alwaysOn" in input) out.alwaysOn = !!input.alwaysOn;
  if ("testMode" in input) out.testMode = !!input.testMode;
  return out;
}

// What anyone may see: every setting except the spot, plus the hints.
function publicState(s, hints, now) {
  const { target, ...rest } = s;
  return { ...rest, now, hasSpot: !!target, hints };
}

// Compare the passcode without leaking how much of it matched.
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    const hunt = env.HUNT.getByName ? env.HUNT.getByName("hunt") : env.HUNT.get(env.HUNT.idFromName("hunt"));

    if (path === "/api/state" && request.method === "GET") {
      const { settings, hints } = await hunt.view();
      return json(publicState(settings, hints, Date.now()));
    }

    if (path === "/api/direction" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "That request couldn't be read." }, 400); }
      const lat = Number(body && body.lat), lon = Number(body && body.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: "A position is needed." }, 400);
      }
      const who = request.headers.get("cf-connecting-ip") || "unknown";
      return json(await hunt.direction(who, lat, lon, Date.now()));
    }

    // A hint's photo. The address is random and the picture never changes, so phones may keep it.
    if (path.startsWith("/api/photo/") && request.method === "GET") {
      const id = path.slice("/api/photo/".length);
      const bytes = /^[a-f0-9]{16}$/.test(id) ? await hunt.photo(id) : null;
      if (!bytes) return json({ error: "Not found." }, 404);
      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (path === "/api/admin" || path.startsWith("/api/admin/")) {
      if (!env.ADMIN_KEY) return json({ error: "No organizer passcode has been set on the server yet." }, 503);
      const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!given || !(await sameText(given, env.ADMIN_KEY))) {
        await new Promise(r => setTimeout(r, 400));   // slows down guessing
        return json({ error: "Wrong passcode." }, 401);
      }

      if (path === "/api/admin" && request.method === "GET") return json(await hunt.read());
      if (path === "/api/admin" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: "That request couldn't be read." }, 400); }
        return json(await hunt.write(clean(body)));
      }

      if (path === "/api/admin/hints" && request.method === "POST") {
        let text = "";
        try { text = decodeURIComponent(request.headers.get("x-hint-text") || ""); } catch (e) { /* unreadable text: treat as none */ }
        text = text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_HINT_TEXT);
        const sent = Number(request.headers.get("content-length") || 0);
        if (sent > MAX_PHOTO_BYTES) return json({ error: "That photo is too big." }, 413);
        const body = await request.arrayBuffer();
        if (body.byteLength > MAX_PHOTO_BYTES) return json({ error: "That photo is too big." }, 413);
        const photo = body.byteLength ? body : null;
        if (!text && !photo) return json({ error: "A hint needs some text or a photo." }, 400);
        const result = await hunt.addHint(text, photo, Date.now());
        if (result.error === "full") return json({ error: `There are already ${MAX_HINTS} hints. Take one down first.` }, 409);
        if (result.error === "notphoto") return json({ error: "That file isn't a photo this server can read." }, 400);
        return json(result);
      }

      if (path.startsWith("/api/admin/hints/") && request.method === "DELETE") {
        const result = await hunt.removeHint(path.slice("/api/admin/hints/".length));
        if (result.error) return json({ error: "That hint is already gone." }, 404);
        return json(result);
      }
    }

    return json({ error: "Not found." }, 404);
  },
};
