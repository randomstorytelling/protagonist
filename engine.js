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
  var LOG_CAP = 1000;   // per-rep ledger bound. Sized so a single device needs ~3 months of offline activity
                        // to truncate it; mergeStates aggregates from the FULL union, so sub-cap divergence is lossless.

  // ---------------------------------------------------------------- config
  var DIMENSIONS = ["physical", "mental", "spiritual", "family", "social", "financial"];
  var ENGINE_DIMS = ["physical", "mental", "spiritual", "family", "social"]; // health dims that power the income multiplier

  var CONFIG = {
    schemaVersion: SCHEMA_VERSION,
    multiplier: { base: 1.0, perEngineDim: 0.15, max: 1.6 }, // 1.0 .. 1.6 (cap reached at 4 of 5 health dims)
    xpCurve: { baseNeed: 100, growth: 1.25 },               // need(L)=100*1.25^(L-1)
    statPointsPerLevel: 3,
    // rank ladder = Lawrence's Human Design 6/3 Generator actualization journey
    // (3rd-line trial-and-error -> 6th-line role model -> self-actualized), keyed to player level
    ranks: [
      { rank: "Responder", minLevel: 1 },
      { rank: "Experimenter", minLevel: 5 },
      { rank: "Builder", minLevel: 10 },
      { rank: "Master", minLevel: 18 },
      { rank: "Sage", minLevel: 28 },
      { rank: "Role Model", minLevel: 42 },
      { rank: "Actualized", minLevel: 60 },
    ],
    dailyQuest: { requirements: { physical: 1, mental: 1, spiritual: 1, family: 1, social: 1, financial: 1 }, reward: 50 },
    penalty: { multiplierCap: 1.0 }, // while penalized: NO amplification and NO bonuses on income
    statBonus: { financialPctPerPoint: 0.5, cap: 25 }, // allocated financial points => income bonus %
    titleBonusCap: 40,
    // daily water target (oz) — "fill the bar every day". The goal is PERSONALIZED from the player's build +
    // activity tier via hydrationGoalOz(); this is the fallback when no profile is set. Basis (peer-reviewed):
    //  - NASEM/IOM 2004 DRI: adult-male Adequate Intake 3.7 L total water (~101 oz from beverages) for a
    //    SEDENTARY ~70 kg reference man — explicitly higher for larger/very-active people.
    //  - Yamada et al., Science 2022 (n=5604, doubly-labeled water): physical activity + athletic status are
    //    the LARGEST drivers of water turnover, which scales with body size.
    //  - ~35 mL/kg/day is the common active-adult clinical estimate; + ACSM sweat-replacement for training.
    hydration: { goalOz: 125, mlPerKg: { sedentary: 31, active: 35, athlete: 40 }, activityAllowanceOz: { sedentary: 0, active: 13, athlete: 26 } },
    // POWER LEVEL — a LIVE readout of how Lawrence is operating right now (not a lifetime XP tally), on a 0..10,000
    // scale, aligned to his real goals: rebuilding Vybrance revenue + a leveled, consistent life. Tunable anchors:
    //  - peakMonthlyRevenue: his real ~$260k/mo Vybrance peak (Jul'25) = the revenue ceiling that maxes the revenue part.
    //  - lifeLevelCap: the AVERAGE dimension level that maxes the life part (avg Lv 25 across the six dims = elite).
    //  - streakCap: total live streak-days across the six dims that maxes consistency (~20-day streak on each).
    //  - weights: revenue is the main quest, life is the foundation, consistency is the seasoning. Sum = 1.
    powerLevel: { scale: 10000, peakMonthlyRevenue: 260000, lifeLevelCap: 25, streakCap: 120, weights: { revenue: 0.50, life: 0.35, consistency: 0.15 } },
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

  // hydration quick-add presets (oz). Tapping one fills the daily bar; the goal lives in CONFIG.hydration.
  var HYDRATION_PRESETS = [
    { label: "Glass", oz: 8, icon: "🥛" },
    { label: "Bottle", oz: 16, icon: "🍶" },
    { label: "Big", oz: 24, icon: "🧴" },
    { label: "Liter", oz: 32, icon: "💧" },
  ];

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
    // Big win is detected by a dedicated rule (isBigWin), NOT this kw list — see classifyActivity. These standalone
    // phrases are the unambiguous ones; everything else needs a win ACTION + win OBJECT so benign phrases like
    // "signed up for a class" / "landed at the airport" / "booked a dentist appointment" don't bank a +300 win.
    { id: "win", label: "Big win", dim: "financial", baseXp: 300, big: true, kw: ["got the gig", "got the role", "got the part", "got hired", "got paid", "new client", "new account", "brand deal", "sold out", "made a sale", "won the"] },
  ];
  // big-win discriminators: a real win needs an ACTION on a win OBJECT (e.g. "booked a commercial", "closed a
  // wholesale account", "signed a retailer", "landed a brand deal"), or one of the win category's standalone phrases.
  var WIN_ACTIONS = ["booked", "closed", "signed", "landed", "sold", "scored", "secured", "clinched", "inked", "won", "nabbed"];
  var WIN_OBJECTS = ["gig", "role", "part", "job", "show", "commercial", "campaign", "client", "account", "deal", "contract", "sale", "sales", "partner", "agent", "brand", "sponsor", "sponsorship", "wholesale", "retailer", "retainer", "booking"];

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
  // on a WHOOP-RED recovery day, resting IS the right physical move — so the Daily Quest waives the physical
  // requirement for that day. Gated to TODAY's snapshot (snapshot date === the day checked), so it never
  // retroactively excuses a past miss or lingers on a stale red reading.
  function physicalWaived(s, day) {
    if (!s || !s.whoop || s.whoop.recovery == null || num(s.whoop.recovery, 100) >= 34) return false;
    var wd = dayIndexFromYMD(s.whoop.date);
    return Number.isFinite(wd) && wd === day;
  }
  function reqMetForDim(s, day, d, have, need) {
    if (have >= need) return true;
    return d === "physical" && physicalWaived(s, day);
  }
  function isDailyMet(s, day) {
    var h = repsOn(s, day), req = CONFIG.dailyQuest.requirements;
    for (var d = 0; d < DIMENSIONS.length; d++) {
      var dim = DIMENSIONS[d];
      if (!reqMetForDim(s, day, dim, (h[dim] || 0), (req[dim] || 0))) return false;
    }
    return true;
  }
  function dailyProgress(s, day) {
    var h = repsOn(s, day), req = CONFIG.dailyQuest.requirements, done = 0, total = 0;
    DIMENSIONS.forEach(function (d) { total++; if (reqMetForDim(s, day, d, (h[d] || 0), (req[d] || 0))) done++; });
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
      daily: { day: today, completed: false, rewardedDay: null }, // rewardedDay = the day the +50 was banked (so a cross-device merge credits it exactly once)
      penalty: { active: false, sinceDay: null },
      bigWins: 0,
      epoch: 0,                   // bumped on reset; a higher epoch wins a merge wholesale (reset is a deliberate discontinuity)
      log: [],
      lastActiveDay: today,
      recurring: {},              // recurringId -> lastDoneDay
      external: { seen: {} },     // "source:kind:id" -> dayIngested (dedup for WHOOP etc.)
      whoop: null,                // latest WHOOP vitals snapshot (display only; XP lives in history)
      hydration: { day: today, oz: 0, metDays: [] }, // today's water intake (oz) + goal-met day indices (for the streak); resets daily
      // build + activity tier drive the personalized hydration goal (and future calorie/effort sizing).
      // WHOOP-derived: 25-day avg day-strain ~10 with frequent 15+ days (basketball, lifting, hikes) => "active".
      profile: { heightIn: 77, weightLb: 208, activityTier: "active" },
      salesByDay: {},             // dayIndex -> total Vybrance sales $ that day (durable; survives log eviction)
      // Generator signature: a once-a-day subjective gut-read of how the day FELT (1 Drained .. 4 Satisfied).
      // Objective output is XP; this is the feeling that tells a Generator the day was correct. Never penalizes.
      satisfaction: { byDay: {} }, // dayIndex -> level 1..4
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
        if (dk > today + 1) continue; // drop clock-glitch future days (today+1 grace for tz); you can't act in the future
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
      out.daily.rewardedDay = (s.daily.rewardedDay != null) ? Math.min(num(s.daily.rewardedDay, -1), today) : null;
      // INVARIANT: a completed day ALWAYS banked its +50 (via _credit or the merge), so rewardedDay MUST equal
      // daily.day for any completed day. Enforcing it here both (a) backfills legacy pre-rewardedDay saves and
      // (b) collapses any rewardedDay<->day desync from a torn/corrupt write, so the merge's "credit the +50 once"
      // guard can never re-add a reward for an already-rewarded day (keeps mergeStates idempotent on such saves).
      if (out.daily.completed) out.daily.rewardedDay = out.daily.day;
    }
    if (s.penalty && typeof s.penalty === "object") {
      out.penalty.active = !!s.penalty.active;
      out.penalty.sinceDay = num(s.penalty.sinceDay, null);
    }
    out.bigWins = nonNeg(s.bigWins);
    out.epoch = Math.floor(nonNeg(s.epoch));   // reset generation counter (preserved, never trusted as non-int)
    if (Array.isArray(s.log)) out.log = s.log.slice(0, LOG_CAP);
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
      var wRec = num(s.whoop.recovery, null);
      out.whoop = {
        date: s.whoop.date ? String(s.whoop.date) : null,
        recovery: wRec,
        // derive the zone from a valid recovery (keep them consistent); only trust a stored zone if recovery is absent
        zone: wRec !== null ? recoveryZone(wRec) : ((["green", "yellow", "red"].indexOf(s.whoop.zone) !== -1) ? s.whoop.zone : "unknown"),
        sleepHours: num(s.whoop.sleepHours, null),
        sleepPerf: num(s.whoop.sleepPerf, null),
        strain: num(s.whoop.strain, null),
        hrv: num(s.whoop.hrv, null),
        rhr: num(s.whoop.rhr, null),
        syncedTs: num(s.whoop.syncedTs, null),
      };
    }
    if (s.hydration && typeof s.hydration === "object") {
      var md = Array.isArray(s.hydration.metDays) ? s.hydration.metDays : [];
      var seenMd = {}, mdU = [];
      md.forEach(function (x) { var n = num(x, null); if (n === null) return; n = Math.floor(n); if (n > today + 1 || seenMd[n]) return; seenMd[n] = 1; mdU.push(n); });
      mdU.sort(function (a, b) { return a - b; });
      if (mdU.length > 120) mdU = mdU.slice(mdU.length - 120);
      out.hydration = { day: Math.min(num(s.hydration.day, today), today), oz: nonNeg(s.hydration.oz), metDays: mdU };
    }
    if (s.profile && typeof s.profile === "object") {
      out.profile = {
        heightIn: nonNeg(num(s.profile.heightIn, out.profile.heightIn)),
        weightLb: nonNeg(num(s.profile.weightLb, out.profile.weightLb)),
        activityTier: (["sedentary", "active", "athlete"].indexOf(s.profile.activityTier) !== -1) ? s.profile.activityTier : out.profile.activityTier,
      };
    }
    // durable per-day sales $: repair existing values, then BACKFILL from the log via max (so pre-salesByDay
    // saves get the durable record without double-counting). Finite, no future days.
    out.salesByDay = {};
    if (s.salesByDay && typeof s.salesByDay === "object") {
      for (var sdk in s.salesByDay) if (Object.prototype.hasOwnProperty.call(s.salesByDay, sdk)) {
        var sdd = Number(sdk), sdv = nonNeg(s.salesByDay[sdk]);
        // bound to the recent window (same as mergeStates) so the durable record can't grow the doc unbounded
        if (Number.isFinite(sdd) && sdd <= today + 1 && sdd >= today - 400 && sdv > 0) out.salesByDay[String(Math.floor(sdd))] = sdv;
      }
    }
    var logByDay = {};
    (out.log || []).forEach(function (e) { if (e && e.dim === "financial" && e.amount != null) { var d = num(e.day, null); if (d === null || d > today + 1 || d < today - 400) return; var k = String(Math.floor(d)); logByDay[k] = (logByDay[k] || 0) + nonNeg(e.amount); } });
    for (var lbk in logByDay) out.salesByDay[lbk] = Math.max(nonNeg(out.salesByDay[lbk]), Math.round(logByDay[lbk] * 100) / 100);
    // satisfaction check-ins: finite day keys (no future), level clamped to 1..4, bounded to recent days
    out.satisfaction = { byDay: {} };
    if (s.satisfaction && typeof s.satisfaction === "object" && s.satisfaction.byDay && typeof s.satisfaction.byDay === "object") {
      for (var stk in s.satisfaction.byDay) if (Object.prototype.hasOwnProperty.call(s.satisfaction.byDay, stk)) {
        var std = Number(stk), stv = Math.round(num(s.satisfaction.byDay[stk], 0));
        if (Number.isFinite(std) && std <= today + 1 && std >= today - 400 && stv >= 1 && stv <= 4) out.satisfaction.byDay[String(Math.floor(std))] = stv;
      }
    }
    out.version = SCHEMA_VERSION;
    recomputeStreak(out, today); // streak is always derived, never trusted from disk
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
    // DON'T carry the v1 ledger forward: v1's e.xp was the already-AMPLIFIED credited xp (it even stored mult),
    // but v2's logAgg rebuilds dims/totalXp from baseXp on every merge — copying amplified xp into baseXp would
    // silently re-inflate a v1 user's totals the first time they sync across devices. dims/totalXp/incomeXp/
    // history are already migrated faithfully from v1's own aggregates above; we only lose old display rows, not
    // progress. (v1 entries also lack extKey/amount, so they could never dedup or back a durable sales record.)
    s.log = [];
    s.statPoints.available = Math.max(0, (levelFromXp(s.totalXp).level - 1) * CONFIG.statPointsPerLevel);
    recomputeStreak(s, safeToday(now));
    return s;
  }

  function migrateIfNeeded(s, now) {
    if (s && s.version === SCHEMA_VERSION) return s;
    if (!s || typeof s !== "object") return newState("Lawrence", now);
    if (!s.version || s.version < 2) return migrateV1toV2(s, now);
    return s; // future/newer save — validateRepair coerces it
  }

  // streak is ALWAYS recomputed from history (single source of truth).
  function recomputeStreak(s, today) {
    var days = Object.keys(s.history).map(Number).filter(Number.isFinite).filter(function (d) {
      var h = s.history[d]; return h && DIMENSIONS.some(function (x) { return (h[x] || 0) > 0; });
    }).sort(function (a, b) { return a - b; });
    if (!days.length) { s.streak = { current: 0, longest: 0, lastDay: null }; return; }
    var longest = 1, run = 1;
    for (var i = 1; i < days.length; i++) { if (days[i] === days[i - 1] + 1) run++; else run = 1; if (run > longest) longest = run; }
    var cur = 1;
    for (var j = days.length - 1; j > 0; j--) { if (days[j] === days[j - 1] + 1) cur++; else break; }
    var lastDay = days[days.length - 1];
    // a streak is only "current" if it reaches today or yesterday; once a full day is missed it's broken,
    // so don't keep showing a live streak the player no longer has (must agree with any penalty incurred).
    if (Number.isFinite(today) && lastDay < today - 1) cur = 0;
    s.streak = { current: cur, longest: longest, lastDay: lastDay };
  }

  // roll forward to an explicit day; resolve missed days into exactly one penalty (never a stack).
  function reconcileTo(s, today) {
    s = clone(s);
    if (!Number.isFinite(today)) today = num(s.daily && s.daily.day, 0);
    if (!s.daily) s.daily = { day: today, completed: false, rewardedDay: null };
    var last = num(s.daily.day, today);
    var created = num(s.player.createdDay, today);
    var prevReward = num(s.daily.rewardedDay, null); // the last day the +50 was banked; carry it across the roll-forward
    if (today > last) {
      var missed = false;
      // the last opened day: penalize if it's past grace, wasn't completed, and history doesn't show it met
      if (last > created && !s.daily.completed && !isDailyMet(s, last)) missed = true;
      // any fully-skipped intermediate day (no engagement) beyond the grace day
      if (today - last > 1 && (today - 1) > created) missed = true;
      if (missed) s.penalty = { active: true, sinceDay: today };
      s.daily = { day: today, completed: isDailyMet(s, today), rewardedDay: prevReward };
    } else if (today < last) {
      s.daily = { day: today, completed: isDailyMet(s, today), rewardedDay: prevReward }; // clock moved back -> resync, no penalty
    } else {
      s.daily.completed = s.daily.completed || isDailyMet(s, today);
    }
    // A fully-met day must never sit under an active penalty — whether it became met via a live rep, a recovery
    // waiver, or a merge of two devices' partial days. Doing the full day's work IS the recovery, so clear it.
    // This makes penalty-clear path-independent (the _credit edge-clear stays for the live-rep celebration),
    // so the income multiplier/bonuses are never silently suppressed on a completed day. (no-shame ethic)
    if (s.daily.completed && isPenalized(s)) s.penalty = { active: false, sinceDay: null };
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

  // pick the chronologically fresher of two WHOOP vitals snapshots (then newer syncedTs on a same-day tie).
  function mergeWhoop(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    function idx(w) { return (w && w.date && Number.isFinite(dayIndexFromYMD(w.date))) ? dayIndexFromYMD(w.date) : -Infinity; }
    var ia = idx(a), ib = idx(b);
    if (ia !== ib) return ia > ib ? a : b;
    return num(a.syncedTs, 0) >= num(b.syncedTs, 0) ? a : b;
  }

  // Merge two saves into one that LOSES NO PROGRESS. The cloud store is last-write-wins at the document
  // level (cloudPush writes the whole doc), which silently drops reps whenever two devices diverge (offline
  // edits, races). This makes reconciliation CONFLICT-FREE and MONOTONIC instead: every aggregate takes the
  // max, every set the union, history the per-cell max; streak/daily/penalty are re-derived. Idempotent and
  // order-independent on progress — two devices always converge to the same state, and no rep is ever lost.
  // aggregate a log (the per-rep ledger) into totals — used by the CRDT merge to reconstruct progress
  // without double-counting. baseXp drives dims/totalXp; a financial rep's amplified xp drives incomeXp.
  function logAgg(log) {
    var a = { total: 0, income: 0, big: 0, dims: emptyDay(), dayDim: {} };
    (log || []).forEach(function (e) {
      if (!e || DIMENSIONS.indexOf(e.dim) === -1) return;
      var bx = num(e.baseXp, num(e.xp, 0));
      a.total += bx; a.dims[e.dim] += bx;
      if (e.dim === "financial") a.income += num(e.xp, 0);
      if (e.big) a.big += 1;
      var dk = Number(e.day);
      if (Number.isFinite(dk)) { var key = String(dk); if (!a.dayDim[key]) a.dayDim[key] = emptyDay(); a.dayDim[key][e.dim] += 1; }
    });
    return a;
  }

  function mergeStates(aRaw, bRaw, now) {
    now = now || new Date();
    var A = validateRepair(migrateIfNeeded(aRaw, now), now);
    var B = validateRepair(migrateIfNeeded(bRaw, now), now);

    // RESET is a deliberate discontinuity, not progress: a higher epoch wins the whole save (no merge), so
    // "reset save" actually propagates across devices instead of being silently undone by the monotonic union.
    // GUARD: reset bumps the epoch by exactly 1, so a gap this large means a corrupt/garbage epoch — refuse to
    // let it wipe a healthy device; fall through to the normal lossless merge and pin epoch to the lower sane value.
    var EPOCH_TRUST_GAP = 10000;
    if (A.epoch !== B.epoch && Math.abs(A.epoch - B.epoch) <= EPOCH_TRUST_GAP) {
      var hi = clone(A.epoch > B.epoch ? A : B); recomputeStreak(hi, safeToday(now)); hi.version = SCHEMA_VERSION; return hi;
    }

    var out = clone(A);
    out.player.createdDay = Math.min(A.player.createdDay, B.player.createdDay); // earliest birth wins
    if (B.player.name && B.player.name !== "Lawrence" && (!A.player.name || A.player.name === "Lawrence")) out.player.name = B.player.name;
    out.player.initials = initialsOf(out.player.name);
    out.epoch = Math.min(A.epoch, B.epoch); // equal in the normal case; lower (sane) value if an outlier epoch was rejected above

    // log: union deduped by extKey (external/deduped reps) else (ts,dim,name,xp), newest-first. Build the
    // FULL deduped union FIRST and aggregate from THAT (gU below); only AFTER do we slice for storage. The
    // earlier code aggregated from the already-sliced out.log, so a union exceeding the cap silently dropped
    // reps/XP — the aggregate must see EVERY unioned rep, not just the most-recent cap of them.
    var seenLog = {}, log = [];
    (A.log || []).concat(B.log || []).forEach(function (e) {
      if (!e) return;
      var key = e.extKey ? ("x|" + e.extKey) : (num(e.ts, 0) + "|" + e.dim + "|" + e.name + "|" + num(e.xp, 0));
      if (!seenLog[key]) { seenLog[key] = 1; log.push(e); }
    });
    log.sort(function (x, y) { return num(y.ts, 0) - num(x.ts, 0); });
    out.log = log.slice(0, LOG_CAP);   // recent ledger for display; aggregates use the FULL union (gU) below

    // CRDT-style aggregate merge. Divergent reps are RECENT (in the unioned log); older reps are shared (equal
    // on both). For each aggregate take max( stored-on-either, aged-portion + FULL-unioned-log ), aged-portion
    // = total minus that device's own logged portion. gU aggregates the FULL union (NOT the sliced out.log),
    // so no rep is lost when the union exceeds LOG_CAP. Residual edge: only if BOTH devices have already
    // truncated their own logs (>LOG_CAP lifetime reps each) AND each still holds divergent reps beyond that
    // window can the lower-total device's older divergent reps be unrecoverable — months of single-device
    // offline use. The common cases (superset sync, sub-cap divergence) are fully lossless and double-count-free.
    var gA = logAgg(A.log), gB = logAgg(B.log), gU = logAgg(log);
    out.totalXp  = Math.max(A.totalXp,  B.totalXp,  Math.max(0, A.totalXp  - gA.total,  B.totalXp  - gB.total)  + gU.total);
    out.incomeXp = Math.max(A.incomeXp, B.incomeXp, Math.max(0, A.incomeXp - gA.income, B.incomeXp - gB.income) + gU.income);
    out.bigWins  = Math.max(A.bigWins,  B.bigWins,  Math.max(0, A.bigWins  - gA.big,    B.bigWins  - gB.big)    + gU.big);
    DIMENSIONS.forEach(function (d) {
      out.dims[d] = Math.max(A.dims[d], B.dims[d], Math.max(0, A.dims[d] - gA.dims[d], B.dims[d] - gB.dims[d]) + gU.dims[d]);
    });

    // history: per day+dim, same reconstruction (recent divergent reps from the unioned log; old shared days agree)
    out.history = {};
    var dayKeys = {};
    for (var ka in A.history) if (Object.prototype.hasOwnProperty.call(A.history, ka)) dayKeys[ka] = 1;
    for (var kb in B.history) if (Object.prototype.hasOwnProperty.call(B.history, kb)) dayKeys[kb] = 1;
    Object.keys(dayKeys).forEach(function (dk) {
      var ha = A.history[dk] || emptyDay(), hb = B.history[dk] || emptyDay(), m = emptyDay();
      var ua = gA.dayDim[dk] || emptyDay(), ub = gB.dayDim[dk] || emptyDay(), uu = gU.dayDim[dk] || emptyDay();
      DIMENSIONS.forEach(function (d) {
        m[d] = Math.max(ha[d] || 0, hb[d] || 0, Math.max(0, (ha[d] || 0) - (ua[d] || 0), (hb[d] || 0) - (ub[d] || 0)) + (uu[d] || 0));
      });
      out.history[dk] = m;
    });

    // dedup set: UNION, keeping the EARLIEST ingested day (so a re-sync after merge can't re-credit)
    out.external = { seen: {} };
    [A.external.seen, B.external.seen].forEach(function (src) {
      for (var sk in src) if (Object.prototype.hasOwnProperty.call(src, sk)) {
        var v = num(src[sk], null); if (v === null) continue;
        out.external.seen[sk] = (out.external.seen[sk] === undefined) ? v : Math.min(out.external.seen[sk], v);
      }
    });
    pruneSeen(out.external.seen);   // keep the dedup set bounded after the union (it was grown unbounded on merge)

    // recurring upkeep: most-recent completion per id
    out.recurring = {};
    [A.recurring, B.recurring].forEach(function (src) {
      for (var rk in src) if (Object.prototype.hasOwnProperty.call(src, rk)) {
        var rv = num(src[rk], null); if (rv === null) continue;
        out.recurring[rk] = (out.recurring[rk] === undefined) ? rv : Math.max(out.recurring[rk], rv);
      }
    });

    // titles: union (valid ids only); keep an active title if either device has one
    var tset = {};
    (A.unlockedTitles || []).concat(B.unlockedTitles || []).forEach(function (id) { if (TITLE_BY_ID[id]) tset[id] = 1; });
    out.unlockedTitles = Object.keys(tset);
    // active title: deterministic + order-independent — highest passive bonus wins, tie-break by id
    var tA = (A.activeTitle && TITLE_BY_ID[A.activeTitle]) ? A.activeTitle : null;
    var tB = (B.activeTitle && TITLE_BY_ID[B.activeTitle]) ? B.activeTitle : null;
    if (tA && tB && tA !== tB) {
      var bA = TITLE_BY_ID[tA].bonusPct, bB = TITLE_BY_ID[tB].bonusPct;
      out.activeTitle = (bA !== bB) ? (bA > bB ? tA : tB) : (tA < tB ? tA : tB);
    } else out.activeTitle = tA || tB || null;

    // stat points are a CONSERVED pool: earned == available + sum(allocated), earned derived from level.
    // Maxing available & each allocated[] independently fabricates points (allocate-6-to-financial on A and
    // 6-to-physical on B -> 12 exist where 6 were earned). Instead keep the allocation from the further-
    // progressed device, then derive available from the merged earned total so the books always balance.
    var earned = Math.max(0, (levelFromXp(out.totalXp).level - 1) * CONFIG.statPointsPerLevel);
    // pick the further-progressed device's allocation; deterministic tie-break (more allocated, then a stable
    // serialization) so the merge is order-independent even when totalXp ties.
    function allocKey(s) { var sum = 0; DIMENSIONS.forEach(function (d) { sum += Math.max(0, Math.floor(num(s.statPoints.allocated[d], 0))); }); return [num(s.totalXp, 0), sum, JSON.stringify(s.statPoints.allocated)]; }
    var kA = allocKey(A), kB = allocKey(B), pickSP = A;
    for (var spi = 0; spi < kA.length; spi++) { if (kA[spi] !== kB[spi]) { pickSP = (kA[spi] > kB[spi]) ? A : B; break; } }
    var chosen = pickSP.statPoints.allocated;
    var alloc = emptyDay(), allocSum = 0;
    DIMENSIONS.forEach(function (d) { alloc[d] = Math.max(0, Math.floor(num(chosen[d], 0))); allocSum += alloc[d]; });
    if (allocSum > earned) { alloc = emptyDay(); allocSum = 0; }   // allocation can't exceed earned -> fall back to all-available
    out.statPoints = { available: Math.max(0, earned - allocSum), allocated: alloc };

    out.lastActiveDay = Math.max(A.lastActiveDay, B.lastActiveDay);
    out.whoop = mergeWhoop(A.whoop, B.whoop);

    // hydration: same day -> MAX oz (you can't un-drink water; conflict-free, never inflates); else the later day.
    // The goal-completion REP carries an extKey ("hydration:hydration_goal:hydr-<day>"), so the log-union above
    // collapses two devices' same-day goal hits to ONE entry -> the aggregate rebuild credits it exactly once.
    var ah = A.hydration || { day: 0, oz: 0, metDays: [] }, bh = B.hydration || { day: 0, oz: 0, metDays: [] };
    var mdSet = {};
    (ah.metDays || []).concat(bh.metDays || []).forEach(function (x) { var n = num(x, null); if (n !== null) mdSet[Math.floor(n)] = 1; });
    var mdMerged = Object.keys(mdSet).map(Number).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    if (mdMerged.length > 120) mdMerged = mdMerged.slice(mdMerged.length - 120);   // bound the met-days history
    out.hydration = (ah.day === bh.day)
      ? { day: ah.day, oz: Math.max(nonNeg(ah.oz), nonNeg(bh.oz)), metDays: mdMerged }
      : (ah.day > bh.day ? { day: ah.day, oz: nonNeg(ah.oz), metDays: mdMerged } : { day: bh.day, oz: nonNeg(bh.oz), metDays: mdMerged });

    // durable per-day sales $: per-day MAX (a grow-only CRDT — commutative/idempotent). Bounded to recent days.
    // (recentSalesTotal takes max(this, log-sum), so the live log still covers concurrent same-day different-order
    // credits within the window; this is the durable backstop once entries age out of the capped log.)
    out.salesByDay = {};
    var sbdToday = safeToday(now), sbdKeys = {};
    [A.salesByDay, B.salesByDay].forEach(function (mm) { for (var k in (mm || {})) if (Object.prototype.hasOwnProperty.call(mm, k)) sbdKeys[k] = 1; });
    Object.keys(sbdKeys).forEach(function (dk) {
      var d = Number(dk); if (!Number.isFinite(d) || d > sbdToday + 1 || d < sbdToday - 400) return;
      var v = Math.max(nonNeg(A.salesByDay && A.salesByDay[dk]), nonNeg(B.salesByDay && B.salesByDay[dk]));
      if (v > 0) out.salesByDay[String(Math.floor(d))] = v;
    });

    // satisfaction check-ins: union per day; on a same-day conflict take the MAX level (deterministic and
    // order-independent — you rarely re-rate the same day on two devices). Bounded to the recent window.
    out.satisfaction = { byDay: {} };
    var satKeys = {};
    [A.satisfaction && A.satisfaction.byDay, B.satisfaction && B.satisfaction.byDay].forEach(function (mm) { for (var k in (mm || {})) if (Object.prototype.hasOwnProperty.call(mm, k)) satKeys[k] = 1; });
    Object.keys(satKeys).forEach(function (dk) {
      var d = Number(dk); if (!Number.isFinite(d) || d > sbdToday + 1 || d < sbdToday - 400) return;
      var av = (A.satisfaction && A.satisfaction.byDay) ? num(A.satisfaction.byDay[dk], 0) : 0;
      var bv = (B.satisfaction && B.satisfaction.byDay) ? num(B.satisfaction.byDay[dk], 0) : 0;
      var v = Math.round(Math.max(av, bv));
      if (v >= 1 && v <= 4) out.satisfaction.byDay[String(Math.floor(d))] = v;
    });

    // daily: same day -> completed if EITHER did; else the later day's record
    if (A.daily.day === B.daily.day) out.daily = { day: A.daily.day, completed: !!(A.daily.completed || B.daily.completed), rewardedDay: null };
    else out.daily = (A.daily.day > B.daily.day) ? { day: A.daily.day, completed: A.daily.completed, rewardedDay: null } : { day: B.daily.day, completed: B.daily.completed, rewardedDay: null };
    // rewardedDay = the latest day either device banked the +50 (used just below to credit a split completion once)
    var mReward = Math.max(num(A.daily.rewardedDay, -1), num(B.daily.rewardedDay, -1));
    out.daily.rewardedDay = mReward < 0 ? null : mReward;

    // penalty: cleared if EITHER device cleared it (never re-penalize a device that already recovered)
    var pActive = !!(A.penalty.active && B.penalty.active);
    out.penalty = { active: pActive, sinceDay: pActive ? Math.max(num(A.penalty.sinceDay, 0), num(B.penalty.sinceDay, 0)) : null };

    // The +50 daily reward is folded into totalXp (NOT the log), so the aggregate rebuild above preserves it only
    // for a device that actually completed the day alone. If the merged history is daily-met but neither device
    // completed solo (X did 3 dims, Y the other 3), no +50 was ever banked — credit it exactly once here, marked by
    // rewardedDay so a re-merge can't double it. Also mirror the path-independent penalty-clear for a complete day.
    var mDay = out.daily.day;
    if (isDailyMet(out, mDay)) {
      out.daily.completed = true;
      if (out.daily.rewardedDay !== mDay) { out.totalXp += CONFIG.dailyQuest.reward; out.daily.rewardedDay = mDay; }
      if (out.penalty.active) out.penalty = { active: false, sinceDay: null };
    }

    // profile (build/activity): deterministic, order-independent pick — most-recently-active device, then
    // most-progressed, then heavier weight, then a stable serialization. (Both devices normally hold the same
    // profile; this only matters once a profile editor exists and the two diverge.)
    (function () {
      var a = A.profile, b = B.profile;
      if (!a && !b) return;
      if (!a) { out.profile = clone(b); return; }
      if (!b) { out.profile = clone(a); return; }
      var ka = [num(A.lastActiveDay, 0), num(A.totalXp, 0), num(a.weightLb, 0), JSON.stringify(a)];
      var kb = [num(B.lastActiveDay, 0), num(B.totalXp, 0), num(b.weightLb, 0), JSON.stringify(b)];
      var pick = a;
      for (var i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) { pick = (ka[i] > kb[i]) ? a : b; break; } }
      out.profile = clone(pick);
    })();

    recomputeStreak(out, safeToday(now));       // streak is always derived from the merged history
    out.version = SCHEMA_VERSION;
    return out;
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

    recomputeStreak(s, today);

    var ts = (now && typeof now.getTime === "function" && Number.isFinite(now.getTime())) ? now.getTime() : Date.now();
    // extKey = the source's dedup identity (set by ingestExternal). It lets mergeStates collapse two
    // independent offline credits of the SAME external event (same id, different wall-clock ts) into ONE
    // log entry before aggregates are reconstructed — without it the ts-keyed union double-counts them.
    s.log.unshift({ ts: ts, day: today, dim: rep.dim, repId: rep.id || null, name: rep.name, baseXp: rep.xp, mult: mult, xp: rep.dim === "financial" ? gained : rep.xp, big: !!rep.big, source: rep.source || "manual", extKey: rep.extKey || null, amount: (rep.amount != null ? num(rep.amount, 0) : null) });
    if (s.log.length > LOG_CAP) s.log.length = LOG_CAP;
    if (rep.dim === "financial" && rep.amount != null) {   // durable per-day sales $ (so the readout survives log eviction)
      if (!s.salesByDay) s.salesByDay = {};
      s.salesByDay[today] = Math.round(((s.salesByDay[today] || 0) + nonNeg(rep.amount)) * 100) / 100;
    }
    s.lastActiveDay = today;

    if (!s.daily.completed && isDailyMet(s, today)) {
      s.daily.completed = true;
      s.totalXp += CONFIG.dailyQuest.reward;
      s.daily.rewardedDay = today;   // mark the bank so a later cross-device merge won't re-credit (or drop) the +50
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

  // consecutive days (ending today, or yesterday if today isn't logged yet) with >=1 rep in `dim` — the
  // per-dimension analogue of the global streak, derived from history so it can't be faked. Anchored on the
  // monotonic game-day. Drives the Stats panel's per-category streak chips.
  function dimStreak(state, dim, now) {
    if (!state || DIMENSIONS.indexOf(dim) === -1) return 0;
    var today = effectiveDay(state, now);
    var h = state.history || {};
    function did(d) { var x = h[d]; return !!(x && (x[dim] || 0) > 0); }
    var day = did(today) ? today : (did(today - 1) ? today - 1 : null);
    if (day === null) return 0;
    var n = 0;
    while (did(day)) { n++; day--; }
    return n;
  }

  // total $ of Vybrance sales credited in the last `days` (default 7), summed from the log's sale entries.
  // Drives the "your level grows with your last-7-day sales" readout. Pure.
  function recentSalesTotal(state, days, now) {
    var today = effectiveDay(state, now);
    var since = today - (Math.max(1, num(days, 7)) - 1);
    var log = (state && state.log) || [];
    var logSum = 0;
    log.forEach(function (e) {
      if (!e || e.dim !== "financial" || e.amount == null) return;
      if (num(e.day, -1) >= since) logSum += nonNeg(e.amount);
    });
    // durable backstop: sum the per-day record over the window. max(live log, durable) never under-reports —
    // the log covers recent sales within the cap; salesByDay survives once entries age out.
    var sbd = (state && state.salesByDay) || {}, sbdSum = 0;
    for (var k in sbd) if (Object.prototype.hasOwnProperty.call(sbd, k)) { var d = num(k, -1); if (d >= since && d <= today) sbdSum += nonNeg(sbd[k]); }
    return Math.round(Math.max(logSum, sbdSum));
  }

  // ============================ POWER LEVEL — a LIVE readout of how you're operating NOW ============================
  // NOT a lifetime XP tally (that only ever ratcheted up and blew past the top tier). Instead a 0..10,000 score
  // that reflects your CURRENT trajectory and aligns to Lawrence's real goals — three normalized parts, each 0..max,
  // blended by CONFIG.powerLevel.weights and nudged by WHOOP recovery:
  //   R  Vybrance momentum  = trailing-30-day revenue as a run-rate toward the real ~$260k/mo peak
  //   L  Life              = how high your six dimensions stand, on AVERAGE (rewards a leveled, balanced life)
  //   C  Consistency       = your live streaks across all six dimensions
  // It rises as you rebuild and can DIP if revenue stalls or streaks break, so it stays honest. Deterministic & pure.
  function powerRating(state, now) {
    if (!state || typeof state !== "object") return 0;
    var cfg = CONFIG.powerLevel, MAX = cfg.scale, w = cfg.weights;
    var R = clamp(recentSalesTotal(state, 30, now) / cfg.peakMonthlyRevenue, 0, 1) * MAX;   // revenue run-rate
    var lifeSum = 0; DIMENSIONS.forEach(function (d) { lifeSum += levelFromXp(nonNeg(state.dims && state.dims[d])).level; });
    var L = clamp(((lifeSum / DIMENSIONS.length) - 1) / (cfg.lifeLevelCap - 1), 0, 1) * MAX; // avg dim level above the Lv1 floor
    var streaks = 0; DIMENSIONS.forEach(function (d) { streaks += dimStreak(state, d, now); });
    var C = clamp(streaks / cfg.streakCap, 0, 1) * MAX;                                       // live streak-days
    var rec = (state.whoop && state.whoop.recovery != null) ? clamp(num(state.whoop.recovery, 70), 0, 100) : 70;
    var vitality = 0.85 + 0.15 * (rec / 100);                                                 // 0.85–1.00 WHOOP nudge
    var r = Math.round((w.revenue * R + w.life * L + w.consistency * C) * vitality);
    return Number.isFinite(r) ? Math.max(0, Math.min(r, MAX)) : 0;   // never NaN/Infinity, bounded to the scale
  }
  // power stages = Luffy's gears (One Piece), anchored to REAL milestones on the 0..10,000 scale:
  //   Gear 2 ≈ rebuilding (~$12k/mo + showing up) · Gear 3 ≈ ~$30k/mo · Gear 4 ≈ ~$60k/mo ·
  //   Gear 5 ≈ ~$100k/mo + life dialed in · Sun God Nika ≈ Vybrance near peak + elite consistency.
  var POWER_TIERS = [
    { min: 0, name: "Base Form" }, { min: 1000, name: "Gear 2" }, { min: 2200, name: "Gear 3" },
    { min: 3500, name: "Gear 4" }, { min: 5200, name: "Gear 5" }, { min: 8500, name: "Sun God Nika" },
  ];
  function powerTier(rating) {
    var r = POWER_TIERS[0], idx = 0;
    for (var i = 0; i < POWER_TIERS.length; i++) if (rating >= POWER_TIERS[i].min) { r = POWER_TIERS[i]; idx = i; }
    var next = POWER_TIERS[idx + 1] || null;
    var prevMin = r.min, span = next ? (next.min - prevMin) : 1;
    return { name: r.name, min: prevMin, next: next ? next.name : null, nextAt: next ? next.min : null,
             pct: next ? clamp(Math.round(((rating - prevMin) / span) * 100), 0, 100) : 100 };
  }
  // how much your Power Level MOVED over the last `days` (can be negative — the score is a live readout, not a tally).
  function powerGain(state, days, now) {
    var n = Math.max(2, num(days, 7) + 1);   // include the start point `days` ago plus today
    var tr = ratingTrend(state, n, now);
    return Math.round(tr[tr.length - 1].rating - tr[0].rating);
  }
  // 7-day rollup for the Weekly Pulse card (reps, XP, active days, top dimension, sales, best live streak). Pure.
  function weeklyPulse(state, now) {
    var today = effectiveDay(state, now), since = today - 6;
    var log = (state && state.log) || [];
    var reps = 0, xp = 0, byDim = emptyDay(), days = {};
    log.forEach(function (e) {
      if (!e || num(e.day, -1) < since) return;
      reps += 1; xp += nonNeg(e.baseXp != null ? e.baseXp : e.xp);
      if (DIMENSIONS.indexOf(e.dim) !== -1) byDim[e.dim] += 1;
      days[num(e.day, -1)] = 1;
    });
    var top = DIMENSIONS[0];
    DIMENSIONS.forEach(function (d) { if (byDim[d] > byDim[top]) top = d; });
    var bestStreak = 0, bestDim = null;
    DIMENSIONS.forEach(function (d) { var s = dimStreak(state, d, now); if (s > bestStreak) { bestStreak = s; bestDim = d; } });
    return {
      reps: reps, xp: Math.round(xp), activeDays: Object.keys(days).length,
      topDim: (byDim[top] > 0 ? top : null), sales: recentSalesTotal(state, 7, now),
      bestStreak: bestStreak, bestStreakDim: bestDim, powerGain: powerGain(state, 7, now),
    };
  }

  // count history days where ALL six dimensions were trained / any dimension was trained
  function allSixDaysCount(state) {
    var h = state && state.history, c = 0; if (!h) return 0;
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) {
      var day = h[k], all = true;
      for (var i = 0; i < DIMENSIONS.length; i++) if (!(day && (day[DIMENSIONS[i]] || 0) > 0)) { all = false; break; }
      if (all) c++;
    }
    return c;
  }
  function activeDaysCount(state) {
    var h = state && state.history, c = 0; if (!h) return 0;
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) {
      var day = h[k];
      if (day && DIMENSIONS.some(function (d) { return (day[d] || 0) > 0; })) c++;
    }
    return c;
  }
  // 16 LEVELED achievement tracks (derived, no persisted state). Each track has multiple tiers you climb; the
  // tier names mix the worlds (One Piece / DBZ / Naruto / HxH / Solo Leveling). Returns level / maxLevel /
  // progress-to-next + the full ladder for the tap-to-see-how detail.
  function achievements(state, now) {
    var s = state || {};
    var reps = repsTotal(s), longest = (s.streak && s.streak.longest) || 0, big = nonNeg(s.bigWins);
    var metDays = (s.hydration && Array.isArray(s.hydration.metDays)) ? s.hydration.metDays.length : 0;
    var sales = recentSalesTotal(s, 7, now), rating = powerRating(s, now), lvl = playerLevel(s), power = incomeLevel(s);
    function dimLvl(d) { return levelFromXp(nonNeg(s.dims && s.dims[d])).level; }
    var minDim = DIMENSIONS.reduce(function (m, d) { return Math.min(m, dimLvl(d)); }, Infinity); if (!Number.isFinite(minDim)) minDim = 0;
    var sixDays = allSixDaysCount(s), activeDays = activeDaysCount(s);
    function n(x) { return Math.round(x).toLocaleString(); }
    function L(at, name) { return { at: at, name: name }; }
    // build one leveled track: count tiers passed, progress to the next, full labelled ladder.
    // `how` = plain-English "how to earn" shown on the detail sheet so every tier is self-explanatory.
    function T(id, name, icon, saga, unit, metric, levels, how) {
      function fmt(v) { return unit === "$" ? ("$" + n(v)) : unit === "Lv" ? ("Lv " + n(v)) : unit === "d" ? (n(v) + "d") : n(v); }
      var lv = 0; for (var i = 0; i < levels.length; i++) if (metric >= levels[i].at) lv = i + 1;
      var maxed = lv >= levels.length, next = maxed ? null : levels[lv], prevAt = lv > 0 ? levels[lv - 1].at : 0;
      return {
        id: id, name: name, icon: icon, saga: saga, how: how || "",
        levels: levels.map(function (x) { return { at: x.at, name: x.name, label: fmt(x.at) }; }),
        level: lv, maxLevel: levels.length, tierName: lv > 0 ? levels[lv - 1].name : "",
        nextName: next ? next.name : null, unlocked: lv >= 1,
        progress: maxed ? 1 : clamp((metric - prevAt) / ((next.at - prevAt) || 1), 0, 1),
        progressText: maxed ? "MAX" : (fmt(metric) + " / " + fmt(next.at))
      };
    }
    return [
      // Mirrors the Power-card gear tiers on the 0..10,000 scale, then adds the DBZ "It's Over 9,000!" easter egg
      // as the ultimate flex ABOVE Sun God Nika — you've literally crossed 9,000 (only near-perfect revenue + life +
      // streaks gets you there). The extra top tier is deliberate, not drift — don't "unify" it away.
      T("power", "Power Level", "⚡", "One Piece × DBZ", "", rating,
        [L(1000, "Gear 2"), L(2200, "Gear 3"), L(3500, "Gear 4"), L(5200, "Gear 5"), L(8500, "Sun God Nika"), L(9000, "It's Over 9,000!")],
        "Raise your Power Level — your live readout: Vybrance revenue + life levels + live streaks, scaled by WHOOP."),
      T("actualization", "Actualization", "🧬", "Human Design 6/3", "Lv", lvl,
        [L(5, "Experimenter"), L(10, "Builder"), L(18, "Master"), L(28, "Sage"), L(42, "Role Model"), L(60, "Actualized")],
        "Level up your overall character (total XP across all six dimensions) — the 6/3 Generator path from trial-and-error to self-actualized."),
      T("fire", "Will of Fire", "🔥", "Naruto", "d", longest,
        [L(3, "Genin"), L(7, "Chunin"), L(14, "Jonin"), L(30, "Sannin"), L(60, "Kage"), L(100, "Hokage")],
        "Build your longest daily streak — log at least one rep every single day."),
      T("training", "Training", "💪", "Dragon Ball Z", "", reps,
        [L(10, "Warm-Up"), L(50, "Weighted Clothes"), L(100, "Gravity x10"), L(250, "Gravity x100"), L(500, "Hyperbolic Chamber"), L(1000, "Ultra Instinct")],
        "Log more reps total — every rep in any dimension counts toward the grind."),
      T("wins", "Big Wins", "🏆", "One Piece", "", big,
        [L(1, "First Win"), L(3, "The Closer"), L(5, "Conqueror's Haki"), L(10, "Emperor"), L(25, "Living Legend")],
        "Bank big wins — log a milestone moment (booked gig, closed deal, signed partner)."),
      T("treasure", "Treasure", "💎", "Hunter x Hunter", "$", sales,
        [L(250, "Bounty"), L(500, "Greed Island"), L(1000, "Spirit Bomb"), L(2500, "Roger's Stash"), L(5000, "One Piece")],
        "Drive Vybrance sales — your rolling 7-day Shopify + Amazon revenue."),
      T("earning", "Earning Power", "💰", "Vybrance", "Lv", power,
        [L(3, "Hustler"), L(5, "Rainmaker"), L(10, "Mogul"), L(15, "Tycoon"), L(20, "Kingpin")],
        "Raise your Earning Power — Financial-dimension XP from sales and money reps."),
      T("hydration", "Hydration", "💧", "Vybrance", "d", metDays,
        [L(1, "First Sip"), L(7, "Hydrated"), L(30, "Water Sage"), L(90, "Aquaman")],
        "Hit your daily water goal — fill the bar on as many days as you can."),
      T("nen", "Nen Mastery", "🌀", "Hunter x Hunter", "Lv", minDim,
        [L(2, "Ten"), L(3, "Ren"), L(5, "Hatsu"), L(10, "Nen Master")],
        "Level up ALL six dimensions evenly — your weakest dimension sets this tier."),
      T("balance", "Balance", "🎯", "Core", "", sixDays,
        [L(1, "Whole"), L(5, "Balanced"), L(15, "Renaissance"), L(30, "Ascended")],
        "Have days where you train all six dimensions — total perfect-balance days."),
      T("mind", "Mind", "🧠", "Naruto", "Lv", dimLvl("mental"),
        [L(3, "Student"), L(5, "Scholar"), L(10, "Sage"), L(15, "Grandmaster")],
        "Level up your Mental dimension — reading, learning, deep work, therapy."),
      T("body", "Body", "🦾", "Dragon Ball Z", "Lv", dimLvl("physical"),
        [L(3, "Athlete"), L(5, "Warrior"), L(10, "Beast"), L(15, "Titan")],
        "Level up your Physical dimension — workouts, hikes, WHOOP activity, sleep."),
      T("spirit", "Spirit", "🙏", "Naruto", "Lv", dimLvl("spiritual"),
        [L(3, "Calm"), L(5, "Centered"), L(10, "Sage Mode"), L(15, "Enlightened")],
        "Level up your Spiritual dimension — meditation, gratitude, nature, rest."),
      T("bonds", "Bonds", "🤝", "Core", "Lv", dimLvl("family"),
        [L(3, "Present"), L(5, "Devoted"), L(10, "Pillar"), L(15, "Patriarch")],
        "Level up your Family dimension — calls, quality time, showing up for family."),
      T("influence", "Influence", "🗣️", "Naruto", "Lv", dimLvl("social"),
        [L(3, "Friendly"), L(5, "Connector"), L(10, "Talk-no-Jutsu"), L(15, "Charismatic")],
        "Level up your Social dimension — friends, events, networking, reaching out."),
      T("consistency", "Consistency", "🗓️", "Solo Leveling", "d", activeDays,
        [L(7, "Week"), L(30, "Month"), L(100, "Centurion"), L(365, "Year of the Player")],
        "Show up on more days total — every day you log anything counts."),
    ];
  }
  // reconstruct the Power Level trend for the last `days`. The score's most volatile, cheaply-reconstructable part
  // is REVENUE momentum, so we vary the trailing-30-day revenue per day (from the durable salesByDay record) and
  // hold life/consistency/vitality at their current values (they aren't accurately back-computable per day). The
  // final point therefore equals the live powerRating (endpoint-accurate). Pure.
  function ratingTrend(state, days, now) {
    var s = state || {};
    var today = effectiveDay(s, now), n = Math.max(2, num(days, 14)), since = today - (n - 1);
    var cfg = CONFIG.powerLevel, MAX = cfg.scale, w = cfg.weights;
    var log = s.log || [], sbd = s.salesByDay || {};
    // life reconstruction: floor (per-dim XP older than the log window) + logged baseXp up to each day, so the
    // trend reflects dimension-level gains over the window. Endpoint == current dims, so it stays endpoint-exact.
    var loggedByDim = emptyDay(), floorDim = emptyDay();
    log.forEach(function (e) { if (e && DIMENSIONS.indexOf(e.dim) !== -1) loggedByDim[e.dim] += nonNeg(e.baseXp != null ? e.baseXp : e.xp); });
    DIMENSIONS.forEach(function (d) { floorDim[d] = Math.max(0, nonNeg(s.dims && s.dims[d]) - loggedByDim[d]); });
    // consistency + vitality held current (streaks aren't accurately back-computable per day)
    var streaks = 0; DIMENSIONS.forEach(function (d) { streaks += dimStreak(s, d, now); });
    var C = clamp(streaks / cfg.streakCap, 0, 1) * MAX;
    var rec = (s.whoop && s.whoop.recovery != null) ? clamp(num(s.whoop.recovery, 70), 0, 100) : 70;
    var vitality = 0.85 + 0.15 * (rec / 100);
    var series = [];
    for (var d = since; d <= today; d++) {
      var rev = 0, lo = d - 29;
      for (var k in sbd) if (Object.prototype.hasOwnProperty.call(sbd, k)) { var dk = num(k, -1); if (dk >= lo && dk <= d) rev += nonNeg(sbd[k]); }
      var R = clamp(rev / cfg.peakMonthlyRevenue, 0, 1) * MAX;
      var dimXP = {}; DIMENSIONS.forEach(function (dd) { dimXP[dd] = floorDim[dd]; });
      log.forEach(function (e) { if (e && DIMENSIONS.indexOf(e.dim) !== -1 && num(e.day, Infinity) <= d) dimXP[e.dim] += nonNeg(e.baseXp != null ? e.baseXp : e.xp); });
      var lifeSum = 0; DIMENSIONS.forEach(function (dd) { lifeSum += levelFromXp(dimXP[dd]).level; });
      var L = clamp(((lifeSum / DIMENSIONS.length) - 1) / (cfg.lifeLevelCap - 1), 0, 1) * MAX;
      series.push({ day: d, rating: Math.round((w.revenue * R + w.life * L + w.consistency * C) * vitality) });
    }
    return series;
  }

  // ---- hydration: a daily "fill the bar" water tracker ----------------------------------------------
  // today's logged oz (0 if the stored day isn't today — the bar resets every day).
  function hydrationOz(state, today) {
    var h = state && state.hydration; if (!h) return 0;
    return (num(h.day, today) === today) ? nonNeg(h.oz) : 0;
  }
  // consecutive days (ending today, or yesterday if today isn't done yet) whose goal was met. Derived from
  // hydration.metDays — a dedicated bounded set that is union-merged across devices — so it can't be truncated
  // by the external.seen prune bound, faked by a single counter, or polluted by malformed keys. Anchored on
  // effectiveDay (the monotonic game-day) so it matches the day addWater writes met-days at.
  function hydrationStreak(state, now) {
    var today = effectiveDay(state, now);
    var md = (state && state.hydration && Array.isArray(state.hydration.metDays)) ? state.hydration.metDays : [];
    var done = {};
    md.forEach(function (x) { var n = num(x, null); if (n !== null) done[Math.floor(n)] = 1; });
    var day = done[today] ? today : (done[today - 1] ? today - 1 : null);
    if (day === null) return 0;
    var n = 0;
    while (done[day]) { n++; day--; }
    return n;
  }
  // PERSONALIZED daily water goal (oz) from the player's build + activity tier (see CONFIG.hydration for the
  // peer-reviewed basis). Falls back to CONFIG.hydration.goalOz when there's no usable profile. Pure.
  function hydrationGoalOz(state) {
    var H = CONFIG.hydration || {};
    var fallback = H.goalOz || 125;
    var p = state && state.profile;
    var lb = p ? num(p.weightLb, 0) : 0;
    if (!(lb > 0)) return fallback;
    var tier = (p && ["sedentary", "active", "athlete"].indexOf(p.activityTier) !== -1) ? p.activityTier : "active";
    var mlPerKg = (H.mlPerKg && H.mlPerKg[tier]) || 35;
    var allowance = (H.activityAllowanceOz && H.activityAllowanceOz[tier] != null) ? H.activityAllowanceOz[tier] : 13;
    var kg = lb * 0.453592;
    var oz = (kg * mlPerKg) / 29.5735 + allowance;   // mL -> US fl oz (29.5735 mL/oz), + training allowance
    return clamp(Math.round(oz / 5) * 5, 64, 220);    // round to nearest 5 oz; sane human bounds
  }
  function hydrationStatus(state, now) {
    var today = effectiveDay(state, now);   // read at the SAME monotonic game-day addWater writes, not safeToday
    var goal = hydrationGoalOz(state);
    var oz = hydrationOz(state, today);
    return { oz: oz, goalOz: goal, pct: clamp(round((oz / goal) * 100), 0, 100), met: oz >= goal, remaining: Math.max(0, goal - oz), streak: hydrationStreak(state, now) };
  }
  // log water (oz) for today. Accumulates; the FIRST crossing of the daily goal credits ONE Physical rep
  // through ingestExternal (deterministic id "hydr-<day>"), so re-logging more water or a cross-device sync
  // can never double-credit (external.seen dedups). Pure — returns new state + events.
  function addWater(state, oz, now) {
    oz = Math.max(0, round(num(oz, 0)));
    var s = clone(state);
    if (!s || typeof s !== "object") s = newState("Lawrence", now);
    var today = effectiveDay(s, now);
    var goal = hydrationGoalOz(s);
    var metDays = (s.hydration && Array.isArray(s.hydration.metDays)) ? s.hydration.metDays : [];
    if (!s.hydration || num(s.hydration.day, today) !== today) s.hydration = { day: today, oz: 0, metDays: metDays }; // new day resets oz, KEEPS the met-days history
    if (!s.hydration.metDays) s.hydration.metDays = metDays;
    if (!oz) return { state: s, events: [] };
    var before = nonNeg(s.hydration.oz);
    s.hydration.day = today;
    s.hydration.oz = Math.min(before + oz, goal * 3); // sane cap (3x goal) so a fat-fingered entry can't run away
    var events = [{ type: "WATER_LOGGED", oz: oz, total: s.hydration.oz, goalOz: goal, met: s.hydration.oz >= goal }];
    if (before < goal && s.hydration.oz >= goal) {    // first time hitting the goal today -> credit a Physical rep + record the met-day
      if (s.hydration.metDays.indexOf(today) === -1) {
        s.hydration.metDays = s.hydration.metDays.concat([today]).sort(function (a, b) { return a - b; });
        if (s.hydration.metDays.length > 120) s.hydration.metDays = s.hydration.metDays.slice(s.hydration.metDays.length - 120);
      }
      var r = ingestExternal(s, [{ source: "hydration", kind: "hydration_goal", id: "hydr-" + today, oz: goal }], now);
      s = r.state;   // ingestExternal cloned `s` (hydration + metDays preserved) and credited the deduped rep
      events = events.concat(r.events);
      events.push({ type: "HYDRATION_GOAL", goalOz: goal });
    }
    return { state: s, events: events };
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

  // route an arbitrary WHOOP-ish payload into { days, acts }. Handles {days:[…]}, {activities:[…]},
  // a single day object, a single pre-shaped activity, and MIXED arrays (partitioned per element so
  // a heterogeneous batch never silently drops half its entries). Pure; shared by the app + tests.
  function looksLikeWhoopDay(o) { return !!(o && typeof o === "object" && (o.recovery || o.sleep || o.workouts || o.date)); }
  function looksLikeActivity(o) { return !!(o && typeof o === "object" && o.kind && o.id != null); }
  function classifyWhoopPayload(obj) {
    var days = [], acts = [];
    function routeOne(o) { if (looksLikeWhoopDay(o)) days.push(o); else if (looksLikeActivity(o)) acts.push(o); }
    if (Array.isArray(obj)) obj.forEach(routeOne);
    else if (obj && Array.isArray(obj.days)) days = obj.days;
    else if (obj && Array.isArray(obj.activities)) acts = obj.activities;
    else routeOne(obj);
    return { days: days, acts: acts };
  }

  // ingest one or more WHOOP days AND stamp the latest day's vitals onto state. The single entry point
  // shared by the in-app sync and the whoop-sync.js game-master, so the snapshot can never drift from XP.
  // Note: recovery/sleep are deduped by date (rec-<date>) — the FIRST sync of a day sets its XP; later
  // intra-day score corrections refresh the vitals display but don't re-credit (by design: no re-farming).
  function ingestWhoopDays(state, days, now) {
    var list = Array.isArray(days) ? days : [days];
    var acts = [];
    list.forEach(function (d) { acts = acts.concat(whoopDayToActivities(d)); });
    var r = ingestExternal(state, acts, now);
    // pick the CHRONOLOGICALLY latest day (numeric Y-M-D — "2026-7-9" must lose to "2026-7-10", which a
    // lexicographic string compare gets backwards). Fall back to last-in-batch only if no date parses.
    var latest = null, latestIdx = -Infinity;
    list.forEach(function (d) {
      if (!d || typeof d !== "object" || !d.date) return;
      var di = dayIndexFromYMD(d.date);
      if (Number.isFinite(di) && di >= latestIdx) { latestIdx = di; latest = d; }
    });
    if (!latest && list.length) latest = list[list.length - 1];
    var v = whoopVitals(latest);
    if (v) {
      v.syncedTs = (now && typeof now.getTime === "function" && Number.isFinite(now.getTime())) ? now.getTime() : Date.now();
      // recency guard: never let an OLDER day's snapshot clobber a fresher one (e.g. a stale auto-fetch
      // resolving after a fresh deep-link). ingestExternal already returned a fresh clone we own.
      var prev = r.state.whoop;
      var prevIdx = (prev && prev.date && Number.isFinite(dayIndexFromYMD(prev.date))) ? dayIndexFromYMD(prev.date) : -Infinity;
      var curIdx = Number.isFinite(latestIdx) ? latestIdx : Infinity; // no parseable date -> treat as newest
      if (!prev || curIdx >= prevIdx) r.state.whoop = v;
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
      case "hydration_goal":
        return { id: "hydration", dim: "physical", name: "Hydrated — " + num(a.oz, (CONFIG.hydration && CONFIG.hydration.goalOz) || 110) + "oz 💧", xp: 10, source: a.source || "hydration" };
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
      case "order":
      case "vybrance_sale": {
        // a real Vybrance sale = a "seed for growth": it credits Financial XP (raising the overall level + Earning
        // Power) and records the $ amount (which drives the Power Level's revenue momentum). Deduped by order id.
        // NOTE: a sale is NOT a "Big Win" — big wins are real milestones (booking a gig, closing a wholesale account).
        // Tagging every $200 sales day as a big win inflated both the Big Wins count and the old Power Level.
        var amt = num(a.amount, 0);
        var src = a.source || "shopify";
        var srcLabel = src === "amazon" ? "Amazon" : (src === "shopify" ? "Shopify" : src);
        return { id: "sale", dim: "financial", amount: amt, name: "🌱 " + srcLabel + " sale" + (amt ? (" $" + amt) : ""), xp: clamp(round((amt || 20) / 2), 10, 200), source: src };
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
    // canonicalize the sale family: sale/order/vybrance_sale all map to the SAME rep, so the same order id must
    // dedup regardless of which alias a feed used (else a kind-alias re-ingest triple-credits the same sale).
    var k = (a.kind === "order" || a.kind === "vybrance_sale") ? "sale" : a.kind;
    return part(a.source || "whoop") + ":" + part(k || "activity") + ":" + part(a.id);
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
    if (!s || typeof s !== "object") s = newState("Lawrence", now); // null/garbage state -> safe default (public-API hardening)
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
      rep.extKey = key;                          // carry the dedup identity into the log entry (merge-layer dedup)
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

  // is this text a real big win? Standalone win phrase, OR a win action applied to a win object. Pure.
  function isBigWin(t) {
    var win = CATEGORIES.filter(function (c) { return c.id === "win"; })[0];
    if (win) { for (var i = 0; i < win.kw.length; i++) if (kwHit(t, win.kw[i])) return true; }
    var act = false, obj = false;
    for (var a = 0; a < WIN_ACTIONS.length; a++) if (kwHit(t, WIN_ACTIONS[a])) { act = true; break; }
    if (!act) return false;
    for (var o = 0; o < WIN_OBJECTS.length; o++) if (kwHit(t, WIN_OBJECTS[o])) { obj = true; break; }
    return act && obj;
  }

  // classify a free-text activity into {dim, category, xp, big, confidence}. Pure.
  function classifyActivity(text) {
    var t = " " + String(text || "").toLowerCase() + " ";
    if (!t.trim()) return null;
    // big win first, via the dedicated discriminator (not the generic kw count)
    if (isBigWin(t)) return { dim: "financial", category: "Big win", categoryId: "win", xp: 300, big: true, confidence: 0.9, matched: 2 };
    var best = null, bestScore = 0;
    CATEGORIES.forEach(function (c) {
      if (c.id === "win") return; // handled above; its bare stems must not match here
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

  // ======================= Human Design — satisfaction (signature) + sacral response =======================
  // SATISFACTION: a Generator's success signal is the FEELING that the day was correct, not just the XP output.
  // Once-a-day, one-tap, 1 Drained .. 4 Satisfied. Never penalizes or gates anything; it's a mirror, not a score.
  function setSatisfaction(state, level, now) {
    var lvl = Math.round(num(level, 0));
    if (lvl < 1 || lvl > 4) return { state: state, ok: false };
    var s = clone(state);
    if (!s.satisfaction || typeof s.satisfaction !== "object") s.satisfaction = { byDay: {} };
    if (!s.satisfaction.byDay) s.satisfaction.byDay = {};
    s.satisfaction.byDay[String(effectiveDay(s, now))] = lvl;
    return { state: s, ok: true };
  }
  function satisfactionToday(state, now) {
    var by = (state && state.satisfaction && state.satisfaction.byDay) || {};
    var v = num(by[String(effectiveDay(state, now))], null);
    return (v >= 1 && v <= 4) ? Math.round(v) : null;
  }
  // last `days` of satisfaction as {day, level|null}, oldest..today (for the sparkline)
  function satisfactionTrend(state, days, now) {
    var today = effectiveDay(state, now), n = Math.max(1, num(days, 7));
    var by = (state && state.satisfaction && state.satisfaction.byDay) || {};
    var out = [];
    for (var d = today - (n - 1); d <= today; d++) { var v = num(by[String(d)], null); out.push({ day: d, level: (v >= 1 && v <= 4) ? Math.round(v) : null }); }
    return out;
  }
  // soft, NON-penalizing frustration early-warning (the not-self theme): warn only when the last few RATED days
  // average low. Purely advisory — surfaces a gentle "respond differently" nudge, never gates or punishes.
  function frustrationSignal(state, now) {
    var tr = satisfactionTrend(state, 5, now).filter(function (x) { return x.level != null; });
    if (tr.length < 3) return { warn: false, avg: null, rated: tr.length };
    var sum = 0; tr.forEach(function (x) { sum += x.level; });
    var avg = sum / tr.length;
    return { warn: avg <= 2, avg: Math.round(avg * 10) / 10, rated: tr.length };
  }

  // SACRAL RESPONSE: Generators are designed to RESPOND, not initiate — so instead of a blank picker, the System
  // PRESENTS one rep at a time for a gut yes/no. This returns the ORDERED candidate queue (UI walks it on "no").
  // Ranking: dims still unmet for today's quest come first (a YES advances the quest), then the dim touched least;
  // WHOOP zone tilts it — red floats restorative dims/reps to the front ("recover"), green sorts by highest XP
  // ("you're primed, spend it"). Big-win reps are excluded (those are momentous, logged deliberately). Pure.
  var RESTORATIVE_REPS = ["phys_sleep", "phys_mobility", "spir_rest", "spir_meditate", "spir_nature", "fam_time", "soc_friend"];
  function sacralQueue(state, now) {
    var s = (state && typeof state === "object") ? state : {};
    if (!s.history) return [];   // no state to rank against -> empty queue (don't throw on a falsy/partial state)
    var today = effectiveDay(s, now);
    var h = repsOn(s, today), req = CONFIG.dailyQuest.requirements;
    var zone = (s.whoop && s.whoop.zone) || "unknown";
    var dimsByNeed = DIMENSIONS.slice().sort(function (a, b) {
      var ma = reqMetForDim(s, today, a, (h[a] || 0), req[a] || 0) ? 1 : 0;
      var mb = reqMetForDim(s, today, b, (h[b] || 0), req[b] || 0) ? 1 : 0;
      if (ma !== mb) return ma - mb;            // unmet-today dims first
      return (h[a] || 0) - (h[b] || 0);          // then the dim you've touched least today
    });
    if (zone === "red") dimsByNeed.sort(function (a, b) { // on red, float restorative dims to the front (still stable-ish)
      var ra = (a === "spiritual" || a === "physical") ? 0 : 1, rb = (b === "spiritual" || b === "physical") ? 0 : 1;
      return ra - rb;
    });
    var queue = [];
    dimsByNeed.forEach(function (d) {
      var reps = repsForDim(d).filter(function (r) { return !r.big; });
      reps.sort(function (a, b) {
        if (zone === "red") {
          var ra = RESTORATIVE_REPS.indexOf(a.id) !== -1 ? 0 : 1, rb = RESTORATIVE_REPS.indexOf(b.id) !== -1 ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return a.xp - b.xp;                     // gentler reps first when depleted
        }
        if (zone === "green") return b.xp - a.xp; // primed: biggest reps first
        return 0;
      });
      reps.forEach(function (r) { queue.push({ id: r.id, dim: r.dim, name: r.name, xp: r.xp }); });
    });
    return queue;
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
    mergeStates: mergeStates,
    reconcile: reconcile,
    reconcileTo: reconcileTo,
    validateRepair: validateRepair,
    migrateV1toV2: migrateV1toV2,
    recomputeStreak: recomputeStreak,
    applyRep: applyRep,
    applyRecurring: applyRecurring,
    recurringStatus: recurringStatus,
    dimStreak: dimStreak,
    recentSalesTotal: recentSalesTotal,
    powerRating: powerRating,
    powerTier: powerTier,
    powerGain: powerGain,
    weeklyPulse: weeklyPulse,
    achievements: achievements,
    ratingTrend: ratingTrend,
    physicalWaived: physicalWaived,
    POWER_TIERS: POWER_TIERS,
    HYDRATION_PRESETS: HYDRATION_PRESETS,
    addWater: addWater,
    hydrationStatus: hydrationStatus,
    hydrationGoalOz: hydrationGoalOz,
    hydrationOz: hydrationOz,
    hydrationStreak: hydrationStreak,
    ingestExternal: ingestExternal,
    ingestWhoopDays: ingestWhoopDays,
    classifyWhoopPayload: classifyWhoopPayload,
    whoopActivityToRep: whoopActivityToRep,
    whoopDayToActivities: whoopDayToActivities,
    whoopVitals: whoopVitals,
    recoveryZone: recoveryZone,
    externalActivityToRep: externalActivityToRep,
    classifyActivity: classifyActivity,
    logActivity: logActivity,
    allocateStat: allocateStat,
    setActiveTitle: setActiveTitle,
    setSatisfaction: setSatisfaction,
    satisfactionToday: satisfactionToday,
    satisfactionTrend: satisfactionTrend,
    frustrationSignal: frustrationSignal,
    sacralQueue: sacralQueue,
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
