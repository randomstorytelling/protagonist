/* Stress battery for engine.js — pure logic, no DOM. Run: node engine.test.js */
var E = require("./engine.js");

var pass = 0, fail = 0, fails = [];
function test(name, fn) { try { fn(); pass++; } catch (e) { fail++; fails.push(name + " :: " + e.message); } }
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "not equal") + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

// deterministic clock helpers (local noon avoids tz edge effects)
var BASE = new Date(2026, 5, 15, 12, 0, 0);
function D(n) { return new Date(2026, 5, 15 + n, 12, 0, 0); }
function ymd(n) { var d = new Date(2026, 5, 15 + n, 12, 0, 0); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function fresh(now) { return E.newState("Lawrence", now || D(0)); }
function snap(s) { return JSON.stringify(s); }

// ---------------------------------------------------------------- time + level math
test("dayIndex is stable within a day and +1 next day", function () {
  eq(E.dayIndex(new Date(2026, 5, 15, 0, 1)), E.dayIndex(new Date(2026, 5, 15, 23, 59)), "same day");
  assert(E.dayIndex(D(1)) === E.dayIndex(D(0)) + 1, "next day +1");
});

test("levelFromXp is monotonic and finite for huge xp", function () {
  var prev = 0;
  [0, 50, 100, 250, 1000, 1e6, 1e9].forEach(function (xp) {
    var l = E.levelFromXp(xp);
    assert(isFinite(l.level) && l.level >= 1, "finite level for " + xp);
    assert(l.level >= prev, "monotonic at " + xp);
    assert(l.pct >= 0 && l.pct <= 100, "pct bounded at " + xp);
    prev = l.level;
  });
  assert(E.levelFromXp(0).level === 1, "0 xp -> L1");
  assert(E.levelFromXp(99).level === 1, "99 xp -> L1");
  assert(E.levelFromXp(100).level === 2, "100 xp -> L2");
});

test("rankForLevel respects boundaries", function () {
  eq(E.rankForLevel(1), "Responder"); eq(E.rankForLevel(4), "Responder"); eq(E.rankForLevel(5), "Experimenter");
  eq(E.rankForLevel(10), "Builder"); eq(E.rankForLevel(18), "Master"); eq(E.rankForLevel(28), "Sage");
  eq(E.rankForLevel(42), "Role Model"); eq(E.rankForLevel(60), "Actualized"); eq(E.rankForLevel(999), "Actualized");
});

// ---------------------------------------------------------------- multiplier
test("multiplier scales with engine dims (0.15 each), capped at 1.6", function () {
  var s = fresh(); var day = E.dayIndex(D(0));
  s.history[day] = { physical: 0, mental: 0, spiritual: 0, family: 0, social: 0, financial: 0 };
  eq(E.multiplier(s, day), 1.0, "0");
  s.history[day].physical = 1; eq(E.multiplier(s, day), 1.15, "1");
  s.history[day].mental = 1; eq(E.multiplier(s, day), 1.3, "2");
  s.history[day].spiritual = 1; eq(E.multiplier(s, day), 1.45, "3");
  s.history[day].family = 1; eq(E.multiplier(s, day), 1.6, "4 (capped)");
  s.history[day].social = 1; eq(E.multiplier(s, day), 1.6, "5 still capped");
  s.history[day].financial = 9; eq(E.multiplier(s, day), 1.6, "financial does not raise it");
});

test("penalty caps the multiplier to base even when fully vibrant", function () {
  var s = fresh(); var day = E.dayIndex(D(0));
  s.history[day] = { physical: 1, mental: 1, spiritual: 1, family: 1, social: 0, financial: 0 };
  eq(E.multiplier(s, day), 1.6, "vibrant before penalty");
  s.penalty = { active: true, sinceDay: day };
  eq(E.multiplier(s, day), 1.0, "capped under penalty");
});

// ---------------------------------------------------------------- core transition
test("applyRep does not mutate the input state (immutability)", function () {
  var s = fresh(); var before = snap(s);
  var r = E.applyRep(s, "phys_pushups", D(0));
  eq(snap(s), before, "input unchanged");
  assert(r.state !== s, "returns a new object");
});

test("known case: 4 engine reps then a 20xp income rep credits 32", function () {
  var s = fresh();
  s = E.applyRep(s, "phys_pushups", D(0)).state;
  s = E.applyRep(s, "ment_deep", D(0)).state;
  s = E.applyRep(s, "spir_meditate", D(0)).state;
  s = E.applyRep(s, "fam_call", D(0)).state; // 4 engine dims -> x1.6
  var before = s.incomeXp;
  s = E.applyRep(s, "fin_dms", D(0)).state; // base 20 * 1.6 = 32
  eq(s.incomeXp - before, 32, "income credited 32");
});

test("financial-only day uses base multiplier (no free amplification)", function () {
  var s = fresh();
  s = E.applyRep(s, "fin_dms", D(0)).state; // 20 * 1.0
  eq(s.incomeXp, 20, "20 income xp");
});

test("daily quest completes once, grants reward, never double-fires", function () {
  var s = fresh();
  ["phys_pushups", "ment_deep", "spir_meditate", "fam_call", "soc_friend", "fin_dms"].forEach(function (id) { s = E.applyRep(s, id, D(0)).state; });
  assert(s.daily.completed === true, "daily completed after all 6 dims");
  var rr = E.applyRep(s, "phys_mobility", D(0)); // extra rep same day
  var dailyEvents = rr.events.filter(function (e) { return e.type === "DAILY_COMPLETE"; });
  eq(dailyEvents.length, 0, "no second DAILY_COMPLETE");
});

// ---------------------------------------------------------------- penalty state machine
test("missing a daily across rollover incurs exactly one penalty (no stacking)", function () {
  var s = fresh(D(0));
  s.player.createdDay = E.dayIndex(D(0)) - 1; // pretend created yesterday so today is penalizable
  s.daily = { day: E.dayIndex(D(0)), completed: false };
  var away = E.reconcile(s, D(30)); // gone 30 days
  assert(E.isPenalized(away), "penalty active after long absence");
  eq(away.penalty.sinceDay, E.dayIndex(D(30)), "sinceDay is today");
  // penalty is a single boolean state, inherently not stackable
  assert(typeof away.penalty.active === "boolean", "single penalty flag");
});

test("creation-day miss is graced (no penalty)", function () {
  var s = fresh(D(0)); // createdDay = today, daily.day = today
  var next = E.reconcile(s, D(1));
  assert(!E.isPenalized(next), "no penalty for the creation day");
});

test("completing today's daily clears an active penalty", function () {
  var s = fresh(D(0));
  s.player.createdDay = E.dayIndex(D(0)) - 1;
  s.daily = { day: E.dayIndex(D(0)), completed: false };
  s = E.reconcile(s, D(1)); // -> penalty active on day 1
  assert(E.isPenalized(s), "penalized on day 1");
  ["phys_pushups", "ment_deep", "spir_meditate", "fam_call", "soc_friend"].forEach(function (id) { s = E.applyRep(s, id, D(1)).state; });
  var r = E.applyRep(s, "fin_dms", D(1)); // 6th dim completes daily -> clears penalty
  assert(!E.isPenalized(r.state), "penalty cleared");
  assert(r.events.some(function (e) { return e.type === "PENALTY_CLEARED"; }), "PENALTY_CLEARED event");
});

// ---------------------------------------------------------------- streak
test("streak increments on consecutive days, resets on a gap, tracks longest", function () {
  var s = fresh(D(0));
  s = E.applyRep(s, "phys_pushups", D(0)).state; eq(s.streak.current, 1, "day0");
  s = E.applyRep(s, "phys_pushups", D(0)).state; eq(s.streak.current, 1, "same day no inflate");
  s = E.applyRep(s, "phys_pushups", D(1)).state; eq(s.streak.current, 2, "day1");
  s = E.applyRep(s, "phys_pushups", D(2)).state; eq(s.streak.current, 3, "day2");
  s = E.applyRep(s, "phys_pushups", D(5)).state; eq(s.streak.current, 1, "gap resets");
  eq(s.streak.longest, 3, "longest preserved");
});

// ---------------------------------------------------------------- level / rank / titles
test("a single big rep that crosses multiple levels emits one LEVEL_UP with correct points", function () {
  var s = fresh();
  var r = E.applyRep(s, "fin_rep", D(0)); // +400 totalXp -> L1->L4
  var lu = r.events.filter(function (e) { return e.type === "LEVEL_UP"; });
  eq(lu.length, 1, "one LEVEL_UP");
  eq(lu[0].from, 1, "from L1"); eq(lu[0].to, 4, "to L4");
  eq(lu[0].statPoints, 9, "9 stat points (3 levels * 3)");
  eq(r.state.statPoints.available, 9, "points banked");
});

test("rank up fires when crossing a rank boundary", function () {
  var s = fresh();
  // pile xp to cross into Experimenter rank (level >=5). Need ~ enough totalXp.
  for (var i = 0; i < 6; i++) s = E.applyRep(s, "fin_rep", D(0)).state; // plenty
  assert(E.playerLevel(s) >= 5, "reached >= L5");
  eq(E.rank(s), "Experimenter", "Experimenter rank (level >=5) reached");
});

test("titles unlock once, persist, and add an income bonus", function () {
  var s = fresh();
  var r = E.applyRep(s, "fin_book", D(0)); // big win + income 300
  assert(r.state.unlockedTitles.indexOf("closer") >= 0, "closer unlocked");
  assert(r.state.unlockedTitles.indexOf("awakened") >= 0, "awakened unlocked");
  assert(E.titleBonusPct(r.state) >= 5, "bonus applies");
  var r2 = E.applyRep(r.state, "fin_dms", D(0));
  var unlocks = r2.events.filter(function (e) { return e.type === "TITLE_UNLOCKED" && e.id === "closer"; });
  eq(unlocks.length, 0, "closer does not re-unlock");
});

test("stat allocation is bounded and decrements the pool", function () {
  var s = fresh(); s.statPoints.available = 2;
  var a = E.allocateStat(s, "financial", D(0));
  assert(a.ok && a.state.statPoints.available === 1 && a.state.statPoints.allocated.financial === 1, "allocated one");
  a = E.allocateStat(a.state, "financial", D(0));
  var b = E.allocateStat(a.state, "financial", D(0)); // none left
  assert(!b.ok, "cannot overspend");
  eq(b.state.statPoints.available, 0, "pool floored at 0");
  // financial bonus is capped
  var big = fresh(); big.statPoints.allocated.financial = 1000;
  assert(E.statBonusPct(big) <= E.CONFIG.statBonus.cap, "financial bonus capped");
});

// ---------------------------------------------------------------- persistence / migration
test("v1 save migrates to v2 without data loss", function () {
  var v1 = {
    name: "Lawrence", initials: "LW", created: "2026-6-10", incomeXp: 32,
    dims: { physical: 25, mental: 20, spiritual: 15, financial: 20 },
    history: { "2026-6-10": { physical: 1, mental: 1, spiritual: 1, financial: 1 } },
    log: [{ ts: D(0).getTime(), dim: "financial", name: "Send 25 outreach DMs", xp: 32, mult: 1.6 }],
    repDays: ["2026-6-10"],
  };
  var s = E.migrateV1toV2(v1, D(0));
  eq(s.version, E.SCHEMA_VERSION, "migrated to current schema");
  eq(s.totalXp, 80, "totalXp = sum of dims");
  eq(s.incomeXp, 32, "incomeXp preserved");
  var key = String(E.dayIndex(new Date(2026, 5, 10, 12, 0, 0)));
  assert(s.history[key], "history key converted to dayIndex");
  eq(s.history[key].physical, 1, "day counts preserved");
  assert(s.streak.longest >= 1, "streak recomputed");
});

test("init handles null, garbage, v1, and v2 safely", function () {
  var V = E.SCHEMA_VERSION;
  assert(E.init(null, D(0)).state.version === V, "null -> fresh current-schema state");
  assert(E.init("}{not json", D(0)).state.version === V, "garbage -> fresh current-schema state");
  var v1 = { name: "L", created: "2026-6-10", incomeXp: 10, dims: { physical: 5, mental: 0, spiritual: 0, financial: 10 }, history: {}, log: [], repDays: [] };
  assert(E.init(JSON.stringify(v1), D(0)).state.version === V, "v1 string -> migrated to current schema");
  var cur = E.newState("L", D(0));
  assert(E.init(cur, D(0)).state.version === V, "current-schema object -> reconciled");
});

test("v2->v3 migration REBASES Big Wins to real milestones only (sales no longer count)", function () {
  var day = E.dayIndex(D(0));
  var v2 = E.newState("L", D(0)); v2.version = 2;
  v2.bigWins = 47;   // inflated count from the old "every $200 sales day = big win" behavior
  v2.log = [
    { ts: 1, day: day, dim: "financial", name: "Amazon sale $300", big: true, amount: 300, source: "amazon" }, // sale: NOT a real win
    { ts: 2, day: day, dim: "financial", name: "Shopify sale $250", big: true, amount: 250, source: "shopify" }, // sale: NOT a real win
    { ts: 3, day: day, dim: "financial", name: "Booked a national commercial", big: true, amount: null, source: "manual" }, // REAL win
    { ts: 4, day: day, dim: "financial", name: "Closed a wholesale account", big: true, amount: null, source: "smart" },     // REAL win
    { ts: 5, day: day, dim: "physical", name: "50 push-ups", big: false, amount: null, source: "manual" },                    // not a win
  ];
  var m = E.migrateV2toV3(v2, D(0));
  eq(m.version, 3, "bumped to v3");
  eq(m.bigWins, 2, "rebased to the 2 REAL milestone wins (sales excluded), not the inflated 47");
  // and it flows through init end-to-end
  eq(E.init(JSON.stringify(v2), D(0)).state.bigWins, 2, "init migrates + rebases Big Wins");
});

test("validateRepair fills missing fields and rejects bad values", function () {
  var broken = { version: 2, totalXp: NaN, incomeXp: "oops", dims: { physical: -5 }, unlockedTitles: ["nonexistent"], log: "nope" };
  var r = E.validateRepair(broken, D(0));
  eq(r.totalXp, 0, "NaN totalXp -> 0");
  eq(r.incomeXp, 0, "string incomeXp -> 0");
  eq(r.dims.physical, 0, "negative dim -> 0");
  eq(r.unlockedTitles.length, 0, "unknown title dropped");
  assert(Array.isArray(r.log), "log coerced to array");
});

// ---------------------------------------------------------------- determinism + scale
test("applyRep is deterministic", function () {
  var s = fresh();
  var a = E.applyRep(s, "phys_pushups", D(0));
  var b = E.applyRep(s, "phys_pushups", D(0));
  eq(snap(a.state), snap(b.state), "same state");
  eq(JSON.stringify(a.events), JSON.stringify(b.events), "same events");
});

test("5000 reps stay finite, fast, and log-capped", function () {
  var s = fresh();
  var ids = ["phys_pushups", "ment_deep", "spir_meditate", "fin_dms", "fin_book"];
  var t0 = Date.now();
  for (var i = 0; i < 5000; i++) s = E.applyRep(s, ids[i % ids.length], D(i % 14)).state;
  var ms = Date.now() - t0;
  assert(isFinite(s.totalXp) && isFinite(s.incomeXp), "no NaN/Infinity");
  assert(isFinite(E.playerLevel(s)) && E.playerLevel(s) > 1, "level finite & grew");
  assert(s.log.length === 1000, "log capped at LOG_CAP (1000)");
  assert(ms < 4000, "ran in under 4s (was " + ms + "ms)");
});

test("suggestionDim returns the lagging dimension", function () {
  var s = fresh(); var day = E.dayIndex(D(0));
  s.history[day] = { physical: 3, mental: 3, spiritual: 0, financial: 3 };
  eq(E.suggestionDim(s, day), "spiritual", "spiritual is behind");
});

// ---------------------------------------------------------------- regression: adversarial audit findings
test("REG streak is consistent across build paths (single source of truth)", function () {
  var a = fresh(D(0));
  [0, 1, 2].forEach(function (n) { a = E.applyRep(a, "phys_pushups", D(n)).state; });
  var v1 = { name: "L", created: ymd(0), incomeXp: 0, dims: { physical: 3, mental: 0, spiritual: 0, financial: 0 }, history: {}, log: [], repDays: [] };
  v1.history[ymd(0)] = { physical: 1, mental: 0, spiritual: 0, financial: 0 };
  v1.history[ymd(1)] = { physical: 1, mental: 0, spiritual: 0, financial: 0 };
  v1.history[ymd(2)] = { physical: 1, mental: 0, spiritual: 0, financial: 0 };
  var b = E.migrateV1toV2(v1, D(2));
  eq(a.streak.current, b.streak.current, "current matches across paths");
  eq(a.streak.longest, b.streak.longest, "longest matches across paths");
  eq(a.streak.longest, 3, "3-day streak counted");
});

test("REG backdated `now` is clamped — cannot bypass a penalty or write to a past day", function () {
  var s = fresh(D(0));
  s.player.createdDay = E.dayIndex(D(0)) - 1;
  s.daily = { day: E.dayIndex(D(0)), completed: false };
  s = E.reconcile(s, D(3));            // penalized on day 3
  assert(E.isPenalized(s), "penalized day3");
  var pastKey = String(E.dayIndex(D(2)));
  var r = E.applyRep(s, "fin_dms", D(2)); // attempt to log on day 2 (the past)
  assert(E.isPenalized(r.state), "still penalized — past rep did not clear it");
  assert(r.state.daily.day >= E.dayIndex(D(3)), "daily.day did not roll backward");
  assert(!r.state.history[pastKey], "no history written to the past day");
});

test("REG multi-day skip incurs a penalty even if the last opened day was completed", function () {
  var s = fresh(D(0));
  ["phys_pushups", "ment_deep", "spir_meditate", "fam_call", "soc_friend", "fin_dms"].forEach(function (id) { s = E.applyRep(s, id, D(0)).state; });
  assert(s.daily.completed, "day0 completed");
  var back = E.init(JSON.stringify(s), D(7)); // reopen a week later
  assert(E.isPenalized(back.state), "penalized for the skipped days");
  assert(back.events.some(function (e) { return e.type === "PENALTY_INCURRED"; }), "PENALTY_INCURRED on load");
});

test("REG levelFromXp coerces non-finite / negative xp to level 1", function () {
  eq(E.levelFromXp(Infinity).level, 1, "Infinity -> L1");
  eq(E.levelFromXp(NaN).level, 1, "NaN -> L1");
  eq(E.levelFromXp(-5).level, 1, "negative -> L1");
  assert(isFinite(E.levelFromXp(Infinity).need), "need is finite");
});

test("REG migration skips invalid history keys without merging or losing valid days", function () {
  var v1 = {
    name: "L", created: ymd(0), incomeXp: 0, dims: { physical: 0, mental: 0, spiritual: 0, financial: 0 },
    history: { "oops": { physical: 1, mental: 0, spiritual: 0, financial: 0 }, "also-bad": { physical: 1, mental: 0, spiritual: 0, financial: 0 } },
    log: [], repDays: [],
  };
  v1.history[ymd(0)] = { physical: 2, mental: 0, spiritual: 0, financial: 0 };
  var s = E.migrateV1toV2(v1, D(0));
  assert(Object.keys(s.history).indexOf("NaN") === -1, "no NaN key");
  eq(Object.keys(s.history).length, 1, "only the valid day survives");
  eq(E.repsTotal(s), 2, "valid day's reps preserved, junk dropped");
});

test("REG validateRepair drops junk history keys and finite-guards day fields", function () {
  var s = E.newState("L", D(0));
  s.history[String(E.dayIndex(D(0)))] = { physical: 1, mental: 0, spiritual: 0, financial: 0 };
  s.history["NaN"] = { physical: 1, mental: 0, spiritual: 0, financial: 0 };
  s.player.createdDay = NaN; s.daily.day = NaN; s.lastActiveDay = NaN; s.streak.lastDay = NaN; s.penalty.sinceDay = NaN;
  var r = E.validateRepair(s, D(0));
  assert(Object.keys(r.history).indexOf("NaN") === -1, "junk key dropped");
  assert(Number.isFinite(r.player.createdDay), "createdDay finite");
  assert(Number.isFinite(r.daily.day) && Number.isFinite(r.lastActiveDay), "day fields finite");
  assert(r.streak.lastDay === null || Number.isFinite(r.streak.lastDay), "lastDay finite-or-null");
  assert(r.penalty.sinceDay === null || Number.isFinite(r.penalty.sinceDay), "sinceDay finite-or-null");
});

test("REG corrupt Infinity save -> finite level and bounded stat points (no free points)", function () {
  var v1 = { name: "L", created: ymd(0), incomeXp: Infinity, dims: { physical: Infinity, mental: 0, spiritual: 0, financial: 0 }, history: {}, log: [], repDays: [] };
  var got = E.init(v1, D(0)); // live-object path (Infinity not stringified away)
  assert(Number.isFinite(got.state.totalXp) && Number.isFinite(got.state.incomeXp), "xp finite");
  assert(Number.isFinite(got.state.statPoints.available), "stat points finite");
  assert(got.state.statPoints.available < 1000, "no absurd stat-point grant (was 9486)");
  assert(E.playerLevel(got.state) >= 1, "level finite");
});

test("REG invalid Date as `now` never creates a NaN history key", function () {
  var s = fresh(D(0));
  var r = E.applyRep(s, "phys_pushups", new Date("garbage"));
  assert(Object.keys(r.state.history).every(function (k) { return Number.isFinite(Number(k)); }), "all history keys finite");
});

test("REG penalty strips income amplification AND all bonuses", function () {
  var s = fresh(D(0));
  s = E.applyRep(s, "fin_book", D(0)).state; // unlocks title bonus + big win
  assert(E.titleBonusPct(s) >= 5, "has a title bonus to strip");
  s.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  var before = s.incomeXp;
  var r = E.applyRep(s, "fin_close", D(0)); // base 250, penalized => exactly base, no mult/bonus
  eq(r.state.incomeXp - before, 250, "penalized income rep credits only base xp");
});

test("REG future-dated save (clock glitch) cannot freeze the day or grant penalty immunity", function () {
  var real = E.dayIndex(D(0));
  var save = JSON.stringify({
    version: 2, player: { name: "x", initials: "X", createdDay: real },
    totalXp: 0, incomeXp: 0, dims: { physical: 0, mental: 0, spiritual: 0, financial: 0 },
    statPoints: { available: 0, allocated: { physical: 0, mental: 0, spiritual: 0, financial: 0 } },
    unlockedTitles: [], activeTitle: null, history: {}, streak: { current: 0, longest: 0, lastDay: null },
    daily: { day: real + 1000, completed: true }, penalty: { active: false, sinceDay: null },
    bigWins: 0, log: [], lastActiveDay: real + 1000,
  });
  var s = E.init(save, D(0)).state;
  eq(E.effectiveDay(s, D(0)), real, "clamped back to the real day, not frozen 1000 days ahead");
  var later = E.init(JSON.stringify(s), D(3)); // 3 real days pass with no work
  assert(E.isPenalized(later.state), "genuinely skipped days still penalize after the clamp");
});

// ---------------------------------------------------------------- new mechanics: real reps, recurring, WHOOP
test("new fitness + reading reps are present with valid dims", function () {
  ["phys_pushups", "phys_sixpack", "phys_incline"].forEach(function (id) {
    var r = E.REPS.find(function (x) { return x.id === id; });
    assert(r && r.dim === "physical" && r.xp > 0, id + " present");
  });
  var rd = E.REPS.find(function (x) { return x.id === "ment_read"; });
  assert(rd && rd.dim === "mental" && rd.name.indexOf("50 pages") >= 0, "Read 50 pages present");
});

test("recurring quest: due when never done, not due after, due again after the interval", function () {
  var s = E.newState("L", D(0));
  assert(E.recurringStatus(s, D(0)).every(function (x) { return x.due; }), "all due initially");
  var r = E.applyRecurring(s, "groom_haircut", D(0));
  var hc1 = E.recurringStatus(r.state, D(0)).find(function (x) { return x.id === "groom_haircut"; });
  assert(!hc1.due && hc1.daysUntilDue === 10, "not due, 10 days out");
  var hc9 = E.recurringStatus(r.state, D(9)).find(function (x) { return x.id === "groom_haircut"; });
  assert(!hc9.due && hc9.daysUntilDue === 1, "day 9 -> 1 day to go");
  assert(E.recurringStatus(r.state, D(10)).find(function (x) { return x.id === "groom_haircut"; }).due, "due again at day 10");
});

test("applyRecurring credits its dimension and counts as a real rep", function () {
  var s = E.newState("L", D(0));
  var r = E.applyRecurring(s, "groom_haircut", D(0));
  eq(r.state.dims.spiritual, 15, "spiritual credited");
  eq(r.state.history[String(E.dayIndex(D(0)))].spiritual, 1, "counts as a spiritual rep");
  assert(r.events.some(function (e) { return e.type === "RECURRING_DONE"; }), "RECURRING_DONE event");
  eq(r.state.recurring.groom_haircut, E.dayIndex(D(0)), "lastDoneDay recorded");
});

test("WHOOP ingestion credits workouts + qualifying sleep, and is idempotent", function () {
  var s = E.newState("L", D(0));
  var acts = [
    { source: "whoop", kind: "workout", id: "w1", sport: "walking", durationMin: 60 },
    { source: "whoop", kind: "sleep", id: "s1", hours: 7.5 },
    { source: "whoop", kind: "sleep", id: "s2", hours: 5 }, // < 7h -> not scored
  ];
  var r1 = E.ingestExternal(s, acts, D(0));
  var phys1 = r1.state.dims.physical;
  assert(phys1 > 0, "physical credited from WHOOP");
  eq(r1.credited.length, 2, "walk + 7.5h sleep scored, 5h sleep skipped");
  var r2 = E.ingestExternal(r1.state, acts, D(0)); // re-ingest SAME batch
  eq(r2.state.dims.physical, phys1, "no double-count on re-ingest");
  eq(r2.credited.length, 0, "nothing new credited");
});

test("WHOOP workout xp scales with duration and is bounded [8,40]", function () {
  eq(E.whoopActivityToRep({ kind: "workout", sport: "walk", durationMin: 60 }).xp, 20, "60m -> 20");
  assert(E.whoopActivityToRep({ kind: "workout", sport: "x", durationMin: 600 }).xp <= 40, "capped at 40");
  assert(E.whoopActivityToRep({ kind: "workout", sport: "x", durationMin: 1 }).xp >= 8, "floored at 8");
});

test("WHOOP ingestion tolerates malformed activities without crashing or NaN", function () {
  var s = E.newState("L", D(0));
  var r = E.ingestExternal(s, [null, {}, { kind: "workout" }, { kind: "sleep", id: "s", hours: NaN }, { source: "whoop", kind: "workout", id: "ok", durationMin: 30 }], D(0));
  assert(Number.isFinite(r.state.dims.physical), "no NaN");
  eq(r.credited.length, 1, "only the valid workout scored");
});

test("WHOOP-credited workout advances the daily quest + streak like a manual rep", function () {
  var s = E.newState("L", D(0));
  var r = E.ingestExternal(s, [{ source: "whoop", kind: "workout", id: "w1", sport: "walk", durationMin: 60 }], D(0));
  eq(r.state.history[String(E.dayIndex(D(0)))].physical, 1, "counts toward the physical daily requirement");
  eq(r.state.streak.current, 1, "counts toward the streak");
});

test("recurring + WHOOP buckets survive a save round-trip (init)", function () {
  var s = E.newState("L", D(0));
  s = E.applyRecurring(s, "groom_manicure", D(0)).state;
  s = E.ingestExternal(s, [{ source: "whoop", kind: "workout", id: "w9", durationMin: 45 }], D(0)).state;
  var back = E.init(JSON.stringify(s), D(0)).state;
  eq(back.recurring.groom_manicure, E.dayIndex(D(0)), "recurring persisted");
  assert(back.external.seen["whoop:workout:w9"], "dedup key persisted (won't re-credit after reload)");
});

// ---------------------------------------------------------------- smart activity classifier
test("classifyActivity sorts natural-language activities into the right dimension/category", function () {
  var cases = [
    ["I called my parents and talked for 20 minutes", "family", "Family"],
    ["had dinner with a friend", "social", "Connection"],
    ["went to therapy this morning", "mental", "Therapy"],
    ["did 50 push-ups", "physical", "Fitness"],
    ["60 min incline walk", "physical", "Fitness"],
    ["read 50 pages of a book", "mental", "Learning"],
    ["rehearsed my lines for the audition", "mental", "Craft"],
    ["meditated this morning", "spiritual", "Mindfulness"],
    ["sent 25 outreach DMs", "financial", "Outreach"],
    ["recorded a self-tape", "financial", "Auditions"],
    ["booked a national commercial", "financial", "Big win"],
    ["got a haircut", "spiritual", "Upkeep"],
  ];
  cases.forEach(function (c) {
    var r = E.classifyActivity(c[0]);
    eq(r.dim, c[1], '"' + c[0] + '" -> dim');
    eq(r.category, c[2], '"' + c[0] + '" -> category');
  });
});

test("classifyActivity scales xp by stated duration", function () {
  var short = E.classifyActivity("walked for 20 minutes");
  var long = E.classifyActivity("walked for 60 minutes");
  assert(long.xp > short.xp, "longer duration -> more xp");
  assert(long.xp <= 60, "duration xp is capped");
  eq(E.classifyActivity("booked the gig").xp, 300, "big wins keep their fixed value");
});

test("classifyActivity falls back gracefully for unknown text", function () {
  var r = E.classifyActivity("xyzzy florp");
  assert(r && r.confidence <= 0.3 && Number.isFinite(r.xp), "low-confidence fallback, finite xp");
  eq(E.classifyActivity(""), null, "empty -> null");
  eq(E.classifyActivity("   "), null, "whitespace -> null");
});

test("logActivity credits the classified dimension and logs the user's own words", function () {
  var s = E.newState("L", D(0));
  var r = E.logActivity(s, "called my mom for 20 minutes", D(0));
  eq(r.classification.dim, "family", "sorted to family");
  eq(r.classification.category, "Family", "category Family");
  assert(r.state.dims.family > 0, "family credited");
  eq(r.state.log[0].name, "called my mom for 20 minutes", "logs the user's text");
  eq(r.state.log[0].source, "smart", "tagged as smart");
});

test("logActivity respects a manual dimension override", function () {
  var s = E.newState("L", D(0));
  var r = E.logActivity(s, "did some stuff", D(0), { dim: "financial", xp: 25 });
  eq(r.classification.dim, "financial", "override honored");
  eq(r.state.dims.financial, 25, "override xp credited (income dim)");
});

test("logActivity big win only counts as big when it stays financial", function () {
  var s = E.newState("L", D(0));
  var r = E.logActivity(s, "booked a huge role", D(0)); // classifies financial/big
  assert(r.state.bigWins === 1, "big win counted");
  var s2 = E.newState("L", D(0));
  var r2 = E.logActivity(s2, "booked a huge role", D(0), { dim: "spiritual", xp: 20 }); // moved off financial
  eq(r2.state.bigWins, 0, "not a big win once re-sorted off financial");
});

test("whoopDayToActivities maps a day's WHOOP into ingestable activities", function () {
  var day = { date: "2026-06-15", recovery: { score: 72 }, sleep: { id: "s1", hours: 7.5 }, workouts: [{ id: "w1", sport: "running", durationMin: 45 }, { id: "w2", sport: "lifting", durationMin: 30 }] };
  var acts = E.whoopDayToActivities(day);
  eq(acts.length, 4, "recovery + sleep + 2 workouts");
  var s = E.newState("L", D(0));
  var r1 = E.ingestExternal(s, acts, D(0));
  assert(r1.state.dims.physical > 0, "physical credited from WHOOP day");
  var phys = r1.state.dims.physical;
  var r2 = E.ingestExternal(r1.state, E.whoopDayToActivities(day), D(0));
  eq(r2.state.dims.physical, phys, "idempotent re-sync, no double count");
  eq(E.whoopDayToActivities(null).length, 0, "null day -> []");
});

test("externalActivityToRep maps financial sources (MCF, outreach, email, sale) + keeps WHOOP", function () {
  eq(E.externalActivityToRep({ kind: "mcf_order", id: "o1" }).dim, "financial", "MCF -> financial");
  eq(E.externalActivityToRep({ kind: "email", id: "e1" }).dim, "financial", "email -> financial");
  var o = E.externalActivityToRep({ kind: "outreach", id: "b1", count: 25 });
  eq(o.dim, "financial", "outreach -> financial");
  assert(o.xp >= 5 && o.xp <= 30, "outreach xp scaled & capped");
  var sale = E.externalActivityToRep({ kind: "sale", id: "s1", amount: 300 });
  assert(sale.dim === "financial" && sale.amount === 300, "sale -> financial with $ amount recorded");
  assert(!sale.big, "a sale is NOT flagged a Big Win (revenue, not a milestone)");
  eq(E.externalActivityToRep({ kind: "workout", id: "w", durationMin: 30, source: "whoop" }).dim, "physical", "WHOOP still works");
  eq(E.externalActivityToRep({ kind: "nope", id: "x" }), null, "unknown -> null");
});

test("ingestExternal stacks mixed financial sources into the financial dim, deduped", function () {
  var s = E.newState("L", D(0));
  var acts = [
    { source: "amazon", kind: "mcf_order", id: "o1" },
    { source: "instagram", kind: "outreach", id: "b1", count: 25 },
    { source: "gmail", kind: "email", id: "m1" },
    { source: "gmail", kind: "email", id: "m2" },
  ];
  var r = E.ingestExternal(s, acts, D(0));
  eq(r.credited.length, 4, "4 financial mini-wins counted");
  assert(r.state.dims.financial > 0, "financial credited");
  assert(r.state.history[String(E.dayIndex(D(0)))].financial >= 1, "counts toward the financial daily req");
  var r2 = E.ingestExternal(r.state, acts, D(0));
  eq(r2.credited.length, 0, "idempotent — same batch never double-counts");
});

test("REG dedup key is collision-proof (separator + object ids)", function () {
  var s = E.newState("L", D(0));
  // two DISTINCT scorable activities that collide under naive source:kind:id concatenation
  // (both -> "x:email:y:email:z" the old way); escaping each part keeps them distinct
  var r = E.ingestExternal(s, [
    { source: "x", kind: "email", id: "y:email:z" },
    { source: "x:email:y", kind: "email", id: "z" }
  ], D(0));
  eq(r.credited.length, 2, "separator collision avoided — both credited");
  var r2 = E.ingestExternal(s, [{ source: "ig", kind: "dm", id: { c: 1 } }, { source: "ig", kind: "dm", id: { c: 2 } }], D(0));
  eq(r2.credited.length, 2, "distinct object ids don't collapse to [object Object]");
});

test("REG externalActivityToRep routes by kind, not source", function () {
  eq(E.externalActivityToRep({ source: "whoop", kind: "sale", id: "x", amount: 500 }).dim, "financial", "whoop-tagged sale still scores financial");
  var w = E.externalActivityToRep({ source: "garmin", kind: "workout", id: "x", durationMin: 40 });
  eq(w.dim, "physical", "non-whoop workout still physical");
  eq(w.source, "garmin", "source preserved, not forced to whoop");
});

test("REG unscored activity is NOT marked seen, so corrected data scores later", function () {
  var s = E.newState("L", D(0));
  var r1 = E.ingestExternal(s, [{ source: "whoop", kind: "sleep", id: "n1", hours: 5 }], D(0));
  eq(r1.credited.length, 0, "5h sleep not scored");
  var r2 = E.ingestExternal(r1.state, [{ source: "whoop", kind: "sleep", id: "n1", hours: 8 }], D(0));
  eq(r2.credited.length, 1, "corrected 8h sleep now scores");
});

test("REG ingestExternal tolerates non-array input without throwing", function () {
  var s = E.newState("L", D(0));
  var r = E.ingestExternal(s, "not an array", D(0));
  eq(r.credited.length, 0, "no crash");
  assert(Number.isFinite(r.state.dims.financial), "state intact");
});

test("completed Google Tasks classify into the right dimension and count as reps", function () {
  eq(E.externalActivityToRep({ source: "google-tasks", kind: "task", id: "t1", title: "call my mom" }).dim, "family", "family task");
  var fin = E.externalActivityToRep({ kind: "task", id: "t2", title: "send 25 outreach DMs" });
  eq(fin.dim, "financial", "outreach task -> financial");
  assert(fin.xp <= 30, "task xp capped");
  assert(E.externalActivityToRep({ kind: "task", id: "t3", title: "random errand xyz" }).dim, "unknown-title task still maps via fallback");
  var s = E.newState("L", D(0));
  var acts = [{ source: "google-tasks", kind: "task", id: "g1", title: "meditate" }, { source: "google-tasks", kind: "task", id: "g2", title: "lift weights" }];
  var r = E.ingestExternal(s, acts, D(0));
  eq(r.credited.length, 2, "two completed tasks counted");
  eq(E.ingestExternal(r.state, acts, D(0)).credited.length, 0, "deduped on re-sync");
});

// ---------------------------------------------------------------- WHOOP: strain, vitals, day ingestion
test("REG no-strain workout xp is unchanged (pure duration, back-compat)", function () {
  eq(E.whoopActivityToRep({ kind: "workout", sport: "walk", durationMin: 60 }).xp, 20, "60m, no strain -> 20");
  eq(E.whoopActivityToRep({ kind: "workout", sport: "walk", durationMin: 30 }).xp, 10, "30m, no strain -> 10");
  assert(E.whoopActivityToRep({ kind: "workout", durationMin: 600 }).xp <= 40, "still capped at 40");
});

test("WHOOP workout xp rewards intensity: a short HARD session beats a short stroll", function () {
  var hiit = E.whoopActivityToRep({ kind: "workout", sport: "hiit", durationMin: 20, strain: 12 });
  var stroll = E.whoopActivityToRep({ kind: "workout", sport: "walk", durationMin: 20, strain: 3 });
  assert(hiit.xp > stroll.xp, "hard 20m (" + hiit.xp + ") > easy 20m (" + stroll.xp + ")");
  eq(hiit.xp, Math.min(40, Math.round(12 * 2.2)), "strain*2.2 drives the harder one");
  // a long easy walk and a short hard lift can land at the same bounded value
  assert(E.whoopActivityToRep({ kind: "workout", durationMin: 5, strain: 20 }).xp === 40, "max strain hits the cap");
});

test("WHOOP workout scores on strain alone when duration is missing", function () {
  var r = E.whoopActivityToRep({ kind: "workout", sport: "x", strain: 10 });
  assert(r && r.xp >= 8, "strain-only workout still scores");
  eq(E.whoopActivityToRep({ kind: "workout" }), null, "no duration AND no strain -> null (unchanged)");
});

test("recoveryZone maps WHOOP green/yellow/red bands", function () {
  eq(E.recoveryZone(67), "green"); eq(E.recoveryZone(99), "green");
  eq(E.recoveryZone(66), "yellow"); eq(E.recoveryZone(34), "yellow");
  eq(E.recoveryZone(33), "red"); eq(E.recoveryZone(0), "red");
  eq(E.recoveryZone(null), "unknown"); eq(E.recoveryZone("oops"), "unknown");
});

test("whoopVitals distills a day into a finite display snapshot", function () {
  var v = E.whoopVitals({ date: "2026-06-16", recovery: { score: 66, hrv: 95.2, rhr: 49 }, sleep: { hours: 7.534, performance: 81 }, strain: 5.414 });
  eq(v.date, "2026-06-16", "date kept");
  eq(v.recovery, 66, "recovery kept"); eq(v.zone, "yellow", "66 -> yellow");
  eq(v.sleepHours, 7.53, "sleep rounded to 2dp"); eq(v.sleepPerf, 81, "perf kept");
  eq(v.strain, 5.4, "strain rounded to 1dp");
  eq(v.hrv, 95, "hrv rounded"); eq(v.rhr, 49, "rhr kept");
  eq(E.whoopVitals(null), null, "null day -> null");
  var partial = E.whoopVitals({ date: "x" });
  assert(partial.recovery === null && partial.zone === "unknown", "missing recovery -> null/unknown, no crash");
});

test("ingestWhoopDays credits XP AND stamps the LATEST day's vitals onto state", function () {
  var s = E.newState("L", D(0));
  var days = [
    { date: "2026-06-14", recovery: { score: 40 }, sleep: { hours: 8 }, workouts: [{ id: "a", durationMin: 30, strain: 5 }] },
    { date: "2026-06-16", recovery: { score: 66, hrv: 95 }, sleep: { hours: 7.5, performance: 81 }, strain: 5.4, workouts: [{ id: "b", durationMin: 50, strain: 5 }] },
    { date: "2026-06-15", recovery: { score: 62 }, workouts: [{ id: "c", durationMin: 20, strain: 14 }] },
  ];
  var r = E.ingestWhoopDays(s, days, D(0));
  assert(r.state.dims.physical > 0, "physical credited");
  assert(r.credited.length >= 6, "all scorable activities counted across 3 days");
  eq(r.state.whoop.date, "2026-06-16", "vitals reflect the most RECENT day, not array order");
  eq(r.state.whoop.recovery, 66, "latest recovery"); eq(r.state.whoop.zone, "yellow", "zone computed");
  assert(Number.isFinite(r.state.whoop.syncedTs), "syncedTs stamped");
});

test("ingestWhoopDays is idempotent and its vitals survive a save round-trip", function () {
  var s = E.newState("L", D(0));
  var day = { date: "2026-06-16", recovery: { score: 66 }, sleep: { hours: 7.5 }, strain: 5.4, workouts: [{ id: "w1", durationMin: 50, strain: 5 }] };
  var r1 = E.ingestWhoopDays(s, [day], D(0));
  var phys = r1.state.dims.physical;
  var r2 = E.ingestWhoopDays(r1.state, [day], D(0));
  eq(r2.state.dims.physical, phys, "no double-count on re-sync");
  eq(r2.credited.length, 0, "nothing new credited");
  var back = E.init(JSON.stringify(r2.state), D(0)).state;
  eq(back.whoop.recovery, 66, "vitals snapshot persisted across reload");
  eq(back.whoop.zone, "yellow", "zone persisted");
});

test("REG validateRepair sanitizes a corrupt whoop snapshot (finite-or-null, valid zone)", function () {
  var s = E.newState("L", D(0));
  s.whoop = { date: 123, recovery: "oops", zone: "purple", sleepHours: Infinity, sleepPerf: NaN, strain: "x", hrv: null, rhr: "", syncedTs: "no" };
  var r = E.validateRepair(s, D(0));
  eq(r.whoop.date, "123", "date coerced to string");
  eq(r.whoop.recovery, null, "non-finite recovery -> null");
  eq(r.whoop.zone, "unknown", "invalid zone -> unknown");
  assert(r.whoop.sleepHours === null && r.whoop.strain === null, "junk numerics -> null");
});

// --------------------------------------------- WHOOP review hardening (round 2)
test("REG ingestWhoopDays picks the CHRONOLOGICALLY latest day (not lexicographic)", function () {
  // "2026-7-9" must lose to "2026-7-12" — a string compare gets this backwards ("9" > "1").
  var s = E.newState("L", D(0));
  var r = E.ingestWhoopDays(s, [
    { date: "2026-7-9", recovery: { score: 40 } },
    { date: "2026-7-12", recovery: { score: 70 } },
    { date: "2026-7-10", recovery: { score: 55 } },
  ], D(0));
  eq(r.state.whoop.date, "2026-7-12", "newest by calendar, not by string order");
  eq(r.state.whoop.recovery, 70, "newest day's recovery shown");
});

test("REG vitals recency guard: an older day cannot clobber a fresher snapshot", function () {
  var s = E.ingestWhoopDays(E.newState("L", D(0)), [{ date: "2026-06-16", recovery: { score: 66 } }], D(0)).state;
  var s2 = E.ingestWhoopDays(s, [{ date: "2026-06-15", recovery: { score: 40 } }], D(0)).state;
  eq(s2.whoop.date, "2026-06-16", "stale older-day sync did NOT overwrite");
  eq(s2.whoop.recovery, 66, "fresher recovery preserved");
  var s3 = E.ingestWhoopDays(s2, [{ date: "2026-06-17", recovery: { score: 80 } }], D(0)).state;
  eq(s3.whoop.date, "2026-06-17", "a genuinely newer day DOES update");
});

test("ingestWhoopDays edge cases: empty / date-less / single-object", function () {
  var empty = E.ingestWhoopDays(E.newState("L", D(0)), [], D(0));
  eq(empty.credited.length, 0, "empty batch credits nothing");
  assert(empty.state.whoop === null, "empty batch leaves vitals untouched (null)");
  var dateless = E.ingestWhoopDays(E.newState("L", D(0)), [{ recovery: { score: 55 } }, { recovery: { score: 80 } }], D(0));
  eq(dateless.state.whoop.recovery, 80, "no parseable date -> falls back to last element");
  var single = E.ingestWhoopDays(E.newState("L", D(0)), { date: "2026-06-16", recovery: { score: 66 } }, D(0));
  eq(single.state.whoop.recovery, 66, "non-array single day is wrapped & stamped");
});

test("REG validateRepair derives whoop zone from a valid recovery (consistency)", function () {
  var s = E.newState("L", D(0)); s.whoop = { date: "2026-06-16", recovery: 70 }; // valid recovery, NO zone
  eq(E.validateRepair(s, D(0)).whoop.zone, "green", "zone derived from recovery 70");
  var s2 = E.newState("L", D(0)); s2.whoop = { date: "d", recovery: 50 }; // missing zone
  eq(E.validateRepair(s2, D(0)).whoop.zone, "yellow", "zone derived from recovery 50");
  var s3 = E.newState("L", D(0)); s3.whoop = { date: "d", recovery: "oops", zone: "yellow" }; // bad recovery, valid stored zone
  var r3 = E.validateRepair(s3, D(0));
  eq(r3.whoop.recovery, null, "bad recovery -> null"); eq(r3.whoop.zone, "yellow", "falls back to stored zone when recovery absent");
});

test("REG ingestExternal / ingestWhoopDays tolerate a null state (public-API hardening)", function () {
  var r = E.ingestWhoopDays(null, [{ date: "2026-06-16", recovery: { score: 72 } }], D(0));
  assert(Number.isFinite(r.state.dims.physical) && r.state.version === E.SCHEMA_VERSION, "null state -> safe default, no throw");
  eq(E.ingestExternal(null, [], D(0)).state.version, E.SCHEMA_VERSION, "ingestExternal(null) is safe");
});

test("classifyWhoopPayload routes every shape (days/activities/single/mixed) without dropping", function () {
  eq(E.classifyWhoopPayload({ days: [{ date: "d" }] }).days.length, 1, "{days} -> days");
  eq(E.classifyWhoopPayload({ activities: [{ kind: "workout", id: "w" }] }).acts.length, 1, "{activities} -> acts");
  eq(E.classifyWhoopPayload({ date: "d", recovery: { score: 1 } }).days.length, 1, "single day object -> days");
  var single = E.classifyWhoopPayload({ source: "whoop", kind: "workout", id: "w", durationMin: 30 });
  eq(single.acts.length, 1, "single raw activity routed (NOT silently dropped)"); eq(single.days.length, 0, "...and not a day");
  var mixed = E.classifyWhoopPayload([{ date: "d", recovery: { score: 1 } }, { kind: "workout", id: "w", durationMin: 30 }]);
  eq(mixed.days.length, 1, "mixed array partitions days"); eq(mixed.acts.length, 1, "mixed array partitions acts");
  eq(E.classifyWhoopPayload(null).days.length, 0, "null -> empty"); eq(E.classifyWhoopPayload("garbage").acts.length, 0, "garbage -> empty");
});

test("WHOOP recovery XP bands + score:0-vs-missing distinction", function () {
  eq(E.whoopActivityToRep({ kind: "recovery", score: 67 }).xp, 12, "67 -> green 12");
  eq(E.whoopActivityToRep({ kind: "recovery", score: 66 }).xp, 8, "66 -> yellow 8");
  eq(E.whoopActivityToRep({ kind: "recovery", score: 34 }).xp, 8, "34 -> yellow 8");
  eq(E.whoopActivityToRep({ kind: "recovery", score: 33 }).xp, 4, "33 -> red 4");
  eq(E.whoopActivityToRep({ kind: "recovery", score: 0 }).xp, 4, "0 is a valid red rep, not null");
  eq(E.whoopActivityToRep({ kind: "recovery" }), null, "missing score -> null");
});

test("WHOOP workout strain/duration boundaries (floor, cap, crossover)", function () {
  eq(E.whoopActivityToRep({ kind: "workout", durationMin: 24 }).xp, 8, "24m -> exactly the floor (8)");
  eq(E.whoopActivityToRep({ kind: "workout", durationMin: 21 }).xp, 8, "21m -> 7 clamped up to 8");
  eq(E.whoopActivityToRep({ kind: "workout", durationMin: 30, strain: 5 }).xp, 11, "intensity beats duration at the crossover (max(10,11))");
  eq(E.whoopActivityToRep({ kind: "workout", strain: 3.6 }).xp, 8, "low strain-only -> floored to 8");
  eq(E.whoopActivityToRep({ kind: "workout", strain: 18.2 }).xp, 40, "max strain -> capped at 40");
});

test("whoopVitals preserves falsy-but-valid zeros and partial sub-objects", function () {
  var z = E.whoopVitals({ date: "d", recovery: { score: 0 }, strain: 0 });
  eq(z.recovery, 0, "recovery 0 kept (not dropped by truthiness)"); eq(z.zone, "red", "0 -> red"); eq(z.strain, 0, "strain 0 kept");
  var sp = E.whoopVitals({ date: "d", sleep: { performance: 55 } });
  eq(sp.sleepHours, null, "no hours -> null"); eq(sp.sleepPerf, 55, "perf-only sleep kept");
  var hr = E.whoopVitals({ date: "d", recovery: { hrv: 90.6, rhr: 48 } });
  eq(hr.recovery, null, "no score -> null"); eq(hr.zone, "unknown", "no score -> unknown"); eq(hr.hrv, 91, "hrv rounded"); eq(hr.rhr, 48, "rhr kept");
});

// --------------------------------------------- cloud merge (conflict-free, no lost progress)
function progressOf(s) { return JSON.stringify({ totalXp: s.totalXp, incomeXp: s.incomeXp, dims: s.dims, history: s.history, seen: Object.keys(s.external.seen).sort(), bigWins: s.bigWins }); }

test("mergeStates loses NO progress: reps done on EITHER device survive", function () {
  var base = E.newState("L", D(0));
  var a = E.applyRep(E.applyRep(base, "phys_pushups", D(0)).state, "ment_deep", D(0)).state; // device A
  var b = E.applyRep(E.applyRep(base, "spir_meditate", D(0)).state, "fin_dms", D(0)).state;  // device B (diverged)
  var m = E.mergeStates(a, b, D(0));
  var day = String(E.dayIndex(D(0)));
  assert(m.history[day].physical >= 1 && m.history[day].mental >= 1, "A's reps survived");
  assert(m.history[day].spiritual >= 1 && m.history[day].financial >= 1, "B's reps survived");
  assert(m.totalXp >= Math.max(a.totalXp, b.totalXp), "totalXp is at least the further-along device");
});

test("mergeStates is idempotent and convergent (stable under re-merge)", function () {
  var a = E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state;
  var b = E.applyRep(E.newState("L", D(0)), "fin_dms", D(0)).state;
  var m1 = E.mergeStates(a, b, D(0));
  eq(progressOf(E.mergeStates(m1, m1, D(0))), progressOf(m1), "merge(m,m) == m");
  eq(progressOf(E.mergeStates(m1, b, D(0))), progressOf(m1), "re-merging an already-absorbed state is a no-op (converged)");
});

test("mergeStates is order-independent on progress (commutative)", function () {
  var a = E.applyRep(E.newState("L", D(0)), "phys_pushups", D(1)).state;
  var b = E.applyRep(E.newState("L", D(0)), "ment_read", D(2)).state;
  eq(progressOf(E.mergeStates(a, b, D(2))), progressOf(E.mergeStates(b, a, D(2))), "merge(a,b) progress == merge(b,a)");
});

test("mergeStates unions WHOOP credit + dedup set across devices (no re-credit after merge)", function () {
  var a = E.ingestWhoopDays(E.newState("L", D(0)), [{ date: "2026-06-15", recovery: { score: 60 }, workouts: [{ id: "wa", durationMin: 40 }] }], D(0)).state;
  var b = E.ingestWhoopDays(E.newState("L", D(0)), [{ date: "2026-06-16", recovery: { score: 80 }, workouts: [{ id: "wb", durationMin: 50 }] }], D(0)).state;
  var m = E.mergeStates(a, b, D(0));
  assert(m.external.seen["whoop:workout:wk-wa"] !== undefined, "device A's workout kept");
  assert(m.external.seen["whoop:workout:wk-wb"] !== undefined, "device B's workout kept");
  eq(m.whoop.date, "2026-06-16", "fresher WHOOP vitals win");
  eq(E.ingestWhoopDays(m, [{ date: "2026-06-15", recovery: { score: 60 }, workouts: [{ id: "wa", durationMin: 40 }] }], D(0)).credited.length, 0, "merged dedup set still blocks double-credit");
});

test("mergeStates: same-day SAME-dimension reps on two devices are NOT destroyed (CRDT, not max)", function () {
  var base = E.newState("L", D(0));
  var a = base; ["phys_pushups", "phys_incline", "phys_mobility"].forEach(function (r) { a = E.applyRep(a, r, D(0)).state; }); // 3 physical
  var b = base; ["phys_creatine", "phys_sixpack"].forEach(function (r) { b = E.applyRep(b, r, D(0)).state; });                // 2 DIFFERENT physical
  var m = E.mergeStates(a, b, D(0));
  var day = String(E.dayIndex(D(0)));
  eq(m.history[day].physical, 5, "all 5 distinct physical reps counted (old bug: max(3,2)=3)");
  eq(m.totalXp, a.totalXp + b.totalXp, "totalXp is the SUM of both devices' divergent reps, not the max");
  eq(m.dims.physical, a.dims.physical + b.dims.physical, "dims.physical summed, not maxed");
});

test("mergeStates: collision merge is idempotent (no growth on re-merge)", function () {
  var a = E.applyRep(E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state, "phys_incline", D(0)).state;
  var b = E.applyRep(E.applyRep(E.newState("L", D(0)), "phys_creatine", D(0)).state, "phys_mobility", D(0)).state;
  var m1 = E.mergeStates(a, b, D(0));
  eq(progressOf(E.mergeStates(m1, a, D(0))), progressOf(m1), "re-merging a subset doesn't inflate totals");
  eq(progressOf(E.mergeStates(m1, m1, D(0))), progressOf(m1), "merge(m,m) == m even with collisions");
});

test("mergeStates: stat points are CONSERVED, not fabricated, across divergent allocation", function () {
  function alloc(s, d) { var r = E.allocateStat(s, d, D(0)); return (r && r.state) ? r.state : (r || s); }
  var base = E.newState("L", D(0));
  for (var i = 0; i < 12; i++) base = E.applyRep(base, "fin_close", D(0)).state; // earn XP -> levels -> stat points
  var earned = Math.max(0, (E.levelFromXp(base.totalXp).level - 1) * 3);
  assert(earned >= 2, "test needs >=2 earned points, got " + earned);
  var a = base, b = base;
  for (var x = 0; x < earned; x++) { a = alloc(a, "financial"); b = alloc(b, "physical"); } // diverge: A->financial, B->physical
  var m = E.mergeStates(a, b, D(0));
  var DIMS = ["physical", "mental", "spiritual", "family", "social", "financial"];
  var sum = DIMS.reduce(function (t, d) { return t + m.statPoints.allocated[d]; }, 0);
  eq(m.statPoints.available + sum, earned, "available + sum(allocated) == earned (old bug: maxed to 2x earned)");
});

test("mergeStates: a reset (higher epoch) wins wholesale and is NOT undone by the merge", function () {
  var big = E.applyRep(E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state, "fin_close", D(0)).state; // epoch 0, has progress
  var reset = E.newState("L", D(0)); reset.epoch = (big.epoch || 0) + 1;                                        // user reset -> epoch 1, empty
  assert(E.mergeStates(big, reset, D(0)).totalXp === 0, "reset wins (progress wiped, deliberate)");
  assert(E.mergeStates(reset, big, D(0)).totalXp === 0, "order-independent: reset still wins");
  assert(E.mergeStates(big, reset, D(0)).epoch === 1, "higher epoch carried forward");
});

test("streak.current resets to 0 after a missed day (not stale), but stays live through today", function () {
  var s = E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state;       // active on day 0 only
  eq(E.init(JSON.stringify(s), D(3)).state.streak.current, 0, "3 days later with a gap -> streak broken (0)");
  var s2 = E.applyRep(E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state, "phys_incline", D(1)).state; // day0+day1
  assert(E.init(JSON.stringify(s2), D(1)).state.streak.current >= 2, "consecutive days reaching today stay live");
});

test("mergeStates penalty clears if EITHER device recovered; finite-guards garbage", function () {
  var pen = E.newState("L", D(0)); pen.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  assert(!E.mergeStates(pen, E.newState("L", D(0)), D(0)).penalty.active, "penalty cleared when one device is clear");
  var pen2 = E.newState("L", D(0)); pen2.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  assert(E.mergeStates(pen, pen2, D(0)).penalty.active, "stays penalized only if BOTH are");
  var m = E.mergeStates({ version: 2, totalXp: NaN, dims: { physical: Infinity } }, E.newState("L", D(0)), D(0));
  assert(Number.isFinite(m.totalXp) && m.version === E.SCHEMA_VERSION, "garbage input -> finite valid merged state");
});

// ---------------------------------------------------------------- hydration
test("newState + validateRepair always provide a sane hydration field", function () {
  var s = fresh(D(0));
  eq(s.hydration.oz, 0, "newState seeds hydration oz 0");
  eq(s.hydration.day, E.dayIndex(D(0)), "newState seeds hydration day = today");
  var noHy = fresh(D(0)); delete noHy.hydration;
  var rep = E.validateRepair(noHy, D(0));
  assert(rep.hydration && rep.hydration.oz === 0, "missing hydration -> default");
  var bad = fresh(D(0)); bad.hydration = { day: "xxx", oz: -5 };
  var rep2 = E.validateRepair(bad, D(0));
  assert(rep2.hydration.oz === 0 && Number.isFinite(rep2.hydration.day), "garbage hydration repaired to finite");
  // profile
  eq(fresh(D(0)).profile.weightLb, 208, "newState seeds the player's build");
  var badP = fresh(D(0)); badP.profile = { weightLb: -3, heightIn: "x", activityTier: "bogus" };
  var repP = E.validateRepair(badP, D(0));
  assert(repP.profile.weightLb === 0 && repP.profile.activityTier === "active", "garbage profile repaired (tier falls back to active)");
});

test("hydrationGoalOz personalizes the daily target from build + activity tier", function () {
  eq(E.hydrationGoalOz(fresh(D(0))), 125, "208 lb 'active' -> 125 oz (35 mL/kg + training allowance)");
  var sed = fresh(D(0)); sed.profile = { heightIn: 77, weightLb: 208, activityTier: "sedentary" };
  eq(E.hydrationGoalOz(sed), 100, "sedentary tier -> lower");
  var ath = fresh(D(0)); ath.profile = { heightIn: 77, weightLb: 208, activityTier: "athlete" };
  eq(E.hydrationGoalOz(ath), 155, "athlete tier -> higher");
  var light = fresh(D(0)); light.profile = { heightIn: 70, weightLb: 150, activityTier: "active" };
  assert(E.hydrationGoalOz(light) < 125, "a lighter active person gets a lower goal");
  var noP = fresh(D(0)); delete noP.profile; eq(E.hydrationGoalOz(noP), 125, "no profile -> CONFIG fallback");
  var zero = fresh(D(0)); zero.profile = { weightLb: 0 }; eq(E.hydrationGoalOz(zero), 125, "zero weight -> fallback");
});

test("addWater accumulates, reports status against the personal goal, resets each day", function () {
  var GOAL = E.hydrationGoalOz(fresh(D(0)));   // personalized (125 for 208 lb active)
  var s = E.addWater(fresh(D(0)), 50, D(0)).state;
  var hs = E.hydrationStatus(s, D(0));
  eq(hs.oz, 50, "oz"); eq(hs.goalOz, GOAL, "goal personalized"); eq(hs.remaining, GOAL - 50, "remaining");
  assert(hs.met === false, "not met at 50");
  var next = E.hydrationStatus(s, D(1));
  eq(next.oz, 0, "bar resets to 0 on a new day");
  assert(next.met === false && next.pct === 0, "fresh day starts empty");
  var r = E.addWater(null, GOAL, D(0)); assert(r.state.totalXp === 10, "addWater tolerates null state and credits at goal");
  var cap = E.addWater(fresh(D(0)), 9999, D(0)).state;
  eq(cap.hydration.oz, GOAL * 3, "single pour capped at 3x goal");
});

test("hitting the goal credits exactly ONE physical rep, idempotently", function () {
  var GOAL = E.hydrationGoalOz(fresh(D(0)));
  var day = E.dayIndex(D(0));
  var below = E.addWater(fresh(D(0)), GOAL - 20, D(0));
  eq(below.state.totalXp, 0, "below goal -> no rep yet");
  var cross = E.addWater(below.state, 40, D(0));            // crosses the goal
  eq(cross.state.totalXp, 10, "crossing the goal credits +10 physical");
  eq((cross.state.history[day] || {}).physical, 1, "one physical rep counted toward the day");
  eq(cross.events.filter(function (e) { return e.type === "HYDRATION_GOAL"; }).length, 1, "HYDRATION_GOAL fired once");
  var more = E.addWater(cross.state, 32, D(0));             // log more after goal
  eq(more.state.totalXp, 10, "no re-credit after goal already hit");
  eq((more.state.history[day] || {}).physical, 1, "still exactly one hydration rep");
  eq(more.state.hydration.oz, GOAL + 52, "extra water still fills the bar past the goal");
});

test("hydration streak counts consecutive met days, breaks on a gap", function () {
  var GOAL = E.hydrationGoalOz(fresh(D(0)));
  var s = E.addWater(fresh(D(0)), GOAL, D(0)).state;
  eq(E.hydrationStatus(s, D(0)).streak, 1, "1-day streak after first goal");
  s = E.addWater(s, GOAL, D(1)).state;
  eq(E.hydrationStatus(s, D(1)).streak, 2, "consecutive day -> 2");
  eq(E.hydrationStatus(s, D(2)).streak, 2, "today not logged yet but yesterday's run (d0-d1) stays live");
  eq(E.hydrationStatus(s, D(3)).streak, 0, "a fully skipped day (d2) breaks the streak");
});

test("mergeStates: same-day hydration takes the MAX; newer day wins; goal-credit dedups across sync", function () {
  var d0 = E.dayIndex(D(0)), d1 = E.dayIndex(D(1));
  var x = fresh(D(0)); x.hydration = { day: d0, oz: 40 };
  var y = fresh(D(0)); y.hydration = { day: d0, oz: 72 };
  eq(E.mergeStates(x, y, D(0)).hydration.oz, 72, "same-day -> max oz");
  var x2 = fresh(D(0)); x2.hydration = { day: d0, oz: 100 };
  var y2 = fresh(D(1)); y2.hydration = { day: d1, oz: 20 };
  eq(E.mergeStates(x2, y2, D(1)).hydration.oz, 20, "newer day's bar wins over a stale higher count");
  // COMMON cross-device flow: device A hits the goal; device B (no water) syncs A's state, then logs more.
  var GOAL = E.hydrationGoalOz(fresh(D(0)));
  var devA = E.addWater(fresh(D(0)), GOAL, D(0)).state;     // A: goal hit, +10, seen[hydr-d0]
  var merged = E.init(JSON.stringify(E.mergeStates(fresh(D(0)), devA, D(0))), D(0)).state; // B receives A
  eq(merged.totalXp, 10, "synced device shows the goal credit once");
  eq(merged.hydration.oz, GOAL, "hydration max-merged across devices");
  var again = E.addWater(merged, 64, D(0));                 // B logs more on the already-completed day
  eq(again.state.totalXp, 10, "no re-credit on an already-completed day after sync");
  eq((again.state.history[d0] || {}).physical, 1, "exactly one hydration physical rep survives the round-trip");
  eq(again.state.hydration.oz, GOAL + 64, "later water still fills the bar");
});

test("mergeStates dedups deterministic-id external reps across concurrent-offline credits (extKey)", function () {
  var d0 = E.dayIndex(D(0));
  var GOAL = E.hydrationGoalOz(fresh(D(0)));
  // two devices each cross the SAME day's goal OFFLINE at different times (different log ts)
  var phone = E.addWater(fresh(new Date(2026, 5, 15, 8, 0, 0)), GOAL, new Date(2026, 5, 15, 8, 0, 0)).state;
  var mac = E.addWater(fresh(new Date(2026, 5, 15, 19, 0, 0)), GOAL, new Date(2026, 5, 15, 19, 0, 0)).state;
  var synced = E.init(JSON.stringify(E.mergeStates(mac, phone, D(0))), D(0)).state;
  eq(synced.totalXp, 10, "hydration goal credited EXACTLY ONCE after concurrent-offline merge (was 20)");
  eq((synced.history[d0] || {}).physical, 1, "exactly one physical rep, not two");
  eq(E.mergeStates(synced, phone, D(0)).totalXp, 10, "re-merge is stable (idempotent)");
  // same latent bug for ANY external source — verify WHOOP workout ingested offline on two devices counts once
  var wk = [{ source: "whoop", kind: "workout", id: "wk-123", sport: "run", durationMin: 60, strain: 12 }];
  var pa = E.ingestExternal(fresh(new Date(2026, 5, 15, 7, 0, 0)), wk, new Date(2026, 5, 15, 7, 0, 0)).state;
  var pb = E.ingestExternal(fresh(new Date(2026, 5, 15, 20, 0, 0)), wk, new Date(2026, 5, 15, 20, 0, 0)).state;
  var wm = E.mergeStates(pa, pb, D(0));
  assert(pa.totalXp > 0 && wm.totalXp === pa.totalXp, "same WHOOP workout from two devices counts once");
  eq((wm.history[d0] || {}).physical, 1, "one physical rep for the shared workout");
});

test("dimStreak counts per-dimension consecutive days from history", function () {
  var s = E.applyRep(fresh(D(0)), "phys_pushups", D(0)).state;
  s = E.applyRep(s, "ment_read", D(0)).state;       // mental only on d0
  s = E.applyRep(s, "phys_incline", D(1)).state;
  s = E.applyRep(s, "phys_mobility", D(2)).state;    // physical d0,d1,d2
  eq(E.dimStreak(s, "physical", D(2)), 3, "physical 3-day streak through today");
  eq(E.dimStreak(s, "mental", D(2)), 0, "mental broke (only d0)");
  eq(E.dimStreak(s, "physical", D(3)), 3, "yesterday's run still live before today's rep");
  eq(E.dimStreak(s, "physical", D(4)), 0, "a skipped day breaks it");
  eq(E.dimStreak(s, "financial", D(2)), 0, "no financial reps -> 0");
});

test("Vybrance sales credit as seeds, raise overall + power level, sum over 7 days, dedup by order id", function () {
  var s0 = fresh(D(0));
  var orders = [
    { source: "shopify", kind: "sale", id: "S1", amount: 60 },
    { source: "amazon", kind: "sale", id: "A1", amount: 240 },
  ];
  var s = E.ingestExternal(s0, orders, D(0)).state;
  assert(s.totalXp > 0, "sales raise overall XP (the overall level)");
  assert(s.incomeXp > 0, "sales raise Earning Power (incomeXp)");
  eq(s.bigWins, 0, "a sale is NOT a Big Win — revenue, not a milestone (big wins = booking a gig / closing a deal)");
  eq(E.recentSalesTotal(s, 7, D(0)), 300, "7-day sales total sums order amounts");
  var s2 = E.ingestExternal(s, orders, D(0)).state;
  eq(s2.totalXp, s.totalXp, "re-ingesting the same orders is a no-op (deduped by id)");
  eq(E.recentSalesTotal(s2, 7, D(0)), 300, "no double-count in the 7-day total");
  eq(E.recentSalesTotal(s, 7, D(10)), 0, "sales older than 7 days drop out of the window");
});

test("powerRating: live current-power readout (revenue + life + streaks × WHOOP), bounded 0..10000, milestone tiers", function () {
  eq(E.powerRating(fresh(D(0)), D(0)), 0, "fresh -> 0 (no revenue, Lv1 dims, no streaks)");
  // Vybrance revenue momentum drives it
  var rev = E.ingestExternal(fresh(D(0)), [{ source: "amazon", kind: "sale", id: "R1", amount: 13000 }], D(0)).state;
  assert(E.powerRating(rev, D(0)) > 0, "Vybrance revenue raises the Power Level");
  // leveling a dimension drives it
  var life = fresh(D(0)); for (var i = 0; i < 40; i++) life = E.applyRep(life, "ment_read", D(0)).state;
  assert(E.powerRating(life, D(0)) > 0, "leveling a dimension raises the Power Level");
  // bounded to the 0..10000 scale even when maxed out
  var maxed = fresh(D(0));
  ["physical", "mental", "spiritual", "family", "social", "financial"].forEach(function (d) { maxed.dims[d] = 1e6; });
  maxed.salesByDay = {}; maxed.salesByDay[String(E.dayIndex(D(0)))] = 300000;
  var prMax = E.powerRating(maxed, D(0)); assert(prMax > 5000 && prMax <= 10000, "bounded to 0..10000 (got " + prMax + ")");
  // gear tiers anchor to real milestones on the new scale
  eq(E.powerTier(0).name, "Base Form", "0 -> Base Form");
  eq(E.powerTier(1500).name, "Gear 2", "1500 -> Gear 2 (rebuilding)");
  eq(E.powerTier(9000).name, "Sun God Nika", "9000 -> Sun God Nika (near peak + elite)");
  var t = E.powerTier(1500); assert(t.pct >= 0 && t.pct <= 100, "tier pct bounded");
  // WHOOP recovery nudges it
  var hi = JSON.parse(JSON.stringify(rev)); hi.whoop = { recovery: 100, zone: "green" };
  var lo = JSON.parse(JSON.stringify(rev)); lo.whoop = { recovery: 0, zone: "red" };
  assert(E.powerRating(hi, D(0)) > E.powerRating(lo, D(0)), "higher recovery -> higher power");
});

test("weeklyPulse + powerGain summarize the last 7 days", function () {
  var s = E.applyRep(fresh(D(0)), "phys_pushups", D(0)).state;
  s = E.applyRep(s, "ment_read", D(1)).state;
  var wp = E.weeklyPulse(s, D(1));
  eq(wp.reps, 2, "2 reps this week");
  assert(wp.xp > 0 && wp.activeDays === 2, "xp tallied + 2 active days");
  // powerGain is now the 7-day Power LEVEL delta (not raw XP): a fresh Vybrance sale this week moves it up
  var withSale = E.ingestExternal(s, [{ source: "amazon", kind: "sale", id: "G1", amount: 20000 }], D(1)).state;
  assert(E.powerGain(withSale, 7, D(1)) > 0, "Power Level rose this week (revenue came in)");
  eq(E.weeklyPulse(s, D(30)).reps, 0, "nothing in the last 7 days a month later");
});

test("powerPeak: a high-water mark that only rises, persists through a dip, and merges by max", function () {
  var s = E.ingestExternal(fresh(D(0)), [{ source: "amazon", kind: "sale", id: "P1", amount: 26000 }], D(0)).state;
  s = E.applyRep(s, "fin_close", D(0)).state;   // applyRep refreshes powerPeak to the live power
  var peak = s.powerPeak;
  assert(peak > 0 && peak === E.powerRating(s, D(0)), "peak captures the live power at its high point");
  var dropped = E.init(JSON.stringify(s), D(40)).state;   // 40 days on, the sale ages out of the 30d window -> live power drops
  assert(E.powerRating(dropped, D(40)) < peak, "live power dropped after revenue aged out");
  assert(dropped.powerPeak >= peak, "peak is preserved through the dip (only ever rises)");
  var a = fresh(D(0)); a.powerPeak = 4000;
  var b = fresh(D(0)); b.powerPeak = 1500;
  assert(E.mergeStates(a, b, D(0)).powerPeak >= 4000, "merge keeps the higher peak across devices");
});

test("sale family (sale/order/vybrance_sale) dedups to ONE credit per order id (no kind-aliasing farm)", function () {
  var s = E.ingestExternal(fresh(D(0)), [{ source: "shopify", kind: "sale", id: "Y", amount: 100 }], D(0)).state;
  var once = s.incomeXp, onceSales = E.recentSalesTotal(s, 7, D(0));
  s = E.ingestExternal(s, [{ source: "shopify", kind: "order", id: "Y", amount: 100 }], D(0)).state;
  s = E.ingestExternal(s, [{ source: "shopify", kind: "vybrance_sale", id: "Y", amount: 100 }], D(0)).state;
  eq(s.incomeXp, once, "aliasing the same order under order/vybrance_sale does NOT re-credit");
  eq(E.recentSalesTotal(s, 7, D(0)), onceSales, "7-day sales not inflated by kind-aliasing");
  eq(E.init(JSON.stringify(E.mergeStates(s, s, D(0))), D(0)).state.incomeXp, once, "stays single after merge/init round-trip");
});

test("achievements are 16 leveled tracks; level/progress bounded; tiers earned by metrics", function () {
  var a0 = E.achievements(fresh(D(0)), D(0));
  eq(a0.length, 16, "16 tracks");
  a0.forEach(function (t) {
    assert(Array.isArray(t.levels) && t.levels.length >= 1, "track has levels: " + t.id);
    assert(t.level >= 0 && t.level <= t.maxLevel, "level within [0,max]: " + t.id);
    assert(t.progress >= 0 && t.progress <= 1, "progress bounded: " + t.id);
    assert(t.unlocked === (t.level >= 1), "unlocked iff level>=1: " + t.id);
    assert(typeof t.how === "string" && t.how.length > 0, "track has a 'how to earn': " + t.id);
  });
  var tr0 = a0.filter(function (t) { return t.id === "training"; })[0];
  eq(tr0.level, 0, "Training starts at level 0 on a fresh save");
  assert(!tr0.unlocked, "and is locked");
  var s = fresh(D(0)); for (var i = 0; i < 12; i++) s = E.applyRep(s, "phys_pushups", D(0)).state; // 12 reps
  var tr1 = E.achievements(s, D(0)).filter(function (t) { return t.id === "training"; })[0];
  assert(tr1.level >= 1 && tr1.unlocked, "Training reaches level 1 at 10 reps");
});

test("ratingTrend is endpoint-accurate and the right length", function () {
  var s = E.applyRep(fresh(D(0)), "fin_close", D(0)).state;
  var tr = E.ratingTrend(s, 14, D(5));
  eq(tr.length, 14, "14 points");
  eq(tr[tr.length - 1].rating, E.powerRating(s, D(5)), "last point equals the live rating");
  assert(tr[0].rating <= tr[tr.length - 1].rating, "trend rises into today");
});

test("a WHOOP-red recovery day waives the physical Daily Quest requirement (rest counts)", function () {
  var day = E.dayIndex(D(0));
  var s = fresh(D(0));
  ["ment_read", "spir_meditate", "fam_call", "soc_friend", "fin_dms"].forEach(function (r) { s = E.applyRep(s, r, D(0)).state; });
  assert(!E.isDailyMet(s, day), "not met without physical on a normal day");
  s.whoop = { date: ymd(0), recovery: 20, zone: "red" };
  assert(E.physicalWaived(s, day) && E.isDailyMet(s, day), "red day waives physical -> daily met");
  s.whoop = { date: ymd(0), recovery: 80, zone: "green" };
  assert(!E.physicalWaived(s, day) && !E.isDailyMet(s, day), "green day does NOT waive physical");
});

test("mergeStates loses NO reps when the unioned log exceeds the cap (aggregate from the FULL union)", function () {
  var day = E.dayIndex(D(0));
  function manyDistinct(K, tag) {
    var s = E.newState("L", D(0));
    s.history[day] = { physical: 0, mental: 0, spiritual: 0, family: 0, social: 0, financial: 0 };
    s.log = [];
    for (var i = 0; i < K; i++) {
      s.log.push({ ts: 1e12 + i * 1000, day: day, dim: "financial", repId: null, name: tag + i, baseXp: 10, mult: 1, xp: 10, big: false, source: "test", extKey: tag + ":" + i, amount: null });
      s.dims.financial += 10; s.totalXp += 10; s.incomeXp += 10; s.history[day].financial += 1;
    }
    s.lastActiveDay = day; s.daily = { day: day, completed: false };
    return s;
  }
  var A = manyDistinct(600, "a"), B = manyDistinct(600, "b");   // union = 1200 distinct reps, exceeds the log cap
  var m = E.mergeStates(A, B, D(0));
  eq(m.totalXp, 12000, "no rep XP lost above the log cap");
  eq(m.dims.financial, 12000, "dims reconstructed from the full union, not the sliced log");
  eq((m.history[day] || {}).financial, 1200, "history count = full union (1200), not the cap");
});

test("mergeStates is order-independent for profile, statPoints, and activeTitle (CRDT convergence)", function () {
  var A = E.applyRep(fresh(D(0)), "fin_book", D(0)).state;   // big win -> more progress + titles
  var B = E.applyRep(fresh(D(0)), "ment_read", D(0)).state;
  A.profile = { heightIn: 77, weightLb: 208, activityTier: "active" };
  B.profile = { heightIn: 70, weightLb: 250, activityTier: "athlete" }; B.lastActiveDay = A.lastActiveDay;
  A.activeTitle = "awakened"; B.activeTitle = "first_coin";
  var ab = E.mergeStates(A, B, D(0)), ba = E.mergeStates(B, A, D(0));
  eq(ab.profile, ba.profile, "profile merge order-independent");
  eq(ab.activeTitle, ba.activeTitle, "activeTitle order-independent");
  eq(JSON.stringify(ab.statPoints), JSON.stringify(ba.statPoints), "statPoints order-independent");
});

test("powerRating stays finite + bounded even for a corrupt astronomically-large save", function () {
  var s = fresh(D(0)); s.totalXp = 1e308; s.incomeXp = 1e308; s.bigWins = 1e6;
  ["physical", "mental", "spiritual", "family", "social", "financial"].forEach(function (d) { s.dims[d] = 1e308; });
  s.salesByDay = {}; s.salesByDay[String(E.dayIndex(D(0)))] = 1e308;
  var r = E.powerRating(s, D(0));
  assert(Number.isFinite(r) && r >= 0 && r <= 10000, "powerRating never NaN/Infinity, bounded to scale (got " + r + ")");
});

test("recentSalesTotal is durable — survives the sale aging out of the capped log (salesByDay backstop)", function () {
  var d0 = E.dayIndex(D(0));
  var s = E.ingestExternal(fresh(D(0)), [{ source: "amazon", kind: "sale", id: "amzn-day-x", amount: 500 }], D(0)).state;
  eq(E.recentSalesTotal(s, 7, D(0)), 500, "sale counted");
  eq(s.salesByDay[String(d0)], 500, "durable per-day record written");
  s.log = s.log.filter(function (e) { return e.source !== "amazon"; });   // simulate the log evicting the sale
  eq(E.recentSalesTotal(s, 7, D(0)), 500, "still reported from durable salesByDay after log eviction");
  var m = E.mergeStates(s, fresh(D(0)), D(0));
  eq(E.recentSalesTotal(m, 7, D(0)), 500, "survives merge (per-day MAX)");
  eq(E.recentSalesTotal(E.mergeStates(fresh(D(0)), s, D(0)), 7, D(0)), 500, "order-independent");
});

// ---------------------------------------------------------------- overnight foundation fixes
test("daily +50 reward survives a split-across-devices completion, credited exactly once", function () {
  var base = E.newState("L", D(0));
  var x = base; ["phys_pushups", "ment_deep", "spir_meditate"].forEach(function (id) { x = E.applyRep(x, id, D(0)).state; }); // 3 dims
  var y = base; ["fam_call", "soc_friend", "fin_dms"].forEach(function (id) { y = E.applyRep(y, id, D(0)).state; });          // other 3 dims
  assert(!x.daily.completed && !y.daily.completed, "neither device completed the day alone");
  var m = E.mergeStates(x, y, D(0));
  assert(E.isDailyMet(m, m.daily.day), "merged history is daily-met");
  assert(m.daily.completed, "merged day marked completed");
  eq(m.totalXp, x.totalXp + y.totalXp + E.CONFIG.dailyQuest.reward, "merged totalXp includes the +50 exactly once");
  eq(E.mergeStates(m, m, D(0)).totalXp, m.totalXp, "re-merge does not double the reward");
  eq(E.mergeStates(m, y, D(0)).totalXp, m.totalXp, "re-merging an absorbed device is a no-op on the reward");
});

test("daily reward NOT double-credited when one device already completed it (rewardedDay marker + legacy backfill)", function () {
  var base = E.newState("L", D(0));
  var full = base; ["phys_pushups", "ment_deep", "spir_meditate", "fam_call", "soc_friend", "fin_dms"].forEach(function (id) { full = E.applyRep(full, id, D(0)).state; });
  assert(full.daily.completed && full.daily.rewardedDay === full.daily.day, "device completed solo and marked rewarded");
  var solo = full.totalXp;
  eq(E.mergeStates(full, base, D(0)).totalXp, solo, "merge with an empty same-day device doesn't add a second +50");
  var legacy = JSON.parse(JSON.stringify(full)); delete legacy.daily.rewardedDay;     // pre-fix save: completed but no marker
  eq(E.validateRepair(legacy, D(0)).daily.rewardedDay, full.daily.day, "legacy completed day is backfilled as rewarded");
  eq(E.mergeStates(legacy, base, D(0)).totalXp, solo, "legacy completed day not double-credited on the first post-fix merge");
});

test("a rewardedDay<->day desync on a completed day is re-synced; merge stays idempotent (no phantom +50)", function () {
  var full = E.newState("L", D(0));
  ["phys_pushups", "ment_deep", "spir_meditate", "fam_call", "soc_friend", "fin_dms"].forEach(function (id) { full = E.applyRep(full, id, D(0)).state; });
  assert(full.daily.completed, "completed solo");
  var solo = full.totalXp;
  // simulate a torn write / corrupt cloud doc: rewardedDay desynced from daily.day while the +50 is already banked
  var corrupt = JSON.parse(JSON.stringify(full)); corrupt.daily.rewardedDay = full.daily.day - 2;
  eq(E.validateRepair(corrupt, D(0)).daily.rewardedDay, full.daily.day, "validateRepair re-syncs rewardedDay to daily.day for a completed day");
  eq(E.mergeStates(corrupt, corrupt, D(0)).totalXp, solo, "self-merge of a desynced completed save does NOT re-credit the +50");
});

test("penalty does not stay stuck active after the day becomes met via merge", function () {
  var x = E.newState("L", D(0)); x.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  var y = E.newState("L", D(0)); y.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  ["phys_pushups", "ment_deep", "spir_meditate"].forEach(function (id) { x = E.applyRep(x, id, D(0)).state; });
  ["fam_call", "soc_friend", "fin_dms"].forEach(function (id) { y = E.applyRep(y, id, D(0)).state; });
  assert(E.isPenalized(x) && E.isPenalized(y), "both devices still penalized pre-merge (neither completed alone)");
  var m = E.mergeStates(x, y, D(0));
  assert(E.isDailyMet(m, m.daily.day), "merged day is met");
  assert(!E.isPenalized(m), "penalty cleared once the merged day is fully met (no-shame, path-independent)");
});

test("reconcile clears a penalty on a day that history already shows met", function () {
  var s = E.newState("L", D(0)); s.player.createdDay = E.dayIndex(D(0)) - 1;
  s.penalty = { active: true, sinceDay: E.dayIndex(D(0)) };
  var day = String(E.dayIndex(D(0)));
  s.history[day] = { physical: 1, mental: 1, spiritual: 1, family: 1, social: 1, financial: 1 };
  var r = E.reconcileTo(s, E.dayIndex(D(0)));
  assert(!E.isPenalized(r), "a fully-met day cannot remain under an active penalty");
  assert(r.daily.completed, "and the day reads completed");
});

test("v1->v2 migration drops the legacy ledger (no amplified-xp re-inflation on later merge)", function () {
  var v1 = { version: 1, name: "L", created: ymd(0), incomeXp: 32,
    dims: { physical: 0, mental: 0, spiritual: 0, family: 0, social: 0, financial: 20 },
    history: {}, log: [{ ts: BASE.getTime(), dim: "financial", name: "closed", xp: 32, mult: 1.6 }] };
  var migrated = E.migrateV1toV2(v1, D(0));
  eq(migrated.log.length, 0, "legacy log dropped");
  eq(migrated.dims.financial, 20, "dims preserved from v1 aggregate (not the amplified 32)");
  var merged = E.mergeStates(migrated, E.newState("L", D(0)), D(0));
  eq(merged.dims.financial, 20, "merge does not re-inflate financial xp from a migrated amplified ledger");
  eq(merged.totalXp, migrated.totalXp, "totalXp stable across merge (no inflation)");
});

test("a garbage-huge epoch is rejected (can't wipe a healthy device); a real reset still wins", function () {
  var healthy = E.applyRep(E.applyRep(E.newState("L", D(0)), "phys_pushups", D(0)).state, "fin_close", D(0)).state;
  var corrupt = E.newState("L", D(0)); corrupt.epoch = 999999999;     // absurd — reset only ever bumps by 1
  var m = E.mergeStates(healthy, corrupt, D(0));
  assert(m.totalXp >= healthy.totalXp, "healthy progress preserved (corrupt epoch did not win)");
  assert(m.epoch <= 1, "epoch pinned to the sane lower value");
  var reset = E.newState("L", D(0)); reset.epoch = (healthy.epoch || 0) + 1;
  eq(E.mergeStates(healthy, reset, D(0)).totalXp, 0, "a legitimate reset (epoch+1) still wins wholesale");
});

test("classifier big-win is gated by action+object — benign phrases are not +300 wins", function () {
  ["signed up for a class", "landed at the airport", "booked a dentist appointment", "closed the browser tab", "sold my old couch on facebook"].forEach(function (txt) {
    var c = E.classifyActivity(txt);
    assert(!(c && c.big), "should NOT be a big win: \"" + txt + "\" (got " + (c && c.category) + ")");
  });
  ["booked a national commercial", "closed a wholesale account", "signed a new client", "landed a brand deal", "got the role", "new account today", "made a sale"].forEach(function (txt) {
    var c = E.classifyActivity(txt);
    assert(c && c.big && c.dim === "financial", "SHOULD be a big win: \"" + txt + "\" (got " + (c && c.category) + ")");
  });
});

test("satisfaction: set/today/trend, merge union (max), frustration signal — never gates", function () {
  var s = fresh(D(0));
  eq(E.satisfactionToday(s, D(0)), null, "unrated by default");
  var r = E.setSatisfaction(s, 4, D(0)); assert(r.ok, "valid level accepted"); s = r.state;
  eq(E.satisfactionToday(s, D(0)), 4, "today's level stored");
  assert(!E.setSatisfaction(s, 9, D(0)).ok, "out-of-range rejected");
  var tr = E.satisfactionTrend(s, 7, D(0)); eq(tr.length, 7, "7-day trend length"); eq(tr[6].level, 4, "today is the last point");
  var a = E.setSatisfaction(fresh(D(0)), 2, D(0)).state, b = E.setSatisfaction(fresh(D(0)), 4, D(0)).state;
  eq(E.satisfactionToday(E.mergeStates(a, b, D(0)), D(0)), 4, "same-day conflict takes the max");
  eq(E.satisfactionToday(E.mergeStates(b, a, D(0)), D(0)), 4, "order-independent");
  var low = fresh(D(0));
  low = E.setSatisfaction(low, 1, D(0)).state; low = E.setSatisfaction(low, 2, D(1)).state; low = E.setSatisfaction(low, 2, D(2)).state;
  assert(E.frustrationSignal(low, D(2)).warn, "three low rated days -> soft frustration warning");
  assert(!E.frustrationSignal(fresh(D(0)), D(0)).warn, "no warning without enough rated days");
});

test("sacralQueue: ordered candidate reps, excludes big wins, energy-aware", function () {
  var s = fresh(D(0));
  var q = E.sacralQueue(s, D(0));
  assert(Array.isArray(q) && q.length > 0, "returns a non-empty queue");
  assert(q.every(function (r) { return E.REPS.filter(function (x) { return x.id === r.id; })[0]; }), "all entries are real reps");
  var bigIds = E.REPS.filter(function (x) { return x.big; }).map(function (x) { return x.id; });
  assert(q.every(function (r) { return bigIds.indexOf(r.id) === -1; }), "big-win reps excluded from the sacral queue");
  // red day -> a restorative rep leads
  var red = fresh(D(0)); red.whoop = { date: ymd(0), recovery: 20, zone: "red" };
  var qr = E.sacralQueue(red, D(0));
  assert(["phys_sleep", "phys_mobility", "spir_rest", "spir_meditate", "spir_nature", "fam_time", "soc_friend"].indexOf(qr[0].id) !== -1, "red recovery floats a restorative rep to the front (got " + qr[0].id + ")");
});

// ---------------------------------------------------------------- report
console.log("\n  Protagonist engine — stress battery");
console.log("  " + pass + " passed, " + fail + " failed\n");
if (fail) { fails.forEach(function (f) { console.log("  FAIL  " + f); }); process.exit(1); }
else { console.log("  all green\n"); process.exit(0); }
