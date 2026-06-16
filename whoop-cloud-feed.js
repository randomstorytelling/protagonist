/* whoop-cloud-feed.js — hands-off WHOOP -> PRIVATE Firestore, runnable in the CLOUD (no Mac, no MCP).
 *
 * Unlike whoop-pull.js (which reads/writes the Mac MCP's token file), this owns a DEDICATED WHOOP
 * authorization whose rotating refresh token lives in Firestore (_feed/whoop), so it survives stateless
 * CI runs and never fights the Mac WHOOP MCP. Flow:
 *   1. read WHOOP token from Firestore _feed/whoop  (Firestore admin via the owner login)
 *   2. refresh the WHOOP access token if near expiry  ->  PERSIST the (possibly rotated) token back
 *      to Firestore IMMEDIATELY, before the pull, so a later failure can never strand a rotated token
 *   3. pull recovery/cycles/sleep/workouts from the WHOOP API (shaping ported verbatim from whoop-pull.js)
 *   4. ingest via the engine (ingestWhoopDays, deduped) -> write users/{uid}
 *
 *   PROTAG_UID=<uid> WHOOP_CLIENT_ID=.. WHOOP_CLIENT_SECRET=.. node whoop-cloud-feed.js
 *
 * Firestore auth reuses whoop-feed.js (owner Firebase CLI login -> REST, server context bypasses rules).
 */
"use strict";
var FB = require("./whoop-feed.js");   // accessToken (owner) + getDoc/setDoc (users/{uid}) + toValue/fromValue
var E = require("./engine.js");

var PROJECT = process.env.PROTAG_PROJECT || "protagonist-db3fd";
var CID = process.env.WHOOP_CLIENT_ID, CSEC = process.env.WHOOP_CLIENT_SECRET;
var WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
var WHOOP_API = "https://api.prod.whoop.com/developer/v2";
var TOKEN_DOC = process.env.WHOOP_TOKEN_DOC || "_feed/whoop";   // private; only the owner token can read it
var DAYS = 3;

// ---- generic Firestore doc read/write (arbitrary path) via the owner token + whoop-feed's codec ----
function fsUrl(p) { return "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents/" + p; }
async function fsGet(ownerTok, p) {
  var r = await fetch(fsUrl(p), { headers: { Authorization: "Bearer " + ownerTok } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore read " + p + " " + r.status + ": " + (await r.text()));
  var j = await r.json(), f = j.fields || {}, o = {};
  Object.keys(f).forEach(function (k) { o[k] = FB.fromValue(f[k]); });
  return o;
}
async function fsSet(ownerTok, p, obj, mask) {
  var fields = {}; Object.keys(obj).forEach(function (k) { fields[k] = FB.toValue(obj[k]); });
  var url = fsUrl(p);
  if (mask && mask.length) url += "?" + mask.map(function (m) { return "updateMask.fieldPaths=" + encodeURIComponent(m); }).join("&"); // preserve other fields
  var r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer " + ownerTok, "Content-Type": "application/json" }, body: JSON.stringify({ fields: fields }) });
  if (!r.ok) throw new Error("Firestore write " + p + " " + r.status + ": " + (await r.text()));
}

// Persisting the ROTATED WHOOP refresh token is the single most important write in this job: WHOOP
// invalidates the old token the instant the refresh returns, so if this write is lost the feed is
// locked out until a human re-consents. Make it durable: bounded retry, with a FRESH owner access
// token each attempt (so an expired owner token can't be the cause). Returns the fresh owner token.
async function persistTokenDurable(tok) {
  var lastErr;
  for (var i = 0; i < 5; i++) {
    try {
      var ot = await FB.accessToken();   // fresh each attempt
      await fsSet(ot, TOKEN_DOC, tok, ["access_token", "refresh_token", "expires_at"]);
      return ot;
    } catch (e) { lastErr = e; await new Promise(function (r) { setTimeout(r, 400 * (i + 1)); }); }
  }
  throw new Error("CRITICAL: could not persist rotated WHOOP token after 5 tries (" + ((lastErr && lastErr.message) || lastErr) + "). Re-seed " + TOKEN_DOC + " via the consent flow.");
}

// ---- WHOOP fetch + day-shaping (ported verbatim from whoop-pull.js) ----
async function whoopApi(token, p) {
  var r = await fetch(WHOOP_API + p, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("WHOOP GET " + p + " -> " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
function localDate(iso, off) {
  var t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  var m = /([+-])(\d\d):(\d\d)/.exec(off || "+00:00");
  var mins = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  var d = new Date(t + mins * 60000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function hrs(ms) { return Math.round((ms / 3600000) * 100) / 100; }
function r1(n) { return Math.round(n * 10) / 10; }
function shapeDays(cyc, rec, slp, wk) {
  var cycleById = {}, cycleDate = {}, days = {};
  function day(d) { if (!days[d]) days[d] = { date: d, workouts: [] }; return days[d]; }
  (cyc.records || []).forEach(function (c) { cycleById[c.id] = c; });
  (rec.records || []).forEach(function (x) {
    var c = cycleById[x.cycle_id], tz = c ? c.timezone_offset : "+00:00";
    var d = localDate(x.created_at, tz); if (!d || !x.score) return;
    cycleDate[x.cycle_id] = d;
    day(d).recovery = { score: Math.round(x.score.recovery_score), hrv: Math.round(x.score.hrv_rmssd_milli || 0), rhr: Math.round(x.score.resting_heart_rate || 0) };
  });
  (cyc.records || []).forEach(function (c) {
    var d = cycleDate[c.id] || localDate(c.end || c.start, c.timezone_offset); if (!d) return;
    cycleDate[c.id] = d;
    if (c.score && c.score.strain != null) day(d).strain = r1(c.score.strain);
  });
  (slp.records || []).forEach(function (s) {
    var d = localDate(s.end, s.timezone_offset) || cycleDate[s.cycle_id]; if (!d || !s.score) return;
    var ss = s.score.stage_summary || {};
    var asleep = (ss.total_light_sleep_time_milli || 0) + (ss.total_slow_wave_sleep_time_milli || 0) + (ss.total_rem_sleep_time_milli || 0);
    day(d).sleep = { id: s.id, hours: hrs(asleep), performance: Math.round(s.score.sleep_performance_percentage || 0) };
  });
  (wk.records || []).forEach(function (w) {
    var d = localDate(w.start, w.timezone_offset); if (!d) return;
    var mins = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000);
    day(d).workouts.push({ id: w.id, sport: w.sport_name || "workout", durationMin: mins, strain: r1((w.score && w.score.strain) || 0) });
  });
  return { days: Object.keys(days).sort().slice(-DAYS).map(function (k) { return days[k]; }) };
}

(async function () {
  var ownerTok = await FB.accessToken();                         // owner -> Firestore admin (read/write any doc)

  // 1. read the dedicated WHOOP token (and client creds) from Firestore
  var tok = await fsGet(ownerTok, TOKEN_DOC);
  if (!tok || !tok.refresh_token) throw new Error("no WHOOP token at Firestore " + TOKEN_DOC + " — seed it once via the consent flow");
  var cid = CID || tok.client_id, csec = CSEC || tok.client_secret;   // env (local) OR the private _feed/whoop doc (cloud)
  if (!cid || !csec) throw new Error("no WHOOP client creds — set WHOOP_CLIENT_ID/SECRET env, or seed client_id/client_secret into " + TOKEN_DOC);

  // 2. refresh if near expiry, and PERSIST the rotated token back BEFORE pulling (atomic: a later
  //    failure can't lose a rotated refresh token and lock us out)
  var now = Math.floor(Date.now() / 1000);
  var access = tok.access_token;
  if (!(tok.expires_at && tok.expires_at > now + 300)) {        // 5-min headroom so a slow pull can't expire mid-run
    var body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: cid, client_secret: csec, scope: "offline" });
    var r = await fetch(WHOOP_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!r.ok) throw new Error("WHOOP token refresh failed " + r.status + " " + (await r.text()));
    var j = await r.json();
    tok = { access_token: j.access_token, refresh_token: j.refresh_token || tok.refresh_token, expires_at: now + (j.expires_in || 3600) };
    ownerTok = await persistTokenDurable(tok);                  // durable persist of the rotated token (retried); also refreshes ownerTok
    access = tok.access_token;
  }

  // 3. pull WHOOP
  var cyc = await whoopApi(access, "/cycle?limit=10");
  var rec = await whoopApi(access, "/recovery?limit=10");
  var slp = await whoopApi(access, "/activity/sleep?limit=10");
  var wk = await whoopApi(access, "/activity/workout?limit=25");
  var payload = shapeDays(cyc, rec, slp, wk);
  if (!payload.days.length) { console.log("WHOOP cloud: no days returned"); return; }

  // 4. ingest into the user's game state (deduped, idempotent) — concurrency-safe (precondition + retry)
  var rr = await FB.commitIngest(ownerTok, function (state) { return E.ingestWhoopDays(state, payload.days, new Date()); });
  var v = rr.state.whoop || {};
  console.log("WHOOP cloud: pushed " + rr.credited.length + " activit" + (rr.credited.length === 1 ? "y" : "ies") +
    "; latest " + (payload.days[payload.days.length - 1] || {}).date + " recovery " + v.recovery + "% " + v.zone + ", sleep " + v.sleepHours + "h, strain " + v.strain);
})().catch(function (e) { console.error("whoop-cloud-feed FAILED: " + ((e && e.message) || e)); process.exit(1); });
