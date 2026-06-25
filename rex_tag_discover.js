/**
 * Print the exact contact_tags / property_tags item shape from Rex's own examples.
 * Run with:  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"; node rex_tag_discover.js
 */
const https = require("https");
const REX_EMAIL = "support@kndproperties.com.au";
const REX_PASSWORD = "Sales$2026";

function rexPost(path, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = https.request({ hostname: "api.rexsoftware.com", path: `/v1/rex${path}`, method: "POST", headers }, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject); req.write(payload); req.end();
  });
}
function sec(t){ console.log(`\n${"─".repeat(60)}\n── ${t}\n${"─".repeat(60)}`); }

async function main() {
  const login = await rexPost("/Authentication/login", { email: REX_EMAIL, password: REX_PASSWORD });
  const token = login.body?.result;
  if (typeof token !== "string") { console.error("Login failed"); return; }
  console.log("✓ Logged in.");

  // contacts/update — full request definition + example for contact_tags
  sec("contacts/update — contact_tags definition");
  const cDesc = await rexPost("/contacts/describe", { include_detail: true }, token);
  const cReq = cDesc.body?.result?.methods?.update?.openapi?.request;
  const cTagsDef = cReq?.parameters?.data?.definition?.properties?.related?.properties?.contact_tags;
  console.log("DEFINITION:", JSON.stringify(cTagsDef, null, 2));
  console.log("EXAMPLE   :", JSON.stringify(cReq?.examples?.Example1?.data?.related?.contact_tags ?? cReq?.examples?.Example1?.data?._related?.contact_tags, null, 2));

  // properties/update — full request definition + example for property_tags
  sec("properties/update — property_tags definition");
  const pDesc = await rexPost("/properties/describe", { include_detail: true }, token);
  const pReq = pDesc.body?.result?.methods?.update?.openapi?.request;
  const pTagsDef = pReq?.parameters?.data?.definition?.properties?.related?.properties?.property_tags;
  console.log("DEFINITION:", JSON.stringify(pTagsDef, null, 2));
  console.log("EXAMPLE   :", JSON.stringify(pReq?.examples?.Example1?.data?.related?.property_tags ?? pReq?.examples?.Example1?.data?._related?.property_tags, null, 2));

  // How are tags READ back? check contacts read openapi response for tag fields
  sec("contacts/read — tag fields in response example");
  const cReadResp = cDesc.body?.result?.methods?.read?.openapi?.response?.examples?.Example1?.example?.result;
  const cTagKeys = Object.keys(cReadResp ?? {}).filter(k => /tag/i.test(k));
  const cRelTagKeys = Object.keys(cReadResp?.related ?? {}).filter(k => /tag/i.test(k));
  console.log("top-level tag keys:", cTagKeys, "| related tag keys:", cRelTagKeys);
}
main().catch(console.error);
