/* WHOOP game-master — turns a day's WHOOP data into Protagonist XP.
 *
 * Run this from a Claude session (or cron) that HAS the WHOOP MCP loaded:
 *   1. Pull the day from WHOOP (recovery score, sleep hours, workouts w/ duration).
 *   2. Shape it as a whoopDay (or array of days) — see the example at the bottom.
 *   3. node whoop-sync.js <save.json> <whoop.json>
 *      -> reads the current save, ingests WHOOP (idempotent, deduped by activity id),
 *         writes the updated save back, and prints what it credited.
 *
 * Idempotent: re-running the same day never double-counts (engine dedups by source:kind:id).
 */
var E = require("./engine.js");

function syncDays(saveRaw, whoopDays, now) {
  now = now || new Date();
  var state = E.init(saveRaw, now).state;
  // ingestWhoopDays = shape -> ingest (idempotent, deduped) -> stamp latest vitals. Same path the app uses.
  var r = E.ingestWhoopDays(state, Array.isArray(whoopDays) ? whoopDays : [whoopDays], now);
  return { save: r.state, credited: r.credited, events: r.events };
}

module.exports = { syncDays: syncDays };

if (require.main === module) {
  var fs = require("fs");
  var savePath = process.argv[2], whoopPath = process.argv[3];
  if (!savePath || !whoopPath) {
    console.error("usage: node whoop-sync.js <save.json> <whoop.json>");
    process.exit(2);
  }
  var whoop;
  try {
    if (!fs.existsSync(whoopPath)) throw new Error("file not found: " + whoopPath);
    whoop = JSON.parse(fs.readFileSync(whoopPath, "utf8"));
  } catch (e) {
    console.error("invalid or missing WHOOP JSON: " + e.message);
    process.exit(1);
  }
  var saveRaw = fs.existsSync(savePath) ? fs.readFileSync(savePath, "utf8") : null;
  var out = syncDays(saveRaw, whoop.days || whoop, new Date());
  fs.writeFileSync(savePath + ".tmp", JSON.stringify(out.save)); // atomic: tmp -> rename, never clobber on a crash mid-write
  fs.renameSync(savePath + ".tmp", savePath);
  console.log("synced " + out.credited.length + " WHOOP activities -> " + savePath);
  out.credited.forEach(function (c) { console.log("  +" + c.xp + "  " + c.name); });
}

/* Example whoop.json (one day). `strain` (0-21) and sleep `performance` are optional:
{
  "date": "2026-06-15",
  "recovery": { "score": 72, "hrv": 90, "rhr": 47 },
  "sleep": { "id": "sleep-abc", "hours": 7.6, "performance": 81 },
  "strain": 14.9,
  "workouts": [
    { "id": "wk-123", "sport": "running", "durationMin": 42, "strain": 11.2 },
    { "id": "wk-124", "sport": "weightlifting", "durationMin": 35, "strain": 8.4 }
  ]
}
Or multiple days: { "days": [ {…}, {…} ] }
*/
