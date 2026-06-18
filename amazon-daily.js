/* amazon-daily.js — credit a single DAY's Vybrance Amazon sales into the cloud game state.
 *
 * Each day's "Ordered product sales" becomes ONE deduped seed:
 *   { source:"amazon", kind:"sale", id:"amzn-day-<YYYY-MM-DD>", amount }
 * Deduped by the day id => idempotent (re-running the same day is a no-op); credits Financial XP, which
 * raises both the Power Level (incomeXp) and the overall level (totalXp).
 *
 * It always credits a FULLY-CLOSED day (never the in-progress one), so the figure is final — the per-day
 * dedup can't lock in a partial intra-day total. $0/no-sales days are skipped (no phantom floor XP, no lock).
 *
 * USAGE
 *   node amazon-daily.js <amountUSD> [YYYY-MM-DD]   # manual/bridge; date defaults to TODAY (America/Chicago)
 *   node amazon-daily.js <amountUSD> [date] --dry   # print only, write nothing
 *   node amazon-daily.js --spapi [YYYY-MM-DD]       # AUTO; date defaults to YESTERDAY (the just-closed day)
 *
 * AUTO (SP-API) creds live in Firestore _feed/amazon { refresh_token, client_id, client_secret, marketplace_id }.
 * Firestore write reuses the owner login via whoop-feed.js (commitIngest). PROTAG_UID must be set.
 */
"use strict";
var FB = require("./whoop-feed.js");
var E = require("./engine.js");

var PROJECT = process.env.PROTAG_PROJECT || "protagonist-db3fd";
var AMZ_DOC = process.env.AMAZON_FEED_DOC || "_feed/amazon";
var US_MARKETPLACE = "ATVPDKIKX0DER";

// ---- America/Chicago date helpers (DST-correct) ----
function chicagoYMD(d) {
  var p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
  return o.year + "-" + o.month + "-" + o.day;
}
function shiftYMD(ymd, days) {
  var p = ymd.split("-"), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
// UTC offset (e.g. "-06:00") in effect in America/Chicago at LOCAL MIDNIGHT of `ymd`. Probing 06:30Z lands
// at 00:30 CST / 01:30 CDT — after local midnight but before the 02:00 DST switch — so it returns the offset
// that actually applies at the day's START. (The old noon-probe returned the POST-switch offset on the two
// transition days, shifting the window 1h.) Each endpoint is computed independently, so spring-forward (23h)
// and fall-back (25h) days emit the correct span.
function chicagoOffset(ymd) {
  var d = new Date(ymd + "T06:30:00Z");
  var s = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(d).find(function (x) { return x.type === "timeZoneName"; });
  var m = /GMT([+-]\d{1,2})/.exec((s && s.value) || "GMT-6");
  var hr = m ? Math.abs(parseInt(m[1], 10)) : 6;
  return "-" + String(hr).padStart(2, "0") + ":00";
}

// fetch with a small bounded retry on network errors / 5xx / 429 — a transient SP-API or LWA blip shouldn't
// silently drop a day. (We pull a closed day, so a missed run could also be re-run with an explicit date.)
async function fetchRetry(url, opts, tries) {
  var lastErr;
  for (var i = 0; i < (tries || 3); i++) {
    try {
      var r = await fetch(url, opts);
      if (r.status >= 500 || r.status === 429) lastErr = new Error("HTTP " + r.status);
      else return r;
    } catch (e) { lastErr = e; }
    await new Promise(function (res) { setTimeout(res, 800 * (i + 1)); });
  }
  throw lastErr || new Error("fetch failed after retries");
}

// ---- SP-API: LWA token -> Sales orderMetrics for one fully-closed Chicago day ----
async function spapiDaySales(date) {
  var ownerTok = await FB.accessToken();
  var fsUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents/" + AMZ_DOC;
  var r = await fetch(fsUrl, { headers: { Authorization: "Bearer " + ownerTok } });
  if (r.status === 404) return null;   // not configured yet -> caller skips gracefully (green no-op cron)
  if (!r.ok) throw new Error("could not read " + AMZ_DOC + " (" + r.status + "): " + (await r.text()));
  var f = (await r.json()).fields || {}, cred = {}; Object.keys(f).forEach(function (k) { cred[k] = FB.fromValue(f[k]); });
  if (!cred.refresh_token || !cred.client_id || !cred.client_secret) throw new Error("incomplete SP-API creds in " + AMZ_DOC);
  var body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh_token, client_id: cred.client_id, client_secret: cred.client_secret });
  var tr = await fetchRetry("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!tr.ok) throw new Error("LWA token failed " + tr.status);
  var access = (await tr.json()).access_token;
  if (!access) throw new Error("LWA returned no access_token");
  // interval = local midnight of `date` -> local midnight of the next day, each at ITS OWN offset (DST-safe);
  // granularityTimeZone makes SP-API bucket the Day by Central regardless of the offsets.
  var startOff = chicagoOffset(date), next = shiftYMD(date, 1), endOff = chicagoOffset(next);
  var interval = encodeURIComponent(date + "T00:00:00" + startOff + "--" + next + "T00:00:00" + endOff);
  var mp = cred.marketplace_id || US_MARKETPLACE;
  var url = "https://sellingpartnerapi-na.amazon.com/sales/v1/orderMetrics?marketplaceIds=" + mp +
    "&interval=" + interval + "&granularity=Day&granularityTimeZone=" + encodeURIComponent("America/Chicago");
  var sr = await fetchRetry(url, { headers: { "x-amz-access-token": access } });
  if (!sr.ok) throw new Error("SP-API orderMetrics failed " + sr.status + ": " + (await sr.text()).slice(0, 300));
  var pl = (await sr.json()).payload || [];
  var total = pl.reduce(function (a, m) { return a + (+(m.totalSales && m.totalSales.amount) || 0); }, 0);
  return Math.round(total * 100) / 100;
}

// credit ONE closed day's sales (idempotent via the per-day dedup id). $0 days are skipped (no phantom XP, no lock).
async function creditDay(date, amount, dry) {
  if (!(amount > 0)) { console.log("Amazon " + date + ": $0 / no sales — nothing to credit"); return; }
  var act = { source: "amazon", kind: "sale", id: "amzn-day-" + date, amount: Math.round(amount * 100) / 100 };
  if (dry) {
    var rr = E.ingestExternal(E.newState("Lawrence", new Date()), [act], new Date());
    var dc = (rr.credited || [])[0] || {};
    console.log("[dry] " + JSON.stringify(act) + " -> +" + (dc.xp || 0) + " " + (dc.dim || "?") + " (\"" + (dc.name || "") + "\")");
    return;
  }
  var tok = await FB.accessToken();
  var res = await FB.commitIngest(tok, function (state) { return E.ingestExternal(state, [act], new Date()); });
  if (!res.credited.length) { console.log("Amazon " + date + " $" + amount + " already credited — no-op"); return; }
  var c = res.credited[0];
  console.log("credited Amazon " + date + ": +" + c.xp + " " + c.dim + "  \"" + c.name + "\"  | cloud now: totalXp " + res.state.totalXp + ", power " + res.state.incomeXp + ", 7d-sales $" + E.recentSalesTotal(res.state, 7, new Date()));
}

async function main() {
  var args = process.argv.slice(2);
  var dry = args.indexOf("--dry") !== -1; args = args.filter(function (a) { return a !== "--dry"; });
  var spapi = args.indexOf("--spapi") !== -1; args = args.filter(function (a) { return a !== "--spapi"; });
  var explicit = args.filter(function (a) { return /^\d{4}-\d{2}-\d{2}$/.test(a); })[0];

  if (spapi && !explicit) {
    // BACKFILL the last few CLOSED days (yesterday back N). GitHub scheduled runs are best-effort — a skipped or
    // delayed run would otherwise drop that day's sales forever (the next run only looks at the new yesterday).
    // Re-crediting an already-processed day is a guaranteed no-op thanks to the per-day dedup id.
    var BACKFILL_DAYS = 4;
    var y = shiftYMD(chicagoYMD(new Date()), -1);
    for (var i = 0; i < BACKFILL_DAYS; i++) {
      var d = shiftYMD(y, -i);
      var amt = await spapiDaySales(d);
      if (amt === null) { console.log("Amazon SP-API not configured yet (seed " + AMZ_DOC + ") — skipping"); return; }
      console.log("SP-API: Amazon " + d + " ordered product sales = $" + amt);
      await creditDay(d, amt, dry);
    }
    return;
  }

  var date = explicit || chicagoYMD(new Date());   // manual/bridge defaults to today; explicit date as given
  var amount;
  if (spapi) {
    amount = await spapiDaySales(date);
    if (amount === null) { console.log("Amazon SP-API not configured yet (seed " + AMZ_DOC + ") — skipping " + date); return; }
    console.log("SP-API: Amazon " + date + " ordered product sales = $" + amount);
  } else {
    amount = parseFloat(args[0]);
    if (!(amount >= 0)) { console.error("usage: node amazon-daily.js <amountUSD> [YYYY-MM-DD] [--dry|--spapi]"); process.exit(2); }
  }
  await creditDay(date, amount, dry);
}

// export the pure helpers for tests; only run the feed when executed directly (not on require)
module.exports = { chicagoYMD: chicagoYMD, shiftYMD: shiftYMD, chicagoOffset: chicagoOffset, spapiDaySales: spapiDaySales };
if (require.main === module) main().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
