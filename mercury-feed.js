/* mercury-feed.js — hands-off REAL PAYOUTS from Mercury -> PRIVATE Firestore (the headline revenue signal).
 *
 * Pulls recent Mercury DEPOSITS, keeps ONLY sales-channel payouts (Amazon / Target / Shopify / TikTok / Walmart /
 * Faire), tags each by channel, and credits a deduped kind:"payout" into the user's cloud game state (payoutsByDay
 * + Financial XP -> drives the Power Level). NON-channel deposits (loans, transfers, refunds, owner draws) are
 * ignored on purpose — "via payouts, not everything else". Re-runs are no-ops (deduped by the Mercury txn id).
 *
 *   PROTAG_UID=<uid> MERCURY_TOKEN=<read-only API token> node mercury-feed.js [limit=500]
 *
 * Auth: Mercury API token (read-only) via MERCURY_TOKEN; Firestore write via whoop-feed.js (owner login).
 */
"use strict";
var E = require("./engine.js");
var FB = require("./whoop-feed.js");

var TOKEN = process.env.MERCURY_TOKEN || "";
var LIMIT = Math.max(1, parseInt(process.argv[2] || "500", 10));
var BASE = "https://api.mercury.com/api/v1";

function num(x) { return (typeof x === "number" && isFinite(x)) ? x : (parseFloat(x) || 0); }

// classify a Mercury deposit (by counterparty / description) into a sales channel, or null to skip it
var CHANNELS = [
  { ch: "amazon", re: /amazon|amzn/i },
  { ch: "target", re: /target/i },
  { ch: "shopify", re: /shopify|shop pay|shoppay/i },
  { ch: "tiktok", re: /tiktok|tik tok|bytedance/i },
  { ch: "walmart", re: /walmart|wal-?mart/i },
  { ch: "faire", re: /faire/i },
];
function channelOf(text) {
  var t = String(text || "");
  for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].re.test(t)) return CHANNELS[i].ch;
  return null;
}
async function mapi(path) {
  var r = await fetch(BASE + path, { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } });
  if (!r.ok) throw new Error("mercury api " + r.status + " " + path + ": " + (await r.text()).slice(0, 200));
  return r.json();
}

(async function () {
  if (!TOKEN) { console.log("MERCURY_TOKEN not set — skipping (add it to run the payout feed)"); return; }
  var accts = (await mapi("/accounts")).accounts || [];
  var acts = [];
  for (var i = 0; i < accts.length; i++) {
    var txns = (await mapi("/account/" + accts[i].id + "/transactions?limit=" + LIMIT)).transactions || [];
    txns.forEach(function (t) {
      if (!t || t.status === "failed" || t.status === "cancelled") return;
      var amt = num(t.amount);
      if (!(amt > 0)) return;   // deposits only (Mercury credits are positive)
      var ch = channelOf((t.counterpartyName || "") + " " + (t.bankDescription || "") + " " + (t.note || "") + " " + (t.externalMemo || ""));
      if (!ch) return;          // only recognized sales-channel payouts — everything else is skipped on purpose
      acts.push({ kind: "payout", id: "merc:" + t.id, channel: ch, amount: Math.round(amt * 100) / 100, source: "mercury" });
    });
  }
  if (!acts.length) { console.log("no sales-channel payouts in the recent window"); return; }
  var fbTok = await FB.accessToken();
  var res = await FB.commitIngest(fbTok, function (state) { return E.ingestExternal(state, acts, new Date()); });
  if (!res.credited.length) { console.log("found " + acts.length + " payout(s); all already credited (deduped)"); return; }
  console.log("credited " + res.credited.length + " of " + acts.length + " Mercury payout(s):");
  res.credited.forEach(function (c) { console.log("  +" + c.xp + " " + c.dim + "  \"" + (c.name || "") + "\""); });
})().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
