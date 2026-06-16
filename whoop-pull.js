/* whoop-pull.js — autonomous WHOOP fetch (no Claude, no MCP, no taps).
 *
 * Reads your WHOOP OAuth token (the SAME file the MCP server uses: ~/.config/whoop-mcp/tokens.json),
 * refreshes it only when expired (so it never fights the MCP's token rotation), pulls the last few days
 * of recovery / sleep / strain / workouts straight from the WHOOP API, and writes whoop-today.json in
 * the shape the Protagonist engine ingests. Run by launchd on a schedule -> the app auto-loads it.
 *
 *   node whoop-pull.js [outfile]      (default: whoop-today.json next to this script)
 */
var fs = require("fs");
var os = require("os");
var path = require("path");

var TOKEN_FILE = path.join(os.homedir(), ".config", "whoop-mcp", "tokens.json");
var TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
var API = "https://api.prod.whoop.com/developer/v2";
var OUT = process.argv[2] || path.join(__dirname, "whoop-today.json");
var DAYS = 3; // how many recent local days to publish

function whoopCreds() {
  var cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
  var env = (cfg.mcpServers && cfg.mcpServers.whoop && cfg.mcpServers.whoop.env);
  if (!env && cfg.projects) {                       // fall back: scan per-project mcp config
    Object.keys(cfg.projects).some(function (k) {
      var w = cfg.projects[k] && cfg.projects[k].mcpServers && cfg.projects[k].mcpServers.whoop;
      if (w && w.env) { env = w.env; return true; } return false;
    });
  }
  if (!env || !env.WHOOP_CLIENT_ID) throw new Error("no WHOOP creds in ~/.claude.json");
  return { id: env.WHOOP_CLIENT_ID, secret: env.WHOOP_CLIENT_SECRET };
}

async function accessToken() {
  var tok = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  var now = Math.floor(Date.now() / 1000);
  if (tok.expires_at && tok.expires_at > now + 60) return tok.access_token; // still valid -> don't touch refresh token
  var c = whoopCreds();
  var body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: c.id, client_secret: c.secret, scope: "offline" });
  var r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!r.ok) throw new Error("token refresh failed " + r.status + " " + (await r.text()));
  var j = await r.json();
  var nt = { access_token: j.access_token, refresh_token: j.refresh_token || tok.refresh_token, expires_at: now + (j.expires_in || 3600) };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(nt, null, 2), { mode: 0o600 }); // persist rotation back to the shared file
  return nt.access_token;
}

async function api(token, p) {
  var r = await fetch(API + p, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("GET " + p + " -> " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

// wall-clock YYYY-MM-DD (zero-padded) in the record's own UTC offset (e.g. "-05:00")
function localDate(iso, off) {
  var t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  var m = /([+-])(\d\d):(\d\d)/.exec(off || "+00:00");
  var mins = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  var d = new Date(t + mins * 60000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function hrs(ms) { return Math.round((ms / 3600000) * 100) / 100; }
function r1(n) { return Math.round(n * 10) / 10; }

(async function () {
  var token = await accessToken();
  var cyc = await api(token, "/cycle?limit=10");
  var rec = await api(token, "/recovery?limit=10");
  var slp = await api(token, "/activity/sleep?limit=10");
  var wk = await api(token, "/activity/workout?limit=25");

  var cycleById = {}, cycleDate = {}, days = {};
  function day(d) { if (!days[d]) days[d] = { date: d, workouts: [] }; return days[d]; }
  (cyc.records || []).forEach(function (c) { cycleById[c.id] = c; });

  // WHOOP cycles START the prior evening, so a cycle REPRESENTS its wake-up day, not its start day.
  // Date recovery by when it was scored (the morning), then hang strain off that same wake day.
  (rec.records || []).forEach(function (x) {
    var c = cycleById[x.cycle_id], tz = c ? c.timezone_offset : "+00:00";
    var d = localDate(x.created_at, tz); if (!d || !x.score) return;
    cycleDate[x.cycle_id] = d;
    day(d).recovery = { score: Math.round(x.score.recovery_score), hrv: Math.round(x.score.hrv_rmssd_milli || 0), rhr: Math.round(x.score.resting_heart_rate || 0) };
  });
  (cyc.records || []).forEach(function (c) {
    var d = cycleDate[c.id] || localDate(c.end || c.start, c.timezone_offset); if (!d) return;
    cycleDate[c.id] = d;
    if (c.score && c.score.strain != null) day(d).strain = r1(c.score.strain);
  });
  (slp.records || []).forEach(function (s) {                 // sleep ENDS on the wake morning
    var d = localDate(s.end, s.timezone_offset) || cycleDate[s.cycle_id]; if (!d || !s.score) return;
    var ss = s.score.stage_summary || {};
    var asleep = (ss.total_light_sleep_time_milli || 0) + (ss.total_slow_wave_sleep_time_milli || 0) + (ss.total_rem_sleep_time_milli || 0);
    day(d).sleep = { id: s.id, hours: hrs(asleep), performance: Math.round(s.score.sleep_performance_percentage || 0) };
  });
  (wk.records || []).forEach(function (w) {                  // workouts are intra-day -> date by start
    var d = localDate(w.start, w.timezone_offset); if (!d) return;
    var mins = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000);
    day(d).workouts.push({ id: w.id, sport: w.sport_name || "workout", durationMin: mins, strain: r1((w.score && w.score.strain) || 0) });
  });

  var out = { days: Object.keys(days).sort().slice(-DAYS).map(function (k) { return days[k]; }) };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  var last = out.days[out.days.length - 1] || {};
  console.log("wrote " + out.days.length + " day(s) -> " + OUT + "  | latest " + last.date +
    ": recovery " + (last.recovery && last.recovery.score) + ", sleep " + (last.sleep && last.sleep.hours) + "h, strain " + last.strain + ", " + (last.workouts || []).length + " workout(s)");
  process.exit(0);
})().catch(function (e) { console.error("whoop-pull FAILED: " + ((e && e.message) || e)); process.exit(1); });
