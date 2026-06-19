/* calendar-feed.js — hands-off Google Calendar -> PRIVATE Firestore.
 *
 * Pulls events from the primary calendar that have ALREADY started in the recent window and credits each into the
 * user's cloud game state: the engine classifies the event TITLE into a dimension (kind:"calendar" ->
 * classifyActivity, e.g. "Therapy"->mental, "Gym"->physical, "Lunch with Sam"->social, "Call mom"->family,
 * "Self-tape"->financial). Vague/low-confidence blocks ("Sync meeting", "Busy") are skipped so reps aren't spammed,
 * and a scheduled event NEVER auto-mints a Big Win. Deduped by event id. So just LIVING your scheduled day
 * auto-fills the Daily Quest — no logging.
 *
 *   PROTAG_UID=<uid> node calendar-feed.js [windowDays=1]
 *
 * Auth: reuses ~/.config/google-tasks/{client.json,tokens.json} — the SAME Google OAuth credential as the Tasks
 * feed, which must additionally be granted the `calendar.readonly` scope (one re-consent; update FEED_CREDS).
 * Firestore write: reuses whoop-feed.js (owner login -> REST; concurrency-safe read->ingest->write). Nothing public.
 */
"use strict";
var fs = require("fs"), os = require("os"), path = require("path");
var E = require("./engine.js");
var FB = require("./whoop-feed.js");

var G_DIR = path.join(os.homedir(), ".config", "google-tasks");   // shared Google OAuth credential
var WINDOW_DAYS = Math.max(1, parseInt(process.argv[2] || "1", 10));

async function googleToken() {
  var cli = JSON.parse(fs.readFileSync(path.join(G_DIR, "client.json"), "utf8"));
  var tok = JSON.parse(fs.readFileSync(path.join(G_DIR, "tokens.json"), "utf8"));
  if (!tok.refresh_token) throw new Error("no Google refresh_token; re-run the auth flow including the calendar.readonly scope");
  var b = new URLSearchParams({ client_id: cli.client_id, client_secret: cli.client_secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" });
  var r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b.toString() });
  if (!r.ok) throw new Error("google token refresh failed " + r.status + ": " + (await r.text()));
  return (await r.json()).access_token;
}

(async function () {
  var token = await googleToken();
  var timeMin = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  var timeMax = new Date(Date.now() + 86400000).toISOString();   // include the rest of today; we still gate on "already started"
  var url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime"
    + "&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax) + "&maxResults=250";
  var r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("calendar api " + r.status + ": " + (await r.text()));
  var items = (await r.json()).items || [];

  var now = Date.now(), acts = [];
  items.forEach(function (e) {
    if (!e || !e.summary || e.status === "cancelled") return;
    // only credit events that have ALREADY started (don't pre-credit a future plan you might skip)
    if (e.start && e.start.date && !e.start.dateTime) {
      // all-day events carry a bare YYYY-MM-DD; Date.parse() reads it as UTC midnight, which passes the "started"
      // gate hours BEFORE the local day even begins. Gate on the user's LOCAL calendar day instead (en-CA = ISO).
      var todayYMD = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      if (e.start.date > todayYMD) return;   // all-day event dated for a future local day -> not started yet
    } else {
      var startMs = e.start && e.start.dateTime ? Date.parse(e.start.dateTime) : NaN;
      if (!Number.isFinite(startMs) || startMs > now) return;
    }
    // skip events you declined
    var declined = (e.attendees || []).some(function (a) { return a.self && a.responseStatus === "declined"; });
    if (declined) return;
    acts.push({ kind: "calendar", id: "cal:" + e.id, title: e.summary, source: "calendar" });   // cal: prefix -> stable dedup key
  });
  if (!acts.length) { console.log("no started calendar events in the last " + WINDOW_DAYS + "d window"); return; }

  var fbTok = await FB.accessToken();
  var res = await FB.commitIngest(fbTok, function (state) { return E.ingestExternal(state, acts, new Date()); });
  if (!res.credited.length) { console.log("found " + acts.length + " event(s); all already credited or skipped (deduped / vague)"); return; }
  console.log("credited " + res.credited.length + " of " + acts.length + " calendar event(s):");
  res.credited.forEach(function (c) { console.log("  +" + c.xp + " " + c.dim + "  \"" + (c.name || "") + "\""); });
})().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
