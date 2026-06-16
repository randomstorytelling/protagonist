/* tasks-feed.js — hands-off Google Tasks -> PRIVATE Firestore.
 *
 * Pulls lawhitaker21's recently-COMPLETED Google Tasks and credits each into the user's cloud game
 * state: the title is classified into a dimension by the engine (kind:"task" -> classifyActivity,
 * e.g. "call mom"->family, "send invoices"->financial), capped at 30xp, deduped by task id. The
 * signed-in app's onSnapshot + mergeStates pick it up within ~1s.
 *
 *   PROTAG_UID=<uid> node tasks-feed.js [completedSinceDays=14]
 *
 * Tasks auth: ~/.config/google-tasks/{client.json,tokens.json} (one-time tasks-auth flow; tasks.readonly).
 * Firestore write: reuses whoop-feed.js (owner Firebase CLI login -> REST, server context bypasses rules).
 * No data is published anywhere public.
 */
"use strict";
var fs = require("fs"), os = require("os"), path = require("path");
var E = require("./engine.js");
var FB = require("./whoop-feed.js");   // accessToken/getDoc/setDoc — Firestore via the owner login

var GT_DIR = path.join(os.homedir(), ".config", "google-tasks");
var DAYS = parseInt(process.argv[2] || "14", 10);

async function tasksAccessToken() {
  var cli = JSON.parse(fs.readFileSync(path.join(GT_DIR, "client.json"), "utf8"));
  var tok = JSON.parse(fs.readFileSync(path.join(GT_DIR, "tokens.json"), "utf8"));
  if (!tok.refresh_token) throw new Error("no Google Tasks refresh_token; re-run the tasks-auth flow");
  var b = new URLSearchParams({ client_id: cli.client_id, client_secret: cli.client_secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" });
  var r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b.toString() });
  if (!r.ok) throw new Error("tasks token refresh failed " + r.status + ": " + (await r.text()));
  return (await r.json()).access_token;
}
async function gapi(token, url) {
  var r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("tasks api " + r.status + ": " + (await r.text()));
  return r.json();
}

(async function () {
  var token = await tasksAccessToken();
  var lists = (await gapi(token, "https://tasks.googleapis.com/tasks/v1/users/@me/lists")).items || [];
  var since = new Date(Date.now() - DAYS * 86400000).toISOString();
  var acts = [];
  for (var i = 0; i < lists.length; i++) {
    var url = "https://tasks.googleapis.com/tasks/v1/lists/" + lists[i].id +
      "/tasks?showCompleted=true&showHidden=true&completedMin=" + encodeURIComponent(since) + "&maxResults=100";
    var items = (await gapi(token, url)).items || [];
    items.forEach(function (t) {
      if (t.status !== "completed" || !t.title) return;
      acts.push({ kind: "task", id: "gt:" + t.id, title: t.title, source: "google_tasks" });  // gt: prefix -> stable dedup key
    });
  }
  if (!acts.length) { console.log("no completed Google Tasks in the last " + DAYS + "d"); return; }

  var fbTok = await FB.accessToken();
  // concurrency-safe read->ingest->write (precondition + retry), so a simultaneous app write isn't clobbered
  var r = await FB.commitIngest(fbTok, function (state) { return E.ingestExternal(state, acts, new Date()); });
  if (!r.credited.length) { console.log("found " + acts.length + " completed task(s); all already credited (deduped)"); return; }
  console.log("credited " + r.credited.length + " of " + acts.length + " completed Google Task(s) to Firestore:");
  r.credited.forEach(function (c) { console.log("  +" + c.xp + " " + c.dim + "  \"" + (c.name || "") + "\""); });
})().catch(function (e) { console.error("FAILED: " + ((e && e.message) || e)); process.exit(1); });
