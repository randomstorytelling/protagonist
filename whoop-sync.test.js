/* Tests for the WHOOP game-master pipeline. Run: node whoop-sync.test.js */
var S = require("./whoop-sync.js");
var pass = 0, fail = 0, fails = [];
function test(n, f) { try { f(); pass++; } catch (e) { fail++; fails.push(n + " :: " + e.message); } }
function assert(c, m) { if (!c) throw new Error(m || "fail"); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "neq") + " got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
var now = new Date(2026, 5, 15, 12, 0, 0);

test("syncDays credits WHOOP into a fresh save", function () {
  var day = { date: "2026-06-15", recovery: { score: 72 }, sleep: { hours: 7.5 }, workouts: [{ id: "w1", sport: "run", durationMin: 60 }] };
  var out = S.syncDays(null, [day], now);
  eq(out.credited.length, 3, "recovery + sleep + workout credited");
  assert(out.save.dims.physical > 0, "physical raised");
  assert(out.save.history[String(require("./engine.js").dayIndex(now))].physical === 3, "3 physical reps logged today");
});

test("syncDays is idempotent across re-runs (no double counting)", function () {
  var day = { date: "2026-06-15", recovery: { score: 72 }, sleep: { hours: 7.5 }, workouts: [{ id: "w1", sport: "run", durationMin: 60 }] };
  var first = S.syncDays(null, [day], now);
  var again = S.syncDays(JSON.stringify(first.save), [day], now);
  eq(again.save.dims.physical, first.save.dims.physical, "physical unchanged on re-run");
  eq(again.credited.length, 0, "nothing new credited");
});

test("syncDays handles multiple days at once", function () {
  var days = [
    { date: "2026-06-14", recovery: { score: 50 }, workouts: [{ id: "a", durationMin: 30 }] },
    { date: "2026-06-15", recovery: { score: 80 }, workouts: [{ id: "b", durationMin: 45 }] },
  ];
  var out = S.syncDays(null, days, now);
  eq(out.credited.length, 4, "2 recoveries + 2 workouts");
});

test("syncDays tolerates an empty / partial day", function () {
  var out = S.syncDays(null, [{ date: "2026-06-15" }], now);
  eq(out.credited.length, 0, "nothing to credit, no crash");
  assert(Number.isFinite(out.save.dims.physical), "save intact");
});

console.log("\n  whoop-sync pipeline: " + pass + " passed, " + fail + " failed\n");
if (fail) { fails.forEach(function (f) { console.log("  FAIL  " + f); }); process.exit(1); } else { console.log("  all green\n"); process.exit(0); }
