/* feeds.test.js — pure-logic tests for the cloud feed scripts (date/DST math the unattended crons depend on).
 * Run: node feeds.test.js   (wired into the deploy CI gate)
 */
var A = require("./amazon-daily.js");
var E = require("./engine.js");
var MB = require("./morning-brief.js");

var pass = 0, fail = 0, fails = [];
function test(n, fn) { try { fn(); pass++; } catch (e) { fail++; fails.push(n + " :: " + e.message); } }
function eq(a, b, m) { if (a !== b) throw new Error((m || "not equal") + " (got " + a + ", want " + b + ")"); }

test("chicagoYMD = America/Chicago calendar date (DST-aware)", function () {
  eq(A.chicagoYMD(new Date("2026-06-17T18:00:00Z")), "2026-06-17", "afternoon UTC");
  eq(A.chicagoYMD(new Date("2026-06-17T04:30:00Z")), "2026-06-16", "late-evening Central is still the prior day");
  eq(A.chicagoYMD(new Date("2026-01-15T05:30:00Z")), "2026-01-14", "winter late-evening Central");
});

test("shiftYMD = pure calendar arithmetic across month/DST boundaries", function () {
  eq(A.shiftYMD("2026-06-17", -1), "2026-06-16");
  eq(A.shiftYMD("2026-03-01", -1), "2026-02-28");
  eq(A.shiftYMD("2026-03-08", 1), "2026-03-09");   // spring-forward day
  eq(A.shiftYMD("2026-12-31", 1), "2027-01-01");    // year boundary
});

test("chicagoOffset = the LOCAL-MIDNIGHT offset, correct on the two DST transition days", function () {
  eq(A.chicagoOffset("2026-06-17"), "-05:00", "summer = CDT");
  eq(A.chicagoOffset("2026-01-15"), "-06:00", "winter = CST");
  eq(A.chicagoOffset("2026-03-08"), "-06:00", "spring-forward day STARTS in CST (bug was post-2AM CDT)");
  eq(A.chicagoOffset("2026-11-01"), "-05:00", "fall-back day STARTS in CDT (bug was post-2AM CST)");
});

test("morning-brief formats a scannable email from dailyBrief (pure)", function () {
  var now = new Date(2026, 5, 18, 12, 0, 0);
  var s = E.newState("Lawrence Whitaker", now);
  var msg = MB.formatBrief(E.dailyBrief(s, now), "Lawrence Whitaker");
  eq(typeof msg.subject, "string", "subject is a string");
  eq(msg.subject.indexOf("Lawrence") !== -1, true, "subject names the player");
  eq(msg.text.indexOf("POWER LEVEL") !== -1, true, "brief shows the Power Level");
  eq(msg.text.indexOf("Daily Quest:") !== -1, true, "brief shows the daily quest");
  eq(msg.text.indexOf("Vybrance:") !== -1, true, "brief shows Vybrance revenue");
  eq(msg.text.indexOf("The System") !== -1, true, "signed by The System");
});

console.log("\n  Feeds — pure logic\n  " + pass + " passed, " + fail + " failed\n");
if (fail) { fails.forEach(function (f) { console.log("  FAIL  " + f); }); process.exit(1); }
else { console.log("  all green\n"); process.exit(0); }
