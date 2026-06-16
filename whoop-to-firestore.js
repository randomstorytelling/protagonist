/* WHOOP -> Firestore: the live-feed writer.
 *
 * Pushes a day's WHOOP into the user's cloud game state so the deployed PWA picks it up LIVE
 * (its onSnapshot listener + mergeStates fire within ~1s — no taps, no deep link, no public file).
 *
 * It does NOT clobber progress: it reads the current cloud state, ingests WHOOP through the SAME
 * engine path the app uses (ingestWhoopDays -> dedup by activity id), and writes the result back.
 * The app then MERGES it (monotonic union), so app edits and feed writes always converge.
 *
 *   node whoop-to-firestore.js <service-account.json> <whoop.json> [email]
 *
 * - <service-account.json>  Firebase Admin key (Project Settings -> Service accounts -> Generate key).
 *                           Keep it OUTSIDE iCloud/git, e.g. ~/.protagonist/sa.json
 * - <whoop.json>            a WHOOP-day payload ({days:[…]} or one day) — same shape as whoop-today.json
 * - [email]                 the Google/email you sign into the app with (default lawhitaker21@gmail.com)
 *
 * Admin SDK bypasses Firestore security rules, so this works even though the rules lock the doc to you.
 */
var fs = require("fs");
var E = require("./engine.js");

var saPath = process.argv[2];
var whoopPath = process.argv[3];
var email = process.argv[4] || "lawhitaker21@gmail.com";

if (!saPath || !whoopPath) {
  console.error("usage: node whoop-to-firestore.js <service-account.json> <whoop.json> [email]");
  process.exit(2);
}

var admin;
try { admin = require("firebase-admin"); }
catch (e) { console.error("missing dependency: run `npm install firebase-admin` in this folder first."); process.exit(1); }

var sa, whoop;
try { sa = require(require("path").resolve(saPath)); }
catch (e) { console.error("can't read service-account key at " + saPath + ": " + e.message); process.exit(1); }
try { whoop = JSON.parse(fs.readFileSync(whoopPath, "utf8")); }
catch (e) { console.error("can't read WHOOP json at " + whoopPath + ": " + e.message); process.exit(1); }

var days = whoop.days || (Array.isArray(whoop) ? whoop : [whoop]);

admin.initializeApp({ credential: admin.credential.cert(sa) });
var db = admin.firestore();

(async function () {
  var user = await admin.auth().getUserByEmail(email);          // resolve uid from email — no id to paste
  var ref = db.collection("users").doc(user.uid);
  var snap = await ref.get();
  var current = snap.exists ? snap.data() : null;

  // ingest through the engine: validate/migrate the cloud copy, then credit WHOOP (idempotent, deduped)
  var state = E.init(current ? JSON.stringify(current) : null, new Date()).state;
  var r = E.ingestWhoopDays(state, days, new Date());

  await ref.set(r.state);                                       // app's onSnapshot + mergeStates picks it up live
  var v = r.state.whoop || {};
  console.log("pushed " + r.credited.length + " WHOOP activit" + (r.credited.length === 1 ? "y" : "ies") +
    " to users/" + user.uid + "  (recovery " + v.recovery + "% " + v.zone + ", sleep " + v.sleepHours + "h, strain " + v.strain + ")");
  process.exit(0);
})().catch(function (e) {
  console.error("FAILED: " + ((e && e.message) || e));
  if (e && e.code === "auth/user-not-found") console.error("  -> sign into the app once (so the account exists), then re-run. Or pass the right email as arg 3.");
  process.exit(1);
});
