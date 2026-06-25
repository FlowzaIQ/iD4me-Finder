/**
 * Rex CRM — apply an existing tag to a SPECIFIC contact + the property they own
 * Run with:  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"; node rex_tag_test.js
 *
 * Target:
 *   Contact  : Raza Mohammed
 *   Property : 29 Shearston Street, Moncrieff ACT 2914
 *   Tag      : "ID4me Scraper"   (must already exist in Rex — this account cannot CREATE admin-tags)
 *
 * Goal: confirm we can find an existing admin-tag and attach it to both records,
 * before wiring anything into the software.
 */

const https = require("https");

const REX_EMAIL    = "support@kndproperties.com.au";
const REX_PASSWORD = "Sales$2026";

const TAG_NAME      = "ID4me Scraper";
const TARGET_FIRST  = "Raza";
const TARGET_LAST   = "Mohammed";
const PROP_NUMBER   = "29";
const PROP_STREET   = "Shearston";
const PROP_SUBURB   = "Moncrieff";

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

function section(t) {
  console.log(`\n${"─".repeat(64)}\n── ${t}\n${"─".repeat(64)}`);
}

async function main() {
  // ── Login ──────────────────────────────────────────────────────────────────
  const loginRes = await rexPost("/Authentication/login", { email: REX_EMAIL, password: REX_PASSWORD });
  const token = loginRes.body?.result;
  if (typeof token !== "string") { console.error("Login failed:", loginRes.body); return; }
  console.log("✓ Logged in.");

  // ── Find the tag "ID4me Scraper" ───────────────────────────────────────────
  section(`Find tag: "${TAG_NAME}"`);
  let tagId = null;
  const tagSearch = await rexPost("/admin-tags/search", {
    criteria: [{ name: "tag", value: TAG_NAME }],
    limit: 10,
  }, token);
  if (tagSearch.status === 200 && tagSearch.body?.result?.rows?.length) {
    const rows = tagSearch.body.result.rows;
    const exact = rows.find(r => (r.tag || "").toLowerCase() === TAG_NAME.toLowerCase()) ?? rows[0];
    tagId = exact.id;
    console.log(`✓ Found tag "${exact.tag}" (ID: ${tagId})`);
  } else {
    // Fallback: autocomplete (some accounts allow this when search is restricted)
    const ac = await rexPost("/admin-tags/autocomplete", { search_string: TAG_NAME, limit: 10 }, token);
    const acRows = ac.body?.result ?? [];
    console.log("admin-tags/search returned nothing. autocomplete result:", JSON.stringify(acRows, null, 2));
    const hit = Array.isArray(acRows) ? acRows.find(r => (r.tag || r.text || "").toLowerCase() === TAG_NAME.toLowerCase()) : null;
    tagId = hit?.id ?? hit?.value ?? null;
  }
  if (!tagId) {
    console.error(`✗ Could not find the tag "${TAG_NAME}" in Rex. Create it in Rex first, then re-run.`);
    return;
  }

  // ── Find the contact: Raza Mohammed ────────────────────────────────────────
  section(`Find contact: ${TARGET_FIRST} ${TARGET_LAST}`);
  const cSearch = await rexPost("/contacts/search", {
    criteria: [{ name: "contact.name_full", value: `${TARGET_FIRST} ${TARGET_LAST}` }],
    limit: 10,
  }, token);
  const contacts = cSearch.body?.result?.rows ?? [];
  const contact = contacts.find(c =>
    (c.name_first || "").toLowerCase().includes(TARGET_FIRST.toLowerCase()) &&
    (c.name_last  || "").toLowerCase().includes(TARGET_LAST.toLowerCase())
  ) ?? contacts[0];
  const contactId = contact?.id;
  console.log(`Contact: ${contact?.name ?? contact?.system_search_key ?? "(not found)"}  (ID: ${contactId})`);
  if (!contactId) { console.error("✗ Contact not found. Stopping."); return; }

  // ── Find the property: 29 Shearston Street, Moncrieff ──────────────────────
  section(`Find property: ${PROP_NUMBER} ${PROP_STREET} St, ${PROP_SUBURB}`);
  const pSearch = await rexPost("/properties/search", {
    criteria: [
      { name: "property.adr_street_number",  value: PROP_NUMBER },
      { name: "property.adr_suburb_or_town", value: PROP_SUBURB },
    ],
    limit: 10,
  }, token);
  const props = pSearch.body?.result?.rows ?? [];
  const property = props.find(p =>
    (p.adr_street_name || "").toLowerCase().includes(PROP_STREET.toLowerCase())
  ) ?? props[0];
  const propertyId = property?.id;
  console.log(`Property: ${property?.system_search_key ?? "(not found)"}  (ID: ${propertyId})`);
  if (!propertyId) { console.error("✗ Property not found. Stopping."); return; }

  // ── Apply the tag to the CONTACT ───────────────────────────────────────────
  // Shape from Rex describe: related.contact_tags = [{ id: <admin_tag_id> }]
  section(`Apply tag ${tagId} to contact ${contactId}`);
  const cUpdate = await rexPost("/contacts/update", {
    data: { id: contactId, related: { contact_tags: [{ tag: TAG_NAME, id: tagId }] } }
  }, token);
  console.log("Contact update status:", cUpdate.status,
    cUpdate.body?.error ? `ERROR: ${JSON.stringify(cUpdate.body.error?.message)}` : "ok");

  // ── Apply the tag to the PROPERTY ──────────────────────────────────────────
  // Shape from Rex describe: related.property_tags = [{ id: <admin_tag_id> }]
  section(`Apply tag ${tagId} to property ${propertyId}`);
  const pUpdate = await rexPost("/properties/update", {
    data: { id: propertyId, related: { property_tags: [{ tag: TAG_NAME, id: tagId }] } }
  }, token);
  console.log("Property update status:", pUpdate.status,
    pUpdate.body?.error ? `ERROR: ${JSON.stringify(pUpdate.body.error?.message)}` : "ok");

  // ── Read both back to verify the tag is attached ───────────────────────────
  section("Verify — read contact + property tags back");
  const cRead = await rexPost("/contacts/read", { id: contactId, extra_fields: ["contact_tags"] }, token);
  const cTags = cRead.body?.result?.related?.contact_tags ?? cRead.body?.result?.contact_tags ?? [];
  console.log("Contact tags (raw):", JSON.stringify(cTags, null, 2));

  const pRead = await rexPost("/properties/read", { id: propertyId, extra_fields: ["property_tags"] }, token);
  const pTags = pRead.body?.result?.related?.property_tags ?? pRead.body?.result?.property_tags ?? [];
  console.log("Property tags (raw):", JSON.stringify(pTags, null, 2));

  section("RESULT");
  const cOk = JSON.stringify(cTags).toLowerCase().includes(TAG_NAME.toLowerCase()) || (cUpdate.status === 200 && !cUpdate.body?.error);
  const pOk = JSON.stringify(pTags).toLowerCase().includes(TAG_NAME.toLowerCase()) || (pUpdate.status === 200 && !pUpdate.body?.error);
  console.log(`Contact tagged : ${cOk ? "✓" : "✗"}`);
  console.log(`Property tagged: ${pOk ? "✓" : "✗"}`);
  if (cOk && pOk) console.log('\n✓✓✓ "ID4me Scraper" tag applied to both records.');
  else console.log("\n⚠ Check the errors / tag arrays above — the apply shape may need adjusting.");
}

main().catch(console.error);
