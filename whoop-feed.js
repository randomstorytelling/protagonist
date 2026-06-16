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
var CLIENT_ID = process.env.FIREBASE_CLIENT_ID || "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
var CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";
var CONFIGSTORE = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
var DOC = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
  "/databases/(default)/documents/users/" + UID;

if (!UID) { console.error("FAILED: set PROTAG_UID (the app account's Firebase Auth uid)"); process.exit(2); }

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
  var r = await fetch(DOC, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore read failed " + r.status + ": " + (await r.text()));
  var j = await r.json(), f = j.fields || {}, o = {};
  Object.keys(f).forEach(function (k) { o[k] = fromValue(f[k]); });
  return o;
}
async function setDoc(token, obj) {
  var fields = {}; Object.keys(obj).forEach(function (k) { fields[k] = toValue(obj[k]); });
  var r = await fetch(DOC, {
    method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fields })
  });
  if (!r.ok) throw new Error("Firestore write failed " + r.status + ": " + (await r.text()));
}

async function main() {
  var whoopPath = process.argv[2] || path.join(__dirname, "whoop-today.json");
  var whoop = JSON.parse(fs.readFileSync(whoopPath, "utf8"));
  var days = whoop.days || (Array.isArray(whoop) ? whoop : [whoop]);

  var token = await accessToken();
  var current = await getDoc(token);
  var state = E.init(current ? JSON.stringify(current) : null, new Date()).state;
  var r = E.ingestWhoopDays(state, days, new Date());
  await setDoc(token, r.state);

  var v = r.state.whoop || {};
  console.log("pushed " + r.credited.length + " WHOOP activit" + (r.credited.length === 1 ? "y" : "ies") +
    " to users/" + UID + "  (recovery " + v.recovery + "% " + v.zone + ", sleep " + v.sleepHours + "h, strain " + v.strain + ")");
}

module.exports = { toValue: toValue, fromValue: fromValue, getDoc: getDoc, setDoc: setDoc, accessToken: accessToken };

if (require.main === module) {
  main().catch(function (e) { console.error("FAILED: " + ((e && e.message) || e)); process.exit(1); });
}
