// The Turkey Hunt's small server (a Cloudflare Worker).
//
// It does two jobs:
//   1. Serves the pages in ./docs (the players' page and the organizer page).
//   2. Holds the hunt's settings, including the hiding spot, and answers:
//        GET  /api/state   anyone      the settings a player's phone needs.
//                                      The spot is only included while the
//                                      compass is live (or in test mode).
//        GET  /api/admin   organizer   every setting, spot included.
//        POST /api/admin   organizer   change settings.
//      The organizer proves who they are with a passcode, stored on
//      Cloudflare as the secret ADMIN_KEY (never in this code).

import { DurableObject } from "cloudflare:workers";

const DEFAULTS = {
  name: "The Turkey Hunt",
  target: null,          // { lat, lon } or null for "no spot yet"
  start: null,
  end: null,
  everyMinutes: 30,
  liveSeconds: 30,
  direction: "general",  // or "exact"
  alwaysOn: false,
  testMode: true,
};
const WARMUP_MS = 45000;  // phones get the spot this long before a window, so the needle is ready when it opens

// One tiny always-consistent store for the settings.
export class Hunt extends DurableObject {
  async read() {
    const stored = await this.ctx.storage.get("settings");
    return Object.assign({ v: 0 }, DEFAULTS, stored || {});
  }
  async write(changes) {
    const current = await this.read();
    const next = Object.assign({}, current, changes, { v: (current.v || 0) + 1, updated: Date.now() });
    await this.ctx.storage.put("settings", next);
    return next;
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

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

// Should phones be given the spot right now?
function spotIsOpen(s, now) {
  if (!s.target) return false;
  if (s.testMode) return true;
  const start = Date.parse(s.start);
  const end = s.end ? Date.parse(s.end) : Infinity;   // no end time: the hunt runs until the organizer ends it
  if (!(start < end) || now >= end || now < start - WARMUP_MS) return false;
  if (s.alwaysOn) return true;
  const cycle = s.everyMinutes * 60000, live = s.liveSeconds * 1000;
  const into = (((now - start) % cycle) + cycle) % cycle;      // time since the last window opened
  if (now >= start && into < live) return true;                // a window is open
  const nextOpens = now - into + cycle;
  return nextOpens < end && nextOpens - now <= WARMUP_MS;      // the warm-up before a window
}

function publicState(s, now) {
  const { target, ...rest } = s;
  return { ...rest, now, hasSpot: !!target, target: spotIsOpen(s, now) ? target : null };
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
      return json(publicState(await hunt.read(), Date.now()));
    }

    if (path === "/api/admin" && (request.method === "GET" || request.method === "POST")) {
      if (!env.ADMIN_KEY) return json({ error: "No organizer passcode has been set on the server yet." }, 503);
      const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!given || !(await sameText(given, env.ADMIN_KEY))) {
        await new Promise(r => setTimeout(r, 400));   // slows down guessing
        return json({ error: "Wrong passcode." }, 401);
      }
      if (request.method === "GET") return json(await hunt.read());
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "That request couldn't be read." }, 400); }
      return json(await hunt.write(clean(body)));
    }

    return json({ error: "Not found." }, 404);
  },
};
