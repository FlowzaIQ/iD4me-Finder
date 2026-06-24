/**
 * Rex CRM — note attaches to a SPECIFIC contact and the property they own
 * Run with:  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"; node rex_note_test.js
 *
 * Target:
 *   Contact  : Raza Mohammed
 *   Property : 29 Shearston Street, Moncrieff ACT 2914
 *
 * Confirmed shape (from /notes/describe):
 *   _related.note_contacts[].contact_id      → links note to a contact
 *   _related.note_properties[].property_id   → links note to a property
 */

const https = require("https");

const REX_EMAIL    = "support@kndproperties.com.au";
const REX_PASSWORD = "Sales$2026";

// ── Target contact + property ─────────────────────────────────────────────────
const TARGET_FIRST  = "Raza";
const TARGET_LAST   = "Mohammed";
const PROP_NUMBER   = "29";
const PROP_STREET   = "Shearston";       // street name (no type) — Rex matches loosely
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
  if (!contactId) { console.error("✗ Contact 'Raza Mohammed' not found in Rex. Stopping."); return; }

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
  if (!propertyId) { console.error("✗ Property '29 Shearston Street, Moncrieff' not found in Rex. Stopping."); return; }

  // ── Safety check: confirm Raza actually owns this property ──────────────────
  section("Verify the contact is linked to this property");
  const propRead = await rexPost("/properties/read", { id: propertyId }, token);
  const relns = propRead.body?.result?.related?.contact_reln_property ?? [];
  const ownerLink = relns.find(r => String(r.contact_id ?? r.contact?.id) === String(contactId));
  if (ownerLink) {
    console.log(`✓ Confirmed — ${contact?.name ?? "contact"} is linked to this property as "${ownerLink.reln_type_id}".`);
  } else {
    console.log("⚠ This contact is NOT currently linked to this property in Rex.");
    console.log("  (Proceeding anyway so you can see the note attach to both records.)");
  }

  // ── Create the note attached to BOTH ───────────────────────────────────────
  section("Create note attached to the contact + the property");
  const createRes = await rexPost("/notes/create", {
    data: {
      note: "Scraped via ID4Me",
      _related: {
        note_contacts:   [{ contact_id: contactId }],
        note_properties: [{ property_id: propertyId }],
      },
      update_last_contacted: false,
    },
    return_id: true,
  }, token);

  if (createRes.status !== 200 || createRes.body?.error || !createRes.body?.result) {
    console.log("✗ Failed:", JSON.stringify(createRes.body?.error ?? createRes.body, null, 2));
    return;
  }
  const noteId = createRes.body.result?.id ?? createRes.body.result;
  console.log(`✓ Note created. ID: ${noteId}`);

  // ── Read it back to confirm BOTH links are present ─────────────────────────
  section("Read note back — verify both links");
  const readRes = await rexPost("/notes/read", { id: noteId }, token);
  const rel = readRes.body?.result?.related ?? {};
  const linkedContacts   = (rel.note_contacts   ?? []).map(n => n.contact?.name ?? n.contact?.id ?? n.id);
  const linkedProperties = (rel.note_properties ?? []).map(n => n.property?.system_search_key ?? n.property?.id ?? n.id);

  console.log("Note text         :", readRes.body?.result?.note);
  console.log("Linked contacts   :", JSON.stringify(linkedContacts));
  console.log("Linked properties :", JSON.stringify(linkedProperties));

  section("RESULT");
  if (linkedContacts.length && linkedProperties.length) {
    console.log("✓✓✓ Note attached to BOTH Raza Mohammed and 29 Shearston Street. Ready for the software.");
  } else {
    console.log("⚠ One of the links is missing — check the output above.");
  }
}

main().catch(console.error);
