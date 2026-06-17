/* amazon-seed.js — ONE-TIME: store your Amazon SP-API creds in private Firestore _feed/amazon.
 * Your secrets go straight from a local file into Firestore via your own owner login — they are never
 * printed and never pass through chat.
 *
 *   1) Create ~/.config/amazon-spapi.json (chmod 600) containing:
 *        {
 *          "refresh_token":  "Atzr|...",                         // from authorizing your SP-API app
 *          "client_id":      "amzn1.application-oa2-client...",   // your LWA app client id
 *          "client_secret":  "...",                               // your LWA app client secret
 *          "marketplace_id": "ATVPDKIKX0DER"                      // optional; defaults to US
 *        }
 *   2) node amazon-seed.js
 *   3) tell Claude — the nightly amazon-daily --spapi pull goes live.
 */
"use strict";
var fs = require("fs"), os = require("os"), path = require("path");
var FB = require("./whoop-feed.js");
var PROJECT = process.env.PROTAG_PROJECT || "protagonist-db3fd";
var DOC = process.env.AMAZON_FEED_DOC || "_feed/amazon";

(async function () {
  var f = process.env.AMAZON_SPAPI_FILE || path.join(os.homedir(), ".config", "amazon-spapi.json");
  var cred = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!cred.refresh_token || !cred.client_id || !cred.client_secret) throw new Error("need refresh_token, client_id, client_secret in " + f);
  if (!cred.marketplace_id) cred.marketplace_id = "ATVPDKIKX0DER";
  var tok = await FB.accessToken();
  var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents/" + DOC;
  var fields = {}; Object.keys(cred).forEach(function (k) { fields[k] = FB.toValue(cred[k]); });
  var r = await fetch(url, { method: "PATCH", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ fields: fields }) });
  if (!r.ok) throw new Error("Firestore write failed " + r.status + ": " + (await r.text()));
  console.log("seeded " + DOC + " (" + Object.keys(cred).join(", ") + "). amazon-daily --spapi is now live.");
})().catch(function (e) { console.error("FAIL " + ((e && e.message) || e)); process.exit(1); });
