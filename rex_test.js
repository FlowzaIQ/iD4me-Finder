/**
 * Rex CRM API — test file
 * Run with: node rex_test.js
 */

const https = require("https");

const REX_EMAIL    = "support@kndproperties.com.au";
const REX_PASSWORD = "Sales$2026";

function rexPost(path, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = https.request({
      hostname: "api.rexsoftware.com",
      path:     `/v1/rex${path}`,
      method:   "POST",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // ── Login ────────────────────────────────────────────────────────────────
  const loginRes = await rexPost("/Authentication/login", {
    email: REX_EMAIL, password: REX_PASSWORD,
  });
  if (loginRes.status !== 200 || typeof loginRes.body?.result !== "string") {
    console.error("Login failed:", JSON.stringify(loginRes.body, null, 2));
    return;
  }
  const token = loginRes.body.result;
  console.log("Logged in.\n");

  // ── Step 1: Find existing property — 20 Parrot Street Taylor ACT ─────────
  console.log("── Step 1: Find existing property ───────────────────────────────────────");

  const propSearchRes = await rexPost("/properties/search", {
    criteria: [
      { name: "property.adr_street_number",  value: "20" },
      { name: "property.adr_street_name",    value: "Parrot" },
      { name: "property.adr_suburb_or_town", value: "Taylor" },
    ],
    limit: 5,
  }, token);

  const propRows = propSearchRes.body?.result?.rows ?? [];
  if (propRows.length === 0) {
    console.error("Property not found — make sure 20 Parrot Street Taylor ACT exists in Rex.");
    return;
  }

  const propertyId = propRows[0].id;
  console.log(`Found property: ${propRows[0].system_search_key}  (ID: ${propertyId})\n`);

  // ── Step 2: Create contact — Sarah Singh ─────────────────────────────────
  console.log("── Step 2: Create contact — Sarah Singh ─────────────────────────────────");

  const contactRes = await rexPost("/contacts/create", {
    data: {
      type: "person",
      related: {
        contact_names:  [{ name_first: "Sarah", name_last: "Singh" }],
        contact_phones: [{ phone_number: "0432323555" }],
        contact_emails: [{ email_address: "sarah232@hotmail.com" }],
      }
    }
  }, token);

  if (contactRes.status !== 200 || !contactRes.body?.result) {
    console.error("Contact creation failed:", JSON.stringify(contactRes.body?.error, null, 2));
    return;
  }
  const contactId = contactRes.body.result?.id ?? contactRes.body.result;
  console.log(`Contact created! ID: ${contactId}\n`);

  // ── Step 3: Link Sarah to the property as owner ───────────────────────────
  console.log("── Step 3: Link Sarah Singh to 20 Parrot Street as owner ────────────────");

  const linkRes = await rexPost("/contacts/update", {
    data: {
      id: contactId,
      related: {
        contact_reln_property: [{ property_id: propertyId, reln_type_id: "owner" }],
      }
    }
  }, token);

  if (linkRes.status === 200) {
    const linked = linkRes.body?.result?.related?.contact_reln_property ?? [];
    console.log("Linked! Sarah's properties:", linked.map(p => p.system_search_key ?? p.property_id));
    console.log("\nDone — check Rex and you should see Sarah Singh linked to 20 Parrot as owner.");
  } else {
    console.error("Link failed:", JSON.stringify(linkRes.body?.error, null, 2));
  }
}

main().catch(console.error);
