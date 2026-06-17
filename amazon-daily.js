/* amazon-daily.js — credit a single DAY's Vybrance Amazon sales into the cloud game state.
 *
 * Each day's "Ordered product sales" becomes ONE deduped seed:
 *   { source:"amazon", kind:"sale", id:"amzn-day-<YYYY-MM-DD>", amount }
 * Deduped by the day id => idempotent (re-running the same day is a no-op), and it credits Financial XP,
 * which raises both the Power Level (incomeXp) and the overall level (totalXp) — "the xp that comes with it".
 *
 * USAGE
 *   node amazon-daily.js <amountUSD> [YYYY-MM-DD]      # manual / bridge credit (date defaults to today, America/Chicago)
 *   node amazon-daily.js <amountUSD> [date] --dry      # print what it would credit, write nothing
 *   node amazon-daily.js --spapi [YYYY-MM-DD]          # AUTO: pull the day's sales from Amazon SP-API, then credit
 *
 * AUTO (SP-API) path needs creds in Firestore _feed/amazon:
 *   { refresh_token, client_id, client_secret, marketplace_id }   (marketplace_id defaults to US: ATVPDKIKX0DER)
 * Firestore write reuses the owner login via whoop-feed.js (commitIngest). PROTAG_UID must be set.
 */
"use strict";
var FB = require("./whoop-feed.js");   // accessToken + commitIngest (owner -> Firestore)
var E = require("./engine.js");

var PROJECT = process.env.PROTAG_PROJECT || "protagonist-db3fd";
var AMZ_DOC = process.env.AMAZON_FEED_DOC || "_feed/amazon";
var US_MARKETPLACE = "ATVPDKIKX0DER";

// America/Chicago calendar date for a given instant (handles CST/CDT via the IANA zone)
function chicagoYMD(d) {
  var p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
  return o.year + "-" + o.month + "-" + o.day;
}
function chicagoOffset(ymd) {
  // -05:00 during CDT (Mar–Nov), -06:00 during CST. Derive from the date itself.
  var d = new Date(ymd + "T12:00:00Z");
  var s = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(d).find(function (x) { return x.type === "timeZoneName"; });
  var m = /GMT([+-]\d{1,2})/.exec((s && s.value) || "GMT-6");
  var hr = m ? Math.abs(parseInt(m[1], 10)) : 6;
  return "-" + String(hr).padStart(2, "0") + ":00";
}

// ---- SP-API: LWA token -> Sales orderMetrics for one Chicago day ----
async function spapiDaySales(date) {
  var ownerTok = await FB.accessToken();
  var fsUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents/" + AMZ_DOC;
  var r = await fetch(fsUrl, { headers: { Authorization: "Bearer " + ownerTok } });
  if (r.status === 404) return null;   // not configured yet -> caller skips gracefully (green no-op cron)
  if (!r.ok) throw new Error("could not read " + AMZ_DOC + " (" + r.status + "): " + (await r.text()));
  var f = (await r.json()).fields || {}, cred = {}; Object.keys(f).forEach(function (k) { cred[k] = FB.fromValue(f[k]); });
  if (!cred.refresh_token || !cred.client_id || !cred.client_secret) throw new Error("incomplete SP-API creds in " + AMZ_DOC);
  // LWA access token
  var body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh_token, client_id: cred.client_id, client_secret: cred.client_secret });
  var tr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!tr.ok) throw new Error("LWA token failed " + tr.status + ": " + (await tr.text()));
  var access = (await tr.json()).access_token;
  // Sales orderMetrics for the single Chicago day
  var off = chicagoOffset(date);
  var next = chicagoYMD(new Date(new Date(date + "T12:00:00" + off).getTime() + 86400000));
  var interval = encodeURIComponent(date + "T00:00:00" + off + "--" + next + "T00:00:00" + off);
  var mp = cred.marketplace_id || US_MARKETPLACE;
  var url = "https://sellingpartnerapi-na.amazon.com/sales/v1/orderMetrics?marketplaceIds=" + mp + "&interval=" + interval + "&granularity=Day";
  var sr = await fetch(url, { headers: { "x-amz-access-token": access } });
  if (!sr.ok) throw new Error("SP-API orderMetrics failed " + sr.status + ": " + (await sr.text()));
  var pl = (await sr.json()).payload || [];
  var total = pl.reduce(function (a, m) { return a + (+(m.totalSales && m.totalSales.amount) || 0); }, 0);
  return Math.round(total * 100) / 100;
}

(async function () {
  var args = process.argv.slice(2);
  var dry = args.indexOf("--dry") !== -1; args = args.filter(function (a) { return a !== "--dry"; });
  var spapi = args.indexOf("--spapi") !== -1; args = args.filter(function (a) { return a !== "--spapi"; });

  // default to the Central day that is ending: now-2h, so a cron that lags a bit past midnight (or DST drift)
  // still attributes to the correct just-ended day rather than the fresh empty one.
  var date = (args.find && args.find(function (a) { return /^\d{4}-\d{2}-\d{2}$/.test(a); })) || chicagoYMD(new Date(Date.now() - 2 * 3600 * 1000));
  var amount;
  if (spapi) {
    amount = await spapiDaySales(date);
    if (amount === null) { console.log("Amazon SP-API not configured yet (seed " + AMZ_DOC + " with {refresh_token,client_id,client_secret}) — skipping " + date); return; }
    console.log("SP-API: Amazon " + date + " ordered product sales = $" + amount);
  } else { amount = parseFloat(args[0]); }
  if (!(amount >= 0)) { console.error("usage: node amazon-daily.js <amountUSD> [YYYY-MM-DD] [--dry|--spapi]"); process.exit(2); }

  var act = { source: "amazon", kind: "sale", id: "amzn-day-" + date, amount: Math.round(amount * 100) / 100 };

  if (dry) {
    var rr = E.ingestExternal(E.newState("Lawrence", new Date()), [act], new Date());
    var c = (rr.credited || [])[0] || {};
    console.log("[dry] " + JSON.stringify(act) + " -> +" + (c.xp || 0) + " " + (c.dim || "?") + " (\"" + (c.name || "") + "\")");
    return;
  }
  var tok = await FB.accessToken();
  var r = await FB.commitIngest(tok, function (state) { return E.ingestExternal(state, [act], new Date()); });
  if (!r.credited.length) { console.log("Amazon " + date + " $" + amount + " already credited — no-op"); return; }
  var c = r.credited[0];
  console.log("credited Amazon " + date + ": +" + c.xp + " " + c.dim + "  \"" + c.name + "\"  | cloud now: totalXp " + r.state.totalXp + ", power " + r.state.incomeXp + ", 7d-sales $" + E.recentSalesTotal(r.state, 7, new Date()));
})().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
