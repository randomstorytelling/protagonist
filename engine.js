/* Protagonist — pure game engine (no DOM, deterministic, testable).
 * Works in the browser (window.SYSTEM) and in Node (module.exports).
 *
 * Invariants (hardened after adversarial audit):
 *  1. TIME IS MONOTONIC. A rep always counts for the real current day; `now` can
 *     never roll the game's day backward. No backdating, ever.
 *  2. STREAK & PENALTY DERIVE FROM HISTORY, not from a trusted flag. recomputeStreak
 *     is the single source of truth; penalty considers every elapsed day.
 *  3. EVERY NUMBER IS FINITE-GUARDED AT THE BOUNDARY via num(). NaN/Infinity/null
 *     never reach selectors or persisted state.
 */
;(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SYSTEM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_VERSION = 2;

  // ---------------------------------------------------------------- config
  var DIMENSIONS = ["physical", "mental", "spiritual", "family", "social", "financial"];
  var ENGINE_DIMS = ["physical", "mental", "spiritual", "family", "social"]; // health dims that power the income multiplier

  var CONFIG = {
    schemaVersion: SCHEMA_VERSION,
    multiplier: { base: 1.0, perEngineDim: 0.15, max: 1.6 }, // 1.0 .. 1.6 (cap reached at 4 of 5 health dims)
    xpCurve: { baseNeed: 100, growth: 1.25 },               // need(L)=100*1.25^(L-1)
    statPointsPerLevel: 3,
    ranks: [
      { rank: "E", minLevel: 1 },
      { rank: "D", minLevel: 5 },
      { rank: "C", minLevel: 10 },
      { rank: "B", minLevel: 18 },
      { rank: "A", minLevel: 28 },
      { rank: "S", minLevel: 42 },
      { rank: "National Level", minLevel: 60 },
    ],
    dailyQuest: { requirements: { physical: 1, mental: 1, spiritual: 1, family: 1, social: 1, financial: 1 }, reward: 50 },
    penalty: { multiplierCap: 1.0 }, // while penalized: NO amplification and NO bonuses on income
    statBonus: { financialPctPerPoint: 0.5, cap: 25 }, // allocated financial points => income bonus %
    titleBonusCap: 40,
  };

  var REPS = [
    { id: "phys_pushups", dim: "physical", name: "50 push-ups", xp: 20 },
    { id: "phys_sixpack", dim: "physical", name: "6-pack challenge (app)", xp: 18 },
    { id: "phys_incline", dim: "physical", name: "60-min incline walk", xp: 25 },
    { id: "phys_creatine", dim: "physical", name: "Creatine + hydrate", xp: 8 },
    { id: "phys_sleep", dim: "physical", name: "7+ hrs sleep (WHOOP)", xp: 15 },
    { id: "phys_mobility", dim: "physical", name: "Stretch / mobility", xp: 10 },

    { id: "ment_read", dim: "mental", name: "Read 50 pages", xp: 18 },
    { id: "ment_therapy", dim: "mental", name: "Therapy session", xp: 20 },
    { id: "ment_prep", dim: "mental", name: "Audition / cold-read prep", xp: 20 },
    { id: "ment_deep", dim: "mental", name: "Deep work block (45m)", xp: 20 },
    { id: "ment_skill", dim: "mental", name: "Learn a new skill", xp: 15 },
    { id: "ment_journal", dim: "mental", name: "Journal / reflect", xp: 8 },

    { id: "spir_meditate", dim: "spiritual", name: "Meditate or pray", xp: 15 },
    { id: "spir_gratitude", dim: "spiritual", name: "Gratitude — 3 things", xp: 8 },
    { id: "spir_nature", dim: "spiritual", name: "Time outdoors / stillness", xp: 10 },
    { id: "spir_rest", dim: "spiritual", name: "Rest without guilt", xp: 10 },

    { id: "fam_call", dim: "family", name: "Call or visit family", xp: 15 },
    { id: "fam_time", dim: "family", name: "Quality time (partner / kids)", xp: 18 },
    { id: "fam_meal", dim: "family", name: "Family meal together", xp: 12 },

    { id: "soc_friend", dim: "social", name: "See or call a friend", xp: 14 },
    { id: "soc_event", dim: "social", name: "Community / social event", xp: 16 },
    { id: "soc_reach", dim: "social", name: "Reach out to someone new", xp: 10 },

    { id: "fin_dms", dim: "financial", name: "Send 25 outreach DMs", xp: 20 },
    { id: "fin_submit", dim: "financial", name: "Submit to 5 casting roles", xp: 15 },
    { id: "fin_tape", dim: "financial", name: "Record a self-tape / VO audition", xp: 20 },
    { id: "fin_content", dim: "financial", name: "Ship a piece of content", xp: 18 },
    { id: "fin_followup", dim: "financial", name: "Follow up a warm lead", xp: 15 },
    { id: "fin_admin", dim: "financial", name: "Money admin / reconcile sales", xp: 10 },
    { id: "fin_book", dim: "financial", name: "Book a gig or paid role", xp: 300, big: true },
    { id: "fin_close", dim: "financial", name: "Close a sale / wholesale account", xp: 250, big: true },
    { id: "fin_rep", dim: "financial", name: "Land an agent, rep or partner", xp: 400, big: true },
  ];
  var REP_BY_ID = {};
  REPS.forEach(function (r) { REP_BY_ID[r.id] = r; });

  // recurring / cadence quests — "due every N days", not daily (e.g. grooming/upkeep)
  var RECURRING = [
    { id: "groom_haircut", dim: "spiritual", name: "Haircut", xp: 15, intervalDays: 10 },
    { id: "groom_manicure", dim: "spiritual", name: "Manicure", xp: 12, intervalDays: 10 },
  ];
  var RECURRING_BY_ID = {};
  RECURRING.forEach(function (r) { RECURRING_BY_ID[r.id] = r; });

  // smart activity categories — free text gets matched to one of these, which rolls into a dimension.
  // (on-device classifier; swappable for an LLM call behind the same classifyActivity() interface.)
  var CATEGORIES = [
    { id: "fitness", label: "Fitness", dim: "physical", baseXp: 20, kw: ["workout", "work out", "gym", "lift", "weights", "ran", "run", "running", "jog", "walk", "incline", "cardio", "pushup", "push-up", "push up", "situp", "sit-up", "squat", "yoga", "pilates", "swim", "bike", "cycle", "ride", "hike", "hiit", "abs", "6-pack", "six pack", "train", "sweat", "steps", "treadmill"] },
    { id: "recovery", label: "Recovery", dim: "physical", baseXp: 12, kw: ["sleep", "slept", "nap", "stretch", "mobility", "sauna", "ice bath", "cold plunge", "foam roll", "recover"] },
    { id: "nutrition", label: "Nutrition", dim: "physical", baseXp: 8, kw: ["creatine", "hydrate", "drank water", "protein", "meal prep", "ate healthy", "greens", "supplement", "vitamins"] },
    { id: "therapy", label: "Therapy", dim: "mental", baseXp: 20, kw: ["therapy", "therapist", "counseling", "counselor", "counsel", "mental health"] },
    { id: "learning", label: "Learning", dim: "mental", baseXp: 14, kw: ["read", "pages", "study", "studied", "course", "learn", "lesson", "research", "podcast", "audiobook"] },
    { id: "craft", label: "Craft", dim: "mental", baseXp: 18, kw: ["rehearse", "rehearsal", "lines", "memoriz", "monologue", "scene", "acting class", "vocal", "practice", "practiced", "workshop"] },
    { id: "focus", label: "Deep work", dim: "mental", baseXp: 18, kw: ["deep work", "focus", "planned", "strategy", "brainstorm", "organized", "journal", "wrote", "writing", "designed", "build", "coding"] },
    { id: "family", label: "Family", dim: "family", baseXp: 15, kw: ["parents", "mom", "mother", "dad", "father", "family", "kids", "son", "daughter", "wife", "husband", "partner", "brother", "sister", "grandma", "grandpa", "cousin", "fianc"] },
    { id: "connection", label: "Connection", dim: "social", baseXp: 12, kw: ["friend", "called", "phone call", "texted", "dinner with", "lunch with", "coffee with", "hang out", "hung out", "met up", "caught up", "date night", "reached out"] },
    { id: "mindfulness", label: "Mindfulness", dim: "spiritual", baseXp: 14, kw: ["meditate", "meditated", "pray", "prayed", "church", "gratitude", "grateful", "breathwork", "breathe", "reflect", "mindful", "worship"] },
    { id: "nature", label: "Nature & rest", dim: "spiritual", baseXp: 10, kw: ["outside", "nature", "beach", "park", "sunshine", "outdoors", "unplug", "sabbath", "relaxed"] },
    { id: "upkeep", label: "Upkeep", dim: "spiritual", baseXp: 12, kw: ["haircut", "barber", "manicure", "nails", "skincare", "self-care", "spa", "groom"] },
    { id: "outreach", label: "Outreach", dim: "financial", baseXp: 18, kw: ["dm", "dms", "outreach", "emailed", "pitch", "cold call", "follow up", "followed up", "lead", "networking", "prospect"] },
    { id: "audition", label: "Auditions", dim: "financial", baseXp: 20, kw: ["audition", "self-tape", "selftape", "self tape", "casting", "submitted", "callback", "read for", "voiceover"] },
    { id: "content", label: "Content", dim: "financial", baseXp: 18, kw: ["posted", "content", "tiktok", "reel", "filmed", "shoot", "youtube", "instagram", "story", "edited a video"] },
    { id: "admin", label: "Money admin", dim: "financial", baseXp: 10, kw: ["invoice", "reconcile", "taxes", "accounting", "bookkeeping", "expenses", "budget", "sales report", "mcf", "fulfilled order", "shipped order"] },
    { id: "win", label: "Big win", dim: "financial", baseXp: 300, big: true, kw: ["booked", "closed a", "signed", "landed", "sold", "got the gig", "got the role", "won the", "new client", "new account", "got hired", "got paid"] },
  ];

  var TITLES = [
    { id: "awakened", name: "Awakened", bonusPct: 0, test: function (s) { return repsTotal(s) >= 1; } },
    { id: "first_coin", name: "First Coin", bonusPct: 2, test: function (s) { return s.incomeXp >= 50; } },
    { id: "closer", name: "The Closer", bonusPct: 5, test: function (s) { return (s.bigWins || 0) >= 1; } },
    { id: "iron", name: "Iron Discipline", bonusPct: 5, test: function (s) { return s.streak.longest >= 7; } },
    { id: "relentless", name: "Relentless", bonusPct: 5, test: function (s) { return repsTotal(s) >= 100; } },
    { id: "monarch", name: "Shadow Monarch", bonusPct: 10, test: function (s) { return playerLevel(s) >= 20; } },
  ];
  var TITLE_BY_ID = {};
  TITLES.forEach(function (t) { TITLE_BY_ID[t.id] = t; });

  // ---------------------------------------------------------------- primitives
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function round(n) { return Math.round(n); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // finite-guard: null/undefined/""/NaN/Infinity -> default; otherwise the number.
  function num(x, dflt) {
    if (x === null || x === undefined || x === "") return dflt;
    var n = +x;
    return Number.isFinite(n) ? n : dflt;
  }
  function nonNeg(x) { return Math.max(0, num(x, 0)); }

  // local-time day index (days since epoch in the user's tz). NaN for invalid dates.
  function dayIndex(date) {
    var t = (date && typeof date.getTime === "function") ? date.getTime() : NaN;
    if (!Number.isFinite(t)) return NaN;
    var off = date.getTimezoneOffset() * 60000;
    return Math.floor((t - off) / 86400000);
  }
  function safeToday(now) {
    var d = dayIndex(now);
    return Number.isFinite(d) ? d : dayIndex(new Date());
  }
  function dayIndexFromYMD(str) {
    var p = String(str).split("-");
    if (p.length < 3) return NaN;
    var y = +p[0], m = +p[1], d = +p[2];
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
    return dayIndex(new Date(y, m - 1, d));
  }
  function emptyDay() { var o = {}; for (var i = 0; i < DIMENSIONS.length; i++) o[DIMENSIONS[i]] = 0; return o; }
  // the game's notion of "today" is monotonic: never earlier than what we've already seen.
  function effectiveDay(state, now) {
    var d = safeToday(now);
    var dd = state && state.daily ? num(state.daily.day, d) : d;
    var la = state ? num(state.lastActiveDay, d) : d;
    return Math.max(d, dd, la);
  }

  // ---------------------------------------------------------------- selectors (pure reads)
  function levelFromXp(xp) {
    var rem = Math.max(0, num(xp, 0)), lvl = 1, need = CONFIG.xpCurve.baseNeed, guard = 0;
    while (rem >= need && guard < 100000) { rem -= need; lvl++; need = round(need * CONFIG.xpCurve.growth); guard++; }
    return { level: lvl, intoLevel: rem, need: need, pct: need ? clamp(round((rem / need) * 100), 0, 100) : 0 };
  }
  function playerLevel(s) { return levelFromXp(s.totalXp).level; }
  function incomeLevel(s) { return levelFromXp(s.incomeXp).level; }
  function rankForLevel(level) {
    var r = CONFIG.ranks[0];
    for (var i = 0; i < CONFIG.ranks.length; i++) if (level >= CONFIG.ranks[i].minLevel) r = CONFIG.ranks[i];
    return r.rank;
  }
  function rank(s) { return rankForLevel(playerLevel(s)); }

  function repsOn(s, day) { return s.history[day] || emptyDay(); }
  function engineDimsActive(s, day) {
    var h = repsOn(s, day), n = 0;
    for (var i = 0; i < ENGINE_DIMS.length; i++) if ((h[ENGINE_DIMS[i]] || 0) > 0) n++;
    return n;
  }
  function isPenalized(s) { return !!(s.penalty && s.penalty.active); }
  function multiplier(s, day) {
    if (isPenalized(s)) return CONFIG.penalty.multiplierCap;
    var m = CONFIG.multiplier.base + CONFIG.multiplier.perEngineDim * engineDimsActive(s, day);
    return +Math.min(m, CONFIG.multiplier.max).toFixed(2);
  }
  function statBonusPct(s) {
    var fin = (s.statPoints && s.statPoints.allocated && s.statPoints.allocated.financial) || 0;
    return Math.min(CONFIG.statBonus.cap, fin * CONFIG.statBonus.financialPctPerPoint);
  }
  function titleBonusPct(s) {
    var sum = 0;
    (s.unlockedTitles || []).forEach(function (id) { if (TITLE_BY_ID[id]) sum += TITLE_BY_ID[id].bonusPct; });
    return Math.min(CONFIG.titleBonusCap, sum);
  }
  function totalBonusPct(s) { return statBonusPct(s) + titleBonusPct(s); }

  function repsTotal(s) {
    var n = 0;
    for (var k in s.history) if (Object.prototype.hasOwnProperty.call(s.history, k)) {
      var h = s.history[k]; if (!h) continue;
      for (var d = 0; d < DIMENSIONS.length; d++) n += h[DIMENSIONS[d]] || 0;
    }
    return n;
  }
  function isDailyMet(s, day) {
    var h = repsOn(s, day), req = CONFIG.dailyQuest.requirements;
    for (var d = 0; d < DIMENSIONS.length; d++) if ((h[DIMENSIONS[d]] || 0) < (req[DIMENSIONS[d]] || 0)) return false;
    return true;
  }
  function dailyProgress(s, day) {
    var h = repsOn(s, day), req = CONFIG.dailyQuest.requirements, done = 0, total = 0;
    DIMENSIONS.forEach(function (d) { total++; if ((h[d] || 0) >= (req[d] || 0)) done++; });
    return { done: done, total: total, met: done === total };
  }
  function suggestionDim(s, day) {
    var h = repsOn(s, day), low = DIMENSIONS[0];
    DIMENSIONS.forEach(function (d) { if ((h[d] || 0) < (h[low] || 0)) low = d; });
    return low;
  }
  function repsForDim(dim) { return REPS.filter(function (r) { return r.dim === dim; }); }

  // ---------------------------------------------------------------- state lifecycle
  function initialsOf(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "P";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function newState(name, now) {
    var today = safeToday(now);
    return {
      version: SCHEMA_VERSION,
      player: { name: name || "Lawrence", initials: initialsOf(name || "Lawrence"), createdDay: today },
      totalXp: 0,
      incomeXp: 0,
      dims: emptyDay(),
      statPoints: { available: 0, allocated: emptyDay() },
      unlockedTitles: [],
      activeTitle: null,
      history: {},
      streak: { current: 0, longest: 0, lastDay: null },
      daily: { day: today, completed: false },
      penalty: { active: false, sinceDay: null },
      bigWins: 0,
      log: [],
      lastActiveDay: today,
      recurring: {},              // recurringId -> lastDoneDay
      external: { seen: {} },     // "source:kind:id" -> dayIngested (dedup for WHOOP etc.)
      whoop: null,                // latest WHOOP vitals snapshot (display only; XP lives in history)
    };
  }

  // defensive repair: guarantee every field exists & is finite (corrupt/partial saves)
  function validateRepair(s, now) {
    var today = safeToday(now);
    var out = newState((s && s.player && s.player.name) || "Lawrence", now);
    if (!s || typeof s !== "object") return out;
    out.totalXp = nonNeg(s.totalXp);
    out.incomeXp = nonNeg(s.incomeXp);
    if (s.dims && typeof s.dims === "object") DIMENSIONS.forEach(function (d) { out.dims[d] = nonNeg(s.dims[d]); });
    if (s.player && typeof s.player === "object") {
      if (s.player.name) out.player.name = String(s.player.name);
      out.player.initials = s.player.initials || initialsOf(out.player.name);
      out.player.createdDay = Math.min(num(s.player.createdDay, today), today); // can't be created in the future
    }
    if (s.statPoints && typeof s.statPoints === "object") {
      out.statPoints.available = nonNeg(s.statPoints.available);
      if (s.statPoints.allocated) DIMENSIONS.forEach(function (d) { out.statPoints.allocated[d] = nonNeg(s.statPoints.allocated[d]); });
    }
    if (Array.isArray(s.unlockedTitles)) out.unlockedTitles = s.unlockedTitles.filter(function (id) { return !!TITLE_BY_ID[id]; });
    if (s.activeTitle && TITLE_BY_ID[s.activeTitle]) out.activeTitle = s.activeTitle;
    // history: keep only finite-integer day keys with sane dim counts
    if (s.history && typeof s.history === "object") {
      out.history = {};
      for (var k in s.history) if (Object.prototype.hasOwnProperty.call(s.history, k)) {
        var dk = Number(k);
        if (!Number.isFinite(dk)) continue;
        var src = s.history[k] || {}, day = emptyDay();
        DIMENSIONS.forEach(function (d) { day[d] = nonNeg(src[d]); });
        out.history[String(dk)] = day;
      }
    }
    if (s.streak && typeof s.streak === "object") {
      out.streak.current = nonNeg(s.streak.current);
      out.streak.longest = nonNeg(s.streak.longest);
      out.streak.lastDay = num(s.streak.lastDay, null);
    }
    if (s.daily && typeof s.daily === "object") {
      out.daily.day = Math.min(num(s.daily.day, today), today); // future-dated -> clamp to today (anti clock-glitch freeze)
      out.daily.completed = !!s.daily.completed;
    }
    if (s.penalty && typeof s.penalty === "object") {
      out.penalty.active = !!s.penalty.active;
      out.penalty.sinceDay = num(s.penalty.sinceDay, null);
    }
    out.bigWins = nonNeg(s.bigWins);
    if (Array.isArray(s.log)) out.log = s.log.slice(0, 200);
    out.lastActiveDay = Math.min(num(s.lastActiveDay, today), today); // future-dated -> clamp to today
    if (s.recurring && typeof s.recurring === "object") {
      out.recurring = {};
      RECURRING.forEach(function (def) { var v = num(s.recurring[def.id], null); if (v !== null) out.recurring[def.id] = Math.min(v, today); });
    }
    if (s.external && typeof s.external === "object" && s.external.seen && typeof s.external.seen === "object") {
      out.external = { seen: {} };
      for (var ek in s.external.seen) if (Object.prototype.hasOwnProperty.call(s.external.seen, ek)) {
        var ev = num(s.external.seen[ek], null); if (ev !== null) out.external.seen[ek] = ev;
      }
    }
    if (s.whoop && typeof s.whoop === "object") {
      out.whoop = {
        date: s.whoop.date ? String(s.whoop.date) : null,
        recovery: num(s.whoop.recovery, null),
        zone: (["green", "yellow", "red"].indexOf(s.whoop.zone) !== -1) ? s.whoop.zone : "unknown",
        sleepHours: num(s.whoop.sleepHours, null),
        sleepPerf: num(s.whoop.sleepPerf, null),
        strain: num(s.whoop.strain, null),
        hrv: num(s.whoop.hrv, null),
        rhr: num(s.whoop.rhr, null),
        syncedTs: num(s.whoop.syncedTs, null),
      };
    }
    out.version = SCHEMA_VERSION;
    recomputeStreak(out); // streak is always derived, never trusted from disk
    return out;
  }

  function migrateV1toV2(v1, now) {
    var name = v1.name || (v1.player && v1.player.name) || "Lawrence";
    var s = newState(name, now);
    s.player.initials = v1.initials || initialsOf(name);
    var cd = dayIndexFromYMD(v1.created);
    s.player.createdDay = Number.isFinite(cd) ? cd : safeToday(now);
    if (v1.dims) DIMENSIONS.forEach(function (d) { s.dims[d] = nonNeg(v1.dims[d]); });
    s.totalXp = DIMENSIONS.reduce(function (a, d) { return a + s.dims[d]; }, 0);
    s.incomeXp = nonNeg(v1.incomeXp);
    if (v1.history) for (var k in v1.history) if (Object.prototype.hasOwnProperty.call(v1.history, k)) {
      var di = dayIndexFromYMD(k);
      if (!Number.isFinite(di)) continue; // drop unparseable keys instead of collapsing to "NaN"
      var src = v1.history[k] || {}, day = emptyDay();
      DIMENSIONS.forEach(function (d) { day[d] = nonNeg(src[d]); });
      s.history[String(di)] = day;
    }
    if (Array.isArray(v1.log)) s.log = v1.log.map(function (e) {
      var ts = num(e.ts, null), dy = ts !== null ? dayIndex(new Date(ts)) : null;
      return { ts: ts, day: Number.isFinite(dy) ? dy : null, dim: e.dim, repId: e.repId || null, name: e.name, baseXp: num(e.xp, 0), mult: num(e.mult, 1), xp: num(e.xp, 0) };
    }).slice(0, 200);
    s.statPoints.available = Math.max(0, (levelFromXp(s.totalXp).level - 1) * CONFIG.statPointsPerLevel);
    recomputeStreak(s);
    return s;
  }

  function migrateIfNeeded(s, now) {
    if (s && s.version === SCHEMA_VERSION) return s;
    if (!s || typeof s !== "object") return newState("Lawrence", now);
    if (!s.version || s.version < 2) return migrateV1toV2(s, now);
    return s; // future/newer save — validateRepair coerces it
  }

  // streak is ALWAYS recomputed from history (single source of truth).
  function recomputeStreak(s) {
    var days = Object.keys(s.history).map(Number).filter(Number.isFinite).filter(function (d) {
      var h = s.history[d]; return h && DIMENSIONS.some(function (x) { return (h[x] || 0) > 0; });
    }).sort(function (a, b) { return a - b; });
    if (!days.length) { s.streak = { current: 0, longest: 0, lastDay: null }; return; }
    var longest = 1, run = 1;
    for (var i = 1; i < days.length; i++) { if (days[i] === days[i - 1] + 1) run++; else run = 1; if (run > longest) longest = run; }
    var cur = 1;
    for (var j = days.length - 1; j > 0; j--) { if (days[j] === days[j - 1] + 1) cur++; else break; }
    s.streak = { current: cur, longest: longest, lastDay: days[days.length - 1] };
  }

  // roll forward to an explicit day; resolve missed days into exactly one penalty (never a stack).
  function reconcileTo(s, today) {
    s = clone(s);
    if (!Number.isFinite(today)) today = num(s.daily && s.daily.day, 0);
    if (!s.daily) s.daily = { day: today, completed: false };
    var last = num(s.daily.day, today);
    var created = num(s.player.createdDay, today);
    if (today > last) {
      var missed = false;
      // the last opened day: penalize if it's past grace, wasn't completed, and history doesn't show it met
      if (last > created && !s.daily.completed && !isDailyMet(s, last)) missed = true;
      // any fully-skipped intermediate day (no engagement) beyond the grace day
      if (today - last > 1 && (today - 1) > created) missed = true;
      if (missed) s.penalty = { active: true, sinceDay: today };
      s.daily = { day: today, completed: isDailyMet(s, today) };
    } else if (today < last) {
      s.daily = { day: today, completed: isDailyMet(s, today) }; // clock moved back -> resync, no penalty
    } else {
      s.daily.completed = s.daily.completed || isDailyMet(s, today);
    }
    return s;
  }
  function reconcile(s, now) { return reconcileTo(s, effectiveDay(s, now)); }

  function init(raw, now) {
    now = now || new Date();
    var parsed;
    try { parsed = (typeof raw === "string") ? JSON.parse(raw) : raw; } catch (e) { parsed = null; }
    var s = migrateIfNeeded(parsed, now);
    s = validateRepair(s, now);
    var before = isPenalized(s);
    s = reconcile(s, now);
    var events = [];
    if (!before && isPenalized(s)) events.push({ type: "PENALTY_INCURRED" });
    return { state: s, events: events };
  }

  // shared crediting path for ALL rep sources (manual, recurring, WHOOP). `rep` is a concrete
  // object {dim, xp, name, id?, big?, source?}. Pure — returns new state + celebration events.
  function _credit(state, rep, now) {
    var today = effectiveDay(state, now); // monotonic: never earlier than what we've seen
    var s = reconcileTo(state, today);
    var events = [];

    var beforeLevel = playerLevel(s);
    var beforeRank = rankForLevel(beforeLevel);
    var beforeIncome = incomeLevel(s);

    if (!s.history[today]) s.history[today] = emptyDay();
    s.dims[rep.dim] += rep.xp;
    s.totalXp += rep.xp;
    s.history[today][rep.dim] += 1;
    if (rep.big) s.bigWins += 1;

    var mult = 1, gained = rep.xp;
    if (rep.dim === "financial") {
      if (isPenalized(s)) { mult = CONFIG.penalty.multiplierCap; gained = round(rep.xp * CONFIG.penalty.multiplierCap); }
      else { mult = multiplier(s, today); gained = round(rep.xp * mult * (1 + totalBonusPct(s) / 100)); }
      s.incomeXp += gained;
    }

    recomputeStreak(s);

    var ts = (now && typeof now.getTime === "function" && Number.isFinite(now.getTime())) ? now.getTime() : Date.now();
    s.log.unshift({ ts: ts, day: today, dim: rep.dim, repId: rep.id || null, name: rep.name, baseXp: rep.xp, mult: mult, xp: rep.dim === "financial" ? gained : rep.xp, source: rep.source || "manual" });
    if (s.log.length > 200) s.log.length = 200;
    s.lastActiveDay = today;

    if (!s.daily.completed && isDailyMet(s, today)) {
      s.daily.completed = true;
      s.totalXp += CONFIG.dailyQuest.reward;
      events.push({ type: "DAILY_COMPLETE", reward: CONFIG.dailyQuest.reward });
      if (isPenalized(s)) { s.penalty = { active: false, sinceDay: null }; events.push({ type: "PENALTY_CLEARED" }); }
    }

    var afterLevel = playerLevel(s);
    if (afterLevel > beforeLevel) {
      var pts = (afterLevel - beforeLevel) * CONFIG.statPointsPerLevel;
      s.statPoints.available += pts;
      events.push({ type: "LEVEL_UP", from: beforeLevel, to: afterLevel, statPoints: pts });
      var afterRank = rankForLevel(afterLevel);
      if (afterRank !== beforeRank) events.push({ type: "RANK_UP", from: beforeRank, to: afterRank });
    }
    var afterIncome = incomeLevel(s);
    if (afterIncome > beforeIncome) events.push({ type: "INCOME_LEVEL_UP", from: beforeIncome, to: afterIncome });

    for (var i = 0; i < TITLES.length; i++) {
      var t = TITLES[i];
      if (s.unlockedTitles.indexOf(t.id) === -1 && t.test(s)) {
        s.unlockedTitles.push(t.id);
        if (!s.activeTitle) s.activeTitle = t.id;
        events.push({ type: "TITLE_UNLOCKED", id: t.id, name: t.name });
      }
    }

    return { state: s, events: events };
  }

  // log a manual rep by id.
  function applyRep(state, repId, now) {
    var rep = REP_BY_ID[repId];
    if (!rep) return { state: state, events: [{ type: "ERROR", message: "unknown rep: " + repId }] };
    return _credit(state, rep, now);
  }

  // complete a recurring/cadence quest (haircut, manicure). Credits its dim AND resets its cadence.
  function applyRecurring(state, id, now) {
    var def = RECURRING_BY_ID[id];
    if (!def) return { state: state, events: [{ type: "ERROR", message: "unknown recurring: " + id }] };
    var r = _credit(state, { id: def.id, dim: def.dim, xp: def.xp, name: def.name, source: "recurring" }, now);
    var today = effectiveDay(state, now);
    if (!r.state.recurring) r.state.recurring = {};
    r.state.recurring[id] = today;
    r.events.push({ type: "RECURRING_DONE", id: id, name: def.name, nextDueDay: today + def.intervalDays });
    return r;
  }

  // status of all recurring quests: due? days until due?
  function recurringStatus(state, now) {
    var today = safeToday(now);
    return RECURRING.map(function (def) {
      var last = (state.recurring) ? num(state.recurring[def.id], null) : null;
      var due = (last === null) ? true : (today - last >= def.intervalDays);
      var daysUntil = (last === null) ? 0 : Math.max(0, def.intervalDays - (today - last));
      return { id: def.id, name: def.name, dim: def.dim, xp: def.xp, intervalDays: def.intervalDays, lastDoneDay: last, due: due, daysUntilDue: daysUntil };
    });
  }

  // map a WHOOP activity to a concrete rep (or null if it shouldn't score).
  function whoopActivityToRep(a) {
    if (!a || typeof a !== "object") return null;
    if (a.kind === "workout") {
      var mins = num(a.durationMin, num(a.duration_min, 0));
      var strain = nonNeg(a.strain); // WHOOP 0..21 effort; 0 when absent -> pure duration (back-compat)
      if (mins <= 0 && strain <= 0) return null;
      // reward EITHER a long session OR a hard one: a 20-min HIIT at strain 12 shouldn't score like
      // a 20-min stroll. Take the better of duration (min/3) and intensity (strain*2.2), bounded [8,40].
      var xp = clamp(round(Math.max(mins / 3, strain * 2.2)), 8, 40);
      var label = "WHOOP: " + (a.sport || "workout") + (mins > 0 ? (" (" + round(mins) + "m)") : "");
      return { id: "whoop_workout", dim: "physical", name: label, xp: xp, source: a.source || "whoop" };
    }
    if (a.kind === "recovery") {
      var rec = num(a.score, num(a.recovery, -1));
      if (rec < 0) return null;
      var rxp = rec >= 67 ? 12 : (rec >= 34 ? 8 : 4); // WHOOP green/yellow/red recovery as daily baseline
      return { id: "whoop_recovery", dim: "physical", name: "WHOOP: recovery " + round(rec) + "%", xp: rxp, source: a.source || "whoop" };
    }
    if (a.kind === "sleep") {
      var hrs = num(a.hours, num(a.durationHours, 0));
      if (hrs >= 7) return { id: "whoop_sleep", dim: "physical", name: "WHOOP: sleep " + hrs.toFixed(1) + "h", xp: 15, source: a.source || "whoop" };
      return null;
    }
    return null;
  }

  // shape a day's WHOOP data into ingestable activities. Canonical mapping shared by the
  // in-app sync and the whoop-sync.js game-master, so they can never drift apart.
  // whoopDay = { date, recovery:{score}, sleep:{id,hours}, workouts:[{id,sport,durationMin}] }
  function whoopDayToActivities(day) {
    if (!day || typeof day !== "object") return [];
    var acts = [], d = day.date || "day";
    if (day.recovery && (day.recovery.score != null || day.recovery.recovery != null)) {
      acts.push({ source: "whoop", kind: "recovery", id: "rec-" + d, score: num(day.recovery.score, num(day.recovery.recovery, 0)) });
    }
    if (day.sleep && (day.sleep.hours != null || day.sleep.durationHours != null)) {
      acts.push({ source: "whoop", kind: "sleep", id: "sleep-" + (day.sleep.id || d), hours: num(day.sleep.hours, num(day.sleep.durationHours, 0)) });
    }
    if (Array.isArray(day.workouts)) day.workouts.forEach(function (w, i) {
      acts.push({ source: "whoop", kind: "workout", id: "wk-" + (w.id || (d + "-" + i)), sport: w.sport || "workout", durationMin: num(w.durationMin, num(w.duration_min, 0)), strain: nonNeg(w.strain) });
    });
    return acts;
  }

  // WHOOP recovery zones (the standard green/yellow/red bands): >=67 green, 34-66 yellow, <34 red.
  function recoveryZone(score) {
    var s = num(score, -1);
    if (s < 0) return "unknown";
    return s >= 67 ? "green" : (s >= 34 ? "yellow" : "red");
  }

  // distill a WHOOP day into a display-only vitals snapshot (no XP here — that's history's job).
  function whoopVitals(day) {
    if (!day || typeof day !== "object") return null;
    var rec = (day.recovery && (day.recovery.score != null || day.recovery.recovery != null))
      ? num(day.recovery.score, num(day.recovery.recovery, null)) : null;
    var sh = (day.sleep && (day.sleep.hours != null || day.sleep.durationHours != null))
      ? num(day.sleep.hours, num(day.sleep.durationHours, null)) : null;
    var sp = day.sleep ? num(day.sleep.performance, null) : null;
    var strain = num(day.strain, null);
    var hrv = day.recovery ? num(day.recovery.hrv, null) : null;
    var rhr = day.recovery ? num(day.recovery.rhr, null) : null;
    return {
      date: day.date || null,
      recovery: rec, zone: recoveryZone(rec),
      sleepHours: sh != null ? +sh.toFixed(2) : null,
      sleepPerf: sp,
      strain: strain != null ? +strain.toFixed(1) : null,
      hrv: hrv != null ? Math.round(hrv) : null,
      rhr: rhr != null ? Math.round(rhr) : null,
      syncedTs: null,
    };
  }

  // ingest one or more WHOOP days AND stamp the latest day's vitals onto state. The single entry point
  // shared by the in-app sync and the whoop-sync.js game-master, so the snapshot can never drift from XP.
  function ingestWhoopDays(state, days, now) {
    var list = Array.isArray(days) ? days : [days];
    var acts = [];
    list.forEach(function (d) { acts = acts.concat(whoopDayToActivities(d)); });
    var r = ingestExternal(state, acts, now);
    var latest = null;
    list.forEach(function (d) { if (d && d.date && (!latest || String(d.date) > String(latest.date))) latest = d; });
    if (!latest && list.length) latest = list[list.length - 1];
    var v = whoopVitals(latest);
    if (v) {
      v.syncedTs = (now && typeof now.getTime === "function" && Number.isFinite(now.getTime())) ? now.getTime() : Date.now();
      r.state.whoop = v; // ingestExternal already returned a fresh clone we own
    }
    return r;
  }

  // THE single place to register an auto-source. Map an external activity -> a concrete rep.
  // Everything you do that should "count" flows through here: WHOOP, Amazon MCF, IG outreach,
  // Gmail, Shopify sales, etc. Add a new source by adding a case; the rest (dedup, crediting,
  // daily/streak/multiplier) is handled by ingestExternal + _credit.
  function externalActivityToRep(a) {
    if (!a || typeof a !== "object") return null;
    if (a.kind === "workout" || a.kind === "sleep" || a.kind === "recovery") return whoopActivityToRep(a); // route by KIND, not source
    switch (a.kind) {
      case "mcf_order":
        return { id: "mcf_order", dim: "financial", name: "MCF order fulfilled" + (a.units ? (" (" + num(a.units, 0) + "x)") : ""), xp: 12, source: a.source || "amazon" };
      case "outreach":
      case "dm_batch": {
        var n = num(a.count, 1);
        return { id: "outreach", dim: "financial", name: "Sent " + n + " outreach DM" + (n === 1 ? "" : "s"), xp: clamp(round(n * 0.8), 5, 30), source: a.source || "instagram" };
      }
      case "dm":
        return { id: "dm", dim: "financial", name: "Outreach DM sent", xp: 2, source: a.source || "instagram" };
      case "email":
        return { id: "email", dim: "financial", name: "Email sent" + (a.to ? (" → " + String(a.to).slice(0, 40)) : ""), xp: 3, source: a.source || "gmail" };
      case "sale":
      case "order": {
        var amt = num(a.amount, 0);
        return { id: "sale", dim: "financial", name: "Sale" + (amt ? (" $" + amt) : ""), xp: clamp(round((amt || 20) / 2), 10, 200), big: amt >= 200, source: a.source || "shopify" };
      }
      case "task": {
        // a completed Google Task -> classify its title into the right dimension (call mom -> family,
        // send invoices -> financial, etc.); capped since a checkbox is a solid-but-small win.
        var t = String(a.title || a.name || "");
        var c = classifyActivity(t);
        var tdim = c ? c.dim : "mental";
        var txp = c ? Math.min(c.xp, 30) : 10;
        return { id: "gtask", dim: tdim, xp: txp, name: (t || "Task") + " ✓", big: !!(c && c.big && tdim === "financial"), source: a.source || "google-tasks" };
      }
      default:
        return null;
    }
  }

  // collision-proof dedup key: escape each part so an id containing ":" can't forge another key,
  // and coerce non-primitive ids via JSON so distinct objects don't collapse to "[object Object]".
  function dedupKey(a) {
    function part(x) { return encodeURIComponent(typeof x === "object" && x !== null ? JSON.stringify(x) : String(x)); }
    return part(a.source || "whoop") + ":" + part(a.kind || "activity") + ":" + part(a.id);
  }

  // bound the dedup map by COUNT (oldest-day first), never by age — age-pruning a credited key
  // would let the same activity be re-credited on a later re-sync (double-count).
  function pruneSeen(seen) {
    var keys = Object.keys(seen);
    if (keys.length <= 8000) return;
    keys.sort(function (a, b) { return num(seen[a], 0) - num(seen[b], 0); });
    for (var i = 0; i < keys.length - 8000; i++) delete seen[keys[i]];
  }

  // ingest a batch of external activities from ANY source. Idempotent: deduped by dedupKey.
  function ingestExternal(state, activities, now) {
    var s = clone(state);
    if (!s.external) s.external = { seen: {} };
    if (!s.external.seen) s.external.seen = {};
    var today = safeToday(now);
    var list = Array.isArray(activities) ? activities : [];
    var events = [], credited = [];
    list.forEach(function (a) {
      if (!a || typeof a !== "object" || a.id === undefined || a.id === null) return;
      var key = dedupKey(a);
      if (s.external.seen[key]) return;          // already counted -> skip (dedup)
      var rep = externalActivityToRep(a);
      if (!rep) return;                          // unknown/unscorable -> do NOT mark seen (lets corrected data score later)
      var r = _credit(s, rep, now);
      s = r.state;
      if (!s.external) s.external = { seen: {} };
      if (!s.external.seen) s.external.seen = {};
      s.external.seen[key] = today;
      events = events.concat(r.events);
      credited.push({ key: key, name: rep.name, dim: rep.dim, xp: rep.xp });
    });
    pruneSeen(s.external.seen);
    return { state: s, events: events, credited: credited };
  }

  // parse a rough minute count from free text ("20 min", "an hour", "1.5 hrs", "half an hour")
  function parseMinutes(t) {
    var m = t.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr)\b/);
    if (m) return Math.round(parseFloat(m[1]) * 60);
    m = t.match(/(\d+)\s*(minutes|minute|mins|min)\b/);
    if (m) return parseInt(m[1], 10);
    if (/\bhalf an hour\b/.test(t)) return 30;
    if (/\ban hour\b/.test(t)) return 60;
    return null;
  }

  // match a keyword at a word boundary, allowing suffixes (stemming): "walk" hits "walked"
  // but "book" does NOT hit "booked" (boundary is required at the START of the word).
  function kwHit(t, k) {
    var esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9])" + esc, "i").test(t);
  }

  // classify a free-text activity into {dim, category, xp, big, confidence}. Pure.
  function classifyActivity(text) {
    var t = " " + String(text || "").toLowerCase() + " ";
    if (!t.trim()) return null;
    var best = null, bestScore = 0;
    CATEGORIES.forEach(function (c) {
      var hits = 0;
      c.kw.forEach(function (k) { if (kwHit(t, k)) hits++; });
      if (hits > bestScore) { bestScore = hits; best = c; }
    });
    var dim, label, base, big = false, conf, id;
    if (!best) { dim = "mental"; label = "General"; id = "general"; base = 10; conf = 0.2; }
    else { dim = best.dim; label = best.label; id = best.id; base = best.baseXp; big = !!best.big; conf = Math.min(1, 0.5 + 0.2 * bestScore); }
    var mins = parseMinutes(t), xp = base;
    if (mins && !big) xp = clamp(round(base * clamp(mins / 30, 0.6, 2.0)), 5, 60);
    return { dim: dim, category: label, categoryId: id, xp: xp, big: big, confidence: conf, matched: bestScore };
  }

  // log a free-text activity: classify (or use override {dim,xp}) and credit it. Returns {state, events, classification}.
  function logActivity(state, text, now, override) {
    var cls = classifyActivity(text);
    if (!cls) return { state: state, events: [], classification: null };
    var dim = (override && DIMENSIONS.indexOf(override.dim) !== -1) ? override.dim : cls.dim;
    var xp = (override && Number.isFinite(+override.xp)) ? Math.max(1, round(+override.xp)) : cls.xp;
    var name = String(text).trim().replace(/\s+/g, " ");
    if (name.length > 80) name = name.slice(0, 77) + "…";
    var big = cls.big && dim === "financial";
    var r = _credit(state, { id: "activity", dim: dim, xp: xp, name: name, big: big, source: "smart" }, now);
    r.classification = { dim: dim, category: cls.category, categoryId: cls.categoryId, xp: xp, confidence: cls.confidence, big: big };
    return r;
  }

  function allocateStat(state, dim, now) {
    if (DIMENSIONS.indexOf(dim) === -1) return { state: state, ok: false };
    if (!state.statPoints || state.statPoints.available <= 0) return { state: state, ok: false };
    var s = clone(state);
    s.statPoints.available -= 1;
    s.statPoints.allocated[dim] += 1;
    return { state: s, ok: true };
  }

  function setActiveTitle(state, id) {
    if (!TITLE_BY_ID[id] || state.unlockedTitles.indexOf(id) === -1) return state;
    var s = clone(state); s.activeTitle = id; return s;
  }

  // ---------------------------------------------------------------- public API
  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    CONFIG: CONFIG,
    DIMENSIONS: DIMENSIONS,
    ENGINE_DIMS: ENGINE_DIMS,
    REPS: REPS,
    RECURRING: RECURRING,
    CATEGORIES: CATEGORIES,
    TITLES: TITLES,
    newState: newState,
    init: init,
    reconcile: reconcile,
    reconcileTo: reconcileTo,
    validateRepair: validateRepair,
    migrateV1toV2: migrateV1toV2,
    recomputeStreak: recomputeStreak,
    applyRep: applyRep,
    applyRecurring: applyRecurring,
    recurringStatus: recurringStatus,
    ingestExternal: ingestExternal,
    ingestWhoopDays: ingestWhoopDays,
    whoopActivityToRep: whoopActivityToRep,
    whoopDayToActivities: whoopDayToActivities,
    whoopVitals: whoopVitals,
    recoveryZone: recoveryZone,
    externalActivityToRep: externalActivityToRep,
    classifyActivity: classifyActivity,
    logActivity: logActivity,
    allocateStat: allocateStat,
    setActiveTitle: setActiveTitle,
    dayIndex: dayIndex,
    effectiveDay: effectiveDay,
    levelFromXp: levelFromXp,
    playerLevel: playerLevel,
    incomeLevel: incomeLevel,
    rank: rank,
    rankForLevel: rankForLevel,
    multiplier: multiplier,
    statBonusPct: statBonusPct,
    titleBonusPct: titleBonusPct,
    totalBonusPct: totalBonusPct,
    repsTotal: repsTotal,
    isDailyMet: isDailyMet,
    dailyProgress: dailyProgress,
    isPenalized: isPenalized,
    suggestionDim: suggestionDim,
    repsForDim: repsForDim,
    engineDimsActive: engineDimsActive,
  };
});
