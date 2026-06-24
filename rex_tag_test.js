/**
 * Rex CRM — tag troubleshooting test
 * Run with: node rex_tag_test.js
 *
 * NOTE: The Rex account does not have admin privileges to CREATE system tags
 * via the API. You need to create the "Scraped" tag manually in Rex first:
 *   Rex CRM → Settings (gear icon) → Tags → New Tag → name it "Scraped" → Save
 * Then run this script to confirm search + apply works.
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
      res.on("data", chunk => (data += chunk));
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

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`── ${title}`);
  console.log("─".repeat(60));
}

async function main() {
  // ── Step 1: Login ─────────────────────────────────────────────────────────
  section("Step 1: Login");
  const loginRes = await rexPost("/Authentication/login", {
    email: REX_EMAIL, password: REX_PASSWORD,
  });
  if (loginRes.status !== 200 || typeof loginRes.body?.result !== "string") {
    console.error("Login failed:", JSON.stringify(loginRes.body, null, 2));
    return;
  }
  const token = loginRes.body.result;
  console.log("✓ Logged in.");

  // ── Step 2: Search for "Scraped" tag ──────────────────────────────────────
  section('Step 2: Search for "Scraped" tag via /admin-tags/search');
  const searchRes = await rexPost("/admin-tags/search", {
    criteria: [{ name: "tag", value: "Scraped" }],
    limit: 5,
  }, token);
  console.log("Status:", searchRes.status);
  console.log("Result:", JSON.stringify(searchRes.body?.result, null, 2));

  const tagId = searchRes.body?.result?.rows?.[0]?.id ?? null;

  if (!tagId) {
    console.log('\n⚠ "Scraped" tag not found in Rex.');
    console.log('→ Go to Rex CRM → Settings → Tags → create a tag named "Scraped" → then re-run this script.');
    return;
  }
  console.log(`✓ Found "Scraped" tag. ID: ${tagId}`);

  // ── Step 3: Find a real contact ───────────────────────────────────────────
  section("Step 3: Find a contact to test with");
  const contactSearch = await rexPost("/contacts/search", {
    limit: 1,
    criteria: [{ name: "contact.system_record_state", value: "active" }],
  }, token);
  const contact = contactSearch.body?.result?.rows?.[0];
  const contactId = contact?.id ?? null;
  console.log(`Using contact: ${contact?.system_search_key ?? "(unknown)"} (ID: ${contactId})`);

  if (!contactId) {
    console.error("No contact found. Stopping.");
    return;
  }

  // ── Step 4: Apply the tag ─────────────────────────────────────────────────
  section(`Step 4: Apply tag ${tagId} to contact ${contactId}`);
  const updateRes = await rexPost("/contacts/update", {
    data: {
      id: contactId,
      related: { admin_tags: [{ admin_tag_id: tagId }] },
    }
  }, token);
  console.log("Status:", updateRes.status);
  if (updateRes.body?.error) {
    console.error("Error:", JSON.stringify(updateRes.body.error, null, 2));
  } else {
    console.log("✓ Update call succeeded.");
  }

  // ── Step 5: Read contact back to confirm tag is there ─────────────────────
  section(`Step 5: Read contact ${contactId} back to verify`);
  const readRes = await rexPost("/contacts/read", {
    id: contactId,
    extra_fields: ["admin_tags"],
  }, token);
  console.log("Status:", readRes.status);
  const tags = readRes.body?.result?.admin_tags
    ?? readRes.body?.result?.related?.admin_tags
    ?? null;
  if (tags) {
    console.log("Tags on contact:", JSON.stringify(tags, null, 2));
  } else {
    console.log("No admin_tags field in response — full result keys:", Object.keys(readRes.body?.result ?? {}));
    console.log("Full response:", JSON.stringify(readRes.body?.result, null, 2));
  }
}

main().catch(console.error);
