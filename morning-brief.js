/* morning-brief.js — the autonomous "Game Master" brief. Reads the user's cloud state, computes G.dailyBrief(),
 * and EMAILS a glanceable summary via the Gmail API — so the System comes to YOU and you never have to open the app.
 * (`--dry` prints it instead of sending.) The whole point of autonomy: a 10-second glance, then put the phone down.
 *
 *   PROTAG_UID=<uid> [BRIEF_TO=you@example.com] node morning-brief.js [--dry]
 *
 * Auth: Firestore read via whoop-feed.js (owner login); Gmail send via the same ~/.config/google-tasks Google
 * OAuth credential, which must additionally be granted the `gmail.send` scope (one re-consent; update FEED_CREDS).
 */
"use strict";
var fs = require("fs"), os = require("os"), path = require("path");
var E = require("./engine.js");
var FB = require("./whoop-feed.js");

var G_DIR = path.join(os.homedir(), ".config", "google-tasks");
var TO = process.env.BRIEF_TO || "lawhitaker21@gmail.com";
var DRY = process.argv.indexOf("--dry") !== -1;
var DIM_LABEL = { physical: "Physical", mental: "Mental", spiritual: "Spiritual", family: "Family", social: "Social", financial: "Financial" };

function fmtNum(n) { return Math.round(n).toLocaleString(); }

// PURE: turn a G.dailyBrief() object into a scannable {subject, text}. Exported for testing.
function formatBrief(b, name) {
  var first = String(name || "Lawrence").split(/\s+/)[0];
  var arrow = b.weekChange > 0 ? ("▲ +" + fmtNum(b.weekChange)) : (b.weekChange < 0 ? ("▼ " + fmtNum(Math.abs(b.weekChange))) : "steady");
  var best = b.atBest ? "★ personal best" : ("★ best " + fmtNum(b.peak));
  var zone = b.whoopZone ? (b.whoopZone.charAt(0).toUpperCase() + b.whoopZone.slice(1) + (b.recovery != null ? (" " + b.recovery + "%") : "")) : "no WHOOP yet";
  var coach = b.whoopZone === "green" ? "Recovery's green — today's a day to PUSH."
    : b.whoopZone === "red" ? "Recovery's low — go gentle; rest counts today."
    : b.whoopZone === "yellow" ? "Recovery's moderate — train, keep some in reserve."
    : "Sync WHOOP to tune today's effort.";
  var hit = b.dimsHit.map(function (d) { return DIM_LABEL[d] || d; });
  var quiet = b.dimsQuiet.map(function (d) { return DIM_LABEL[d] || d; });
  var lines = [];
  lines.push("⚡ POWER LEVEL " + fmtNum(b.powerLevel) + " · " + b.tier + "  (" + arrow + " this week · " + best + ")");
  if (b.nextTier) lines.push("   next: " + b.nextTier + " at " + fmtNum(b.nextAt));
  lines.push("");
  lines.push("💰 Vybrance: $" + fmtNum(b.sales7d) + " over the last 7 days");
  lines.push("🔥 Streak: " + b.streak + " day" + (b.streak === 1 ? "" : "s") + "   ·   ⌚ WHOOP: " + zone);
  lines.push("");
  lines.push("Daily Quest: " + b.dailyDone + "/" + b.dailyTotal + (b.dailyMet ? "  ✓ complete" : ""));
  if (hit.length) lines.push("   ✓ done: " + hit.join(", "));
  if (quiet.length) lines.push("   ○ quiet: " + quiet.join(", "));
  lines.push("");
  if (b.topRep) lines.push("🎯 The one rep that matters today:\n   \"" + b.topRep.name + "\"  (" + (DIM_LABEL[b.topRep.dim] || b.topRep.dim) + ", +" + b.topRep.xp + ")");
  lines.push("");
  lines.push(coach);
  lines.push("");
  lines.push("— The System");
  return { subject: "⚡ " + first + " — Power Level " + fmtNum(b.powerLevel) + " (" + b.tier + ")", text: lines.join("\n") };
}

async function googleToken() {
  var cli = JSON.parse(fs.readFileSync(path.join(G_DIR, "client.json"), "utf8"));
  var tok = JSON.parse(fs.readFileSync(path.join(G_DIR, "tokens.json"), "utf8"));
  if (!tok.refresh_token) throw new Error("no Google refresh_token; re-run the auth flow including the gmail.send scope");
  var b = new URLSearchParams({ client_id: cli.client_id, client_secret: cli.client_secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" });
  var r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b.toString() });
  if (!r.ok) throw new Error("google token refresh failed " + r.status + ": " + (await r.text()));
  return (await r.json()).access_token;
}
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function sendGmail(to, subject, text) {
  var token = await googleToken();
  var raw = [
    "To: " + to,
    "Subject: =?UTF-8?B?" + Buffer.from(subject, "utf8").toString("base64") + "?=",   // encoded so emoji survive
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    text,
  ].join("\r\n");
  var r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(Buffer.from(raw, "utf8")) }),
  });
  if (!r.ok) throw new Error("gmail send failed " + r.status + ": " + (await r.text()));
}

async function main() {
  var fbTok = await FB.accessToken();
  var doc = await FB.getDoc(fbTok);
  if (!doc) { console.log("no cloud state yet — nothing to brief"); return; }
  var state = E.init(JSON.stringify(doc), new Date()).state;   // sanitize + reconcile to "now"
  var brief = E.dailyBrief(state, new Date());
  var msg = formatBrief(brief, state.player && state.player.name);
  if (DRY) { console.log("[dry] To: " + TO + "\nSubject: " + msg.subject + "\n\n" + msg.text); return; }
  await sendGmail(TO, msg.subject, msg.text);
  console.log("sent morning brief to " + TO + " (Power Level " + brief.powerLevel + ", " + brief.tier + ")");
}

module.exports = { formatBrief: formatBrief };
if (require.main === module) main().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
