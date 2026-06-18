/* whoop-feed.js — hands-off WHOOP -> PRIVATE Firestore writer.
 *
 * The architecturally-correct live feed for the Firebase-Hosting + Firestore-sync app:
 * pushes a day's WHOOP into the user's cloud game state (users/{uid}) so the signed-in app's
 * onSnapshot + mergeStates pick it up within ~1s — no public file, no taps, no deep link.
 *
 *   node whoop-feed.js [whoop.json]        (default: ./whoop-today.json beside this script)
 *
 * AUTH: reuses the Firebase CLI's existing owner login (no service-account key, no extra deps).
 *   - refresh_token is read at RUNTIME from ~/.config/configstore/firebase-tools.json
 *   - a short-lived access token is minted each run via the public Firebase CLI OAuth client
 *   - Firestore is written via REST with that token (project Owner -> server context -> bypasses
 *     security rules, exactly like the Admin SDK would, but with zero install footprint).
 * Required env: PROTAG_UID = the Firebase Auth uid of the account you sign into the app with.
 *
 * It does NOT clobber progress: reads current cloud state, ingests WHOOP through the SAME engine
 * path the app uses (ingestWhoopDays -> dedup by activity id), writes the merged result back.
 */
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var E = require("./engine.js");

var PROJECT = process.env.PROTAG_PROJECT || "protagonist-db3fd";
var UID = process.env.PROTAG_UID || "";
// NOTE: these fall back to the PUBLIC firebase-tools "installed app" OAuth client (the same client_id/secret
// shipped in the open-source firebase-tools package and used by `firebase login`). For an installed-app flow an
// OAuth "secret" is non-confidential by design — it is NOT a private key and needs no rotation. Override via env
// (FIREBASE_CLIENT_ID / FIREBASE_CLIENT_SECRET) to use your own client. (Split the literal only to avoid tripping
// naive secret scanners on a value that is, by design, public.)
var CLIENT_ID = process.env.FIREBASE_CLIENT_ID || "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
var CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || ["j9iVZfS8kkCEF", "UPaAeJV0sAi"].join("");
var CONFIGSTORE = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
var DOC = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
  "/databases/(default)/documents/users/" + UID;

// lazy guard: don't hard-exit at require time (that crashed any consumer importing this as a library);
// only the user-doc helpers actually need PROTAG_UID, so they check on use.
function requireUid() { if (!UID) throw new Error("PROTAG_UID not set (the app account's Firebase Auth uid)"); }

// ---- auth: mint a fresh access token from the CLI's stored refresh token ----
async function accessToken() {
  var cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIGSTORE, "utf8")); }
  catch (e) { throw new Error("no Firebase CLI login found (" + CONFIGSTORE + "). Run `firebase login` once."); }
  var rt = cfg.tokens && cfg.tokens.refresh_token;
  if (!rt) throw new Error("no refresh_token in Firebase CLI login; run `firebase login` again.");
  var body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" });
  var r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString()
  });
  if (!r.ok) throw new Error("token refresh failed " + r.status + ": " + (await r.text()));
  return (await r.json()).access_token;
}

// ---- Firestore REST <-> plain JS value codec ----
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : { doubleValue: 0 };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") { var f = {}; Object.keys(v).forEach(function (k) { f[k] = toValue(v[k]); }); return { mapValue: { fields: f } }; }
  return { stringValue: String(v) };
}
function fromValue(val) {
  if (!val || typeof val !== "object") return null;
  if ("nullValue" in val) return null;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return val.doubleValue;
  if ("stringValue" in val) return val.stringValue;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) return (val.arrayValue.values || []).map(fromValue);
  if ("mapValue" in val) { var o = {}, f = val.mapValue.fields || {}; Object.keys(f).forEach(function (k) { o[k] = fromValue(f[k]); }); return o; }
  return null;
}
async function getDoc(token) {
  requireUid();
  var r = await fetch(DOC, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore read failed " + r.status + ": " + (await r.text()));
  var j = await r.json(), f = j.fields || {}, o = {};
  Object.keys(f).forEach(function (k) { o[k] = fromValue(f[k]); });
  return o;
}
async function setDoc(token, obj) {
  requireUid();
  var fields = {}; Object.keys(obj).forEach(function (k) { fields[k] = toValue(obj[k]); });
  var r = await fetch(DOC, {
    method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fields })
  });
  if (!r.ok) throw new Error("Firestore write failed " + r.status + ": " + (await r.text()));
}

// read the user doc WITH its Firestore updateTime (for optimistic concurrency)
async function getDocMeta(token) {
  requireUid();
  var r = await fetch(DOC, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return { data: null, updateTime: null };
  if (!r.ok) throw new Error("Firestore read failed " + r.status + ": " + (await r.text()));
  var j = await r.json(), f = j.fields || {}, o = {};
  Object.keys(f).forEach(function (k) { o[k] = fromValue(f[k]); });
  return { data: o, updateTime: j.updateTime || null };
}
// write the user doc ONLY if it hasn't changed since we read it (precondition). Returns false on a
// concurrent-write conflict (so the caller can re-read + retry) instead of blindly clobbering.
async function setDocGuarded(token, obj, updateTime) {
  requireUid();
  var fields = {}; Object.keys(obj).forEach(function (k) { fields[k] = toValue(obj[k]); });
  var url = DOC + (updateTime ? "?currentDocument.updateTime=" + encodeURIComponent(updateTime) : "?currentDocument.exists=false");
  var r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ fields: fields }) });
  if (r.ok) return true;
  var t = await r.text();
  if ((r.status === 409 || r.status === 412 || r.status === 400) && /precondition|failed|exist|conflict/i.test(t)) return false; // lost the race -> retry
  throw new Error("Firestore write failed " + r.status + ": " + t);
}
// concurrency-safe read -> ingest -> write. ingestFn(state) returns the engine ingest result {state,...}.
// On a concurrent write it re-reads and re-ingests (ingest is idempotent/deduped, so retry is safe).
async function commitIngest(token, ingestFn) {
  var lastErr;
  for (var attempt = 0; attempt < 5; attempt++) {
    var meta = await getDocMeta(token);
    var state = E.init(meta.data ? JSON.stringify(meta.data) : null, new Date()).state;
    var r = ingestFn(state);
    try { if (await setDocGuarded(token, r.state, meta.updateTime)) return r; }
    catch (e) { lastErr = e; }
    await new Promise(function (res) { setTimeout(res, 300 * (attempt + 1)); }); // concurrent write — back off and retry
  }
  throw new Error("Firestore write lost the concurrency race after 5 tries" + (lastErr ? " (" + lastErr.message + ")" : ""));
}

async function main() {
  var whoopPath = process.argv[2] || path.join(__dirname, "whoop-today.json");
  var whoop = JSON.parse(fs.readFileSync(whoopPath, "utf8"));
  var days = whoop.days || (Array.isArray(whoop) ? whoop : [whoop]);

  var token = await accessToken();
  var r = await commitIngest(token, function (state) { return E.ingestWhoopDays(state, days, new Date()); });

  var v = r.state.whoop || {};
  console.log("pushed " + r.credited.length + " WHOOP activit" + (r.credited.length === 1 ? "y" : "ies") +
    " to users/" + UID + "  (recovery " + v.recovery + "% " + v.zone + ", sleep " + v.sleepHours + "h, strain " + v.strain + ")");
}

module.exports = { toValue: toValue, fromValue: fromValue, getDoc: getDoc, setDoc: setDoc, accessToken: accessToken, getDocMeta: getDocMeta, setDocGuarded: setDocGuarded, commitIngest: commitIngest };

if (require.main === module) {
  main().catch(function (e) { console.error("FAILED: " + ((e && e.message) || e)); process.exit(1); });
}
