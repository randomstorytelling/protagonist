/* google-reauth.js — one-command re-consent for the shared Google OAuth token so the autonomy feeds go live.
 *
 * Reuses the existing OAuth client at ~/.config/google-tasks/client.json and requests the THREE scopes the cloud
 * feeds need:  tasks.readonly (Tasks feed) + calendar.readonly (Calendar auto-reps) + gmail.send (morning brief).
 * Runs a localhost loopback flow: opens Google's consent page in your browser; after you approve, it captures the
 * code, exchanges it for a fresh refresh_token, writes it to tokens.json (so LOCAL feeds work), and PRINTS the
 * google_tasks_tokens JSON to paste into the FEED_CREDS GitHub secret (so the CLOUD feeds + brief go live).
 *
 *   node google-reauth.js
 *
 * One-time prereqs in Google Cloud Console (same OAuth client/project that issued client.json):
 *   - OAuth client is a "Desktop app" (loopback redirect is allowed automatically).
 *   - OAuth consent screen lists the scopes calendar.readonly + gmail.send, and your account is a Test User
 *     (or the app is Published). gmail.send is a "sensitive" scope, so it must be added there first.
 *
 * Nothing leaves your machine except the standard token exchange with Google. You consent in your own browser.
 */
"use strict";
var fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto"), cp = require("child_process");

var G_DIR = path.join(os.homedir(), ".config", "google-tasks");
var CLIENT_PATH = path.join(G_DIR, "client.json");
var TOKENS_PATH = path.join(G_DIR, "tokens.json");
var PORT = 53117;
var SCOPES = [
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function readClient() {
  var c = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf8"));
  var inst = c.installed || c.web || c;   // accept {client_id,...} or Google's {installed:{...}}/{web:{...}} shapes
  if (!inst.client_id || !inst.client_secret) throw new Error("client.json is missing client_id / client_secret");
  return { client_id: inst.client_id, client_secret: inst.client_secret };
}

(async function () {
  var cli = readClient();
  var redirect = "http://127.0.0.1:" + PORT;
  var stateTok = crypto.randomBytes(16).toString("hex");
  var authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: cli.client_id, redirect_uri: redirect, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state: stateTok,
  }).toString();

  var code = await new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      try {
        var u = new URL(req.url, redirect);
        var c = u.searchParams.get("code");
        if (!c) { res.end("waiting for Google…"); return; }
        if (u.searchParams.get("state") !== stateTok) { res.writeHead(400); res.end("state mismatch"); server.close(); reject(new Error("OAuth state mismatch")); return; }
        res.end("✅ Authorized. Close this tab and return to the terminal.");
        server.close();
        resolve(c);
      } catch (e) { reject(e); }
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", function () {
      console.log("\nOpening Google consent in your browser…\nIf it doesn't open, paste this URL:\n\n" + authUrl + "\n");
      var opener = process.platform === "darwin" ? "open" : (process.platform === "win32" ? "start" : "xdg-open");
      try { cp.exec(opener + " " + JSON.stringify(authUrl)); } catch (e) {}
    });
    setTimeout(function () { try { server.close(); } catch (e) {} reject(new Error("timed out waiting for consent (5 min)")); }, 300000);
  });

  var body = new URLSearchParams({ code: code, client_id: cli.client_id, client_secret: cli.client_secret, redirect_uri: redirect, grant_type: "authorization_code" });
  var r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!r.ok) throw new Error("token exchange failed " + r.status + ": " + (await r.text()));
  var tok = await r.json();
  if (!tok.refresh_token) throw new Error("Google returned no refresh_token. Revoke prior access at myaccount.google.com/permissions, then re-run (prompt=consent forces a fresh one).");

  var existing = {}; try { existing = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")); } catch (e) {}
  var merged = Object.assign({}, existing, {
    access_token: tok.access_token, refresh_token: tok.refresh_token,
    scope: tok.scope, token_type: tok.token_type, expiry_date: Date.now() + (tok.expires_in || 3600) * 1000,
  });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));

  console.log("\n✅ Re-authorized. Granted scopes:\n  " + String(tok.scope || SCOPES.join(" ")).split(" ").join("\n  "));
  console.log("\nWrote " + TOKENS_PATH + " — your LOCAL Calendar feed + brief work now.");
  console.log("\n--- To go LIVE in the cloud: set FEED_CREDS.google_tasks_tokens to this exact object ---\n");
  console.log(JSON.stringify(merged));
  console.log("\n(Edit the FEED_CREDS GitHub secret JSON, replace its `google_tasks_tokens` value with the object");
  console.log(" above, keep the other fields. Then run the `feeds` and `morning-brief` workflows to test.)\n");
})().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
