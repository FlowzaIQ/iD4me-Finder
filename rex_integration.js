/**
 * Rex CRM Integration Module
 * Handles real-time pushing of ID4Me scraper results into Rex CRM.
 * No external dependencies — uses Node.js built-in https only.
 */

const https = require("https");

// ─── Banned keywords — if a found name contains any of these, skip it entirely
// Add any name or partial string (case-insensitive) to block from Rex
const BANNED_KEYWORDS = [
    "JINTAI 1",
];

function isBannedName(name) {
    if (!name) return false;
    const upper = name.toUpperCase();
    return BANNED_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()));
}

// ─── Internal state (reset each scrape run via initRexSession) ────────────────
let _propertyCache  = new Map();  // "number|name|suburb" → Rex property ID
let _pendingSync    = new Map();  // address string → { propertyId, newFirstNames: Set }
let _rowBuffer      = [];         // rows collected during scrape, pushed to Rex after run ends

// ─── HTTP helper ──────────────────────────────────────────────────────────────
const REX_TIMEOUT_MS = 30000; // 30 seconds — gives Rex plenty of time to respond

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
            timeout:  REX_TIMEOUT_MS,
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on("timeout", () => {
            req.destroy(new Error(`Rex API timeout on ${path}`));
        });
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
    });
}

// ─── Normalise mobile to digits only ─────────────────────────────────────────
function normaliseMobile(mobile) {
    if (!mobile || mobile === "N/A") return null;
    const digits = mobile.replace(/\D/g, "");
    // Australian mobiles: ensure leading 0 (strip country code 61 if present)
    if (digits.startsWith("61") && digits.length === 11) return "0" + digits.slice(2);
    return digits;
}

// ─── Parse address string into components ────────────────────────────────────
// Input: "20 PARROT STREET", "4 WINDMILL PLACE", "1/18 WILLIAM STREET", "Unit 2 5 SOME RD"
function parseAddressComponents(addressStr) {
    const parts = (addressStr || "").trim().split(/\s+/);
    const numIdx = parts.findIndex(p => /^\d/.test(p));
    if (numIdx === -1) return { unit: "", number: "", name: addressStr, type: "" };

    let unit   = "";
    let number = parts[numIdx];

    // Handle "1/18" unit/street format → unit=1, number=18
    if (/^\d+\/\d+$/.test(number)) {
        const slash = number.indexOf("/");
        unit   = number.slice(0, slash);
        number = number.slice(slash + 1);
    }

    const rest = parts.slice(numIdx + 1);
    const type = rest.length > 1 ? rest[rest.length - 1] : "";
    const name = rest.length > 1 ? rest.slice(0, -1).join(" ") : rest.join(" ");
    return { unit, number, name, type };
}

// ─── Format contact address as plain string ───────────────────────────────────
function formatAddressString(originalAddress, suburb, state, postcode) {
    const parts = [originalAddress, suburb, state, postcode].filter(Boolean);
    return parts.join(", ");
}

// ─── Collapse multi-line absentee address to single line ─────────────────────
function formatAbsenteeAddress(raw) {
    if (!raw || raw === "N/A") return null;
    return raw.replace(/\r?\n/g, ", ").replace(/,\s*,/g, ",").trim();
}

// ─── Find or create property in Rex ──────────────────────────────────────────
async function findOrCreateProperty(originalAddress, suburb, state, postcode, token) {
    const { unit, number, name, type } = parseAddressComponents(originalAddress);
    const fullStreetName = [name, type].filter(Boolean).join(" ");
    const cacheKey = `${unit}|${number}|${fullStreetName}|${(suburb || "").toUpperCase()}`;

    if (_propertyCache.has(cacheKey)) return _propertyCache.get(cacheKey);

    if (!number) {
        console.warn(`Rex: skipping property — no street number in "${originalAddress}"`);
        return null;
    }

    // Search Rex: suburb + street number (+ unit if present)
    const searchCriteria = [
        { name: "property.adr_suburb_or_town", value: suburb || "" },
        { name: "property.adr_street_number",  value: number },
    ];
    if (unit) searchCriteria.push({ name: "property.adr_unit_number", value: unit });

    const searchRes = await rexPost("/properties/search", { criteria: searchCriteria, limit: 20 }, token);

    if (searchRes.status === 200 && searchRes.body?.result?.rows?.length > 0) {
        const rows = searchRes.body.result.rows;

        if (unit) {
            // Unit address — must match BOTH street name AND unit number exactly
            // Never fall back to a different unit — each unit is a separate property
            const match = rows.find(r => {
                const rFull = [(r.adr_street_name || ""), (r.adr_street_type || "")].filter(Boolean).join(" ").toLowerCase();
                return rFull === fullStreetName.toLowerCase() && String(r.adr_unit_number || "") === String(unit);
            });
            if (match) {
                _propertyCache.set(cacheKey, match.id);
                return match.id;
            }
            // No exact unit match found — fall through to create a new property
        } else {
            // Standard address — must match street name+type exactly; never fall back to a different street
            const match = rows.find(r => {
                const rFull = [(r.adr_street_name || ""), (r.adr_street_type || "")].filter(Boolean).join(" ").toLowerCase();
                return rFull === fullStreetName.toLowerCase();
            });
            if (match) {
                _propertyCache.set(cacheKey, match.id);
                return match.id;
            }
        }
    }

    // Create new property
    const createData = {
        property_category_id: "residential",
        adr_unit_number:      unit           || undefined,
        adr_street_number:    number,
        adr_street_name:      fullStreetName || undefined,
        adr_suburb_or_town:   suburb         || undefined,
        adr_state_or_region:  state          || undefined,
        adr_postcode:         postcode       || undefined,
        adr_country:          "AU",
    };
    Object.keys(createData).forEach(k => createData[k] === undefined && delete createData[k]);

    const createRes = await rexPost("/properties/create", { data: createData }, token);

    if (createRes.status !== 200 || !createRes.body?.result) {
        throw new Error(`Property create failed: ${createRes.body?.error?.message}`);
    }

    const propertyId = createRes.body.result?.id ?? createRes.body.result;
    _propertyCache.set(cacheKey, propertyId);
    return propertyId;
}

// ─── Find contact by mobile ───────────────────────────────────────────────────
async function findContactByMobile(mobile, token) {
    const normalised = normaliseMobile(mobile);
    if (!normalised) return null;

    const res = await rexPost("/contacts/search", {
        criteria: [{ name: "contact.phone_number", value: normalised }],
        limit: 5,
    }, token);

    if (res.status === 200 && res.body?.result?.rows?.length > 0) {
        return res.body.result.rows[0];
    }
    // Try with spaces (AU format "0471 832 934")
    const spaced = normalised.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
    const res2 = await rexPost("/contacts/search", {
        criteria: [{ name: "contact.phone_number", value: spaced }],
        limit: 5,
    }, token);

    if (res2.status === 200 && res2.body?.result?.rows?.length > 0) {
        return res2.body.result.rows[0];
    }
    return null;
}

// ─── Find contact by email ────────────────────────────────────────────────────
async function findContactByEmail(email, token) {
    if (!email || email === "N/A") return null;

    const res = await rexPost("/contacts/search", {
        criteria: [{ name: "contact.email_address", value: email.toLowerCase() }],
        limit: 5,
    }, token);

    if (res.status === 200 && res.body?.result?.rows?.length > 0) {
        return res.body.result.rows[0];
    }
    return null;
}

// ─── Convert "JOHN SMITH" → "John Smith" ─────────────────────────────────────
function toTitleCase(str) {
    return (str || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Find contact by full name (with fuzzy fallback) ─────────────────────────
async function findContactByName(firstName, lastName, token) {
    if (!firstName) return null;

    // "J" matches "John"; "John" matches "John A" etc.
    function firstNamesMatch(a, b) {
        const an = (a || "").trim().toLowerCase();
        const bn = (b || "").trim().toLowerCase();
        if (!an || !bn) return false;
        if (an === bn) return true;
        if (an.length === 1 && bn.startsWith(an)) return true;
        if (bn.length === 1 && an.startsWith(bn)) return true;
        return false;
    }

    // "Smith" matches "A Smith", "Smith Jones" matches "Smith" (last word fallback)
    function lastNamesMatch(a, b) {
        const an = (a || "").trim().toLowerCase();
        const bn = (b || "").trim().toLowerCase();
        if (!an || !bn) return true; // missing last name — don't disqualify
        if (an === bn) return true;
        if (an.includes(bn) || bn.includes(an)) return true;
        return an.split(/\s+/).pop() === bn.split(/\s+/).pop();
    }

    // Normalise to title case so Rex's search matches regardless of scraper casing
    const searchFirst = toTitleCase(firstName);
    const searchLast  = toTitleCase(lastName);

    // Attempt 1: search by full name
    const fullName = [searchFirst, searchLast].filter(Boolean).join(" ").trim();
    const res1 = await rexPost("/contacts/search", {
        criteria: [{ name: "contact.name_full", value: fullName }],
        limit: 10,
    }, token);

    if (res1.status === 200 && res1.body?.result?.rows?.length > 0) {
        const match = res1.body.result.rows.find(r =>
            firstNamesMatch(r.name_first, firstName) && lastNamesMatch(r.name_last, lastName)
        );
        if (match) return match;
    }

    // Attempt 2: search by last name only, filter client-side by first name
    if (searchLast) {
        const res2 = await rexPost("/contacts/search", {
            criteria: [{ name: "contact.name_last", value: searchLast }],
            limit: 10,
        }, token);

        if (res2.status === 200 && res2.body?.result?.rows?.length > 0) {
            const match = res2.body.result.rows.find(r =>
                firstNamesMatch(r.name_first, firstName) && lastNamesMatch(r.name_last, lastName)
            );
            if (match) return match;
        }
    }

    return null;
}

// ─── Add new phone/email to existing contact (skips if already present) ───────
async function mergeContactDetails(contactId, mobile, landline, email, token) {
    const digitsOnly = str => (str || "").replace(/\D/g, "");

    const readRes = await rexPost("/contacts/read", { id: contactId }, token);
    if (readRes.status !== 200) return;

    const contact        = readRes.body.result;
    const existingPhones = (contact.related?.contact_phones || []).map(p => digitsOnly(p.phone_number));
    const existingEmails = (contact.related?.contact_emails || []).map(e => (e.email_address || "").toLowerCase());

    const newPhones = [];
    const newEmails = [];

    if (mobile   && !existingPhones.includes(digitsOnly(mobile)))    newPhones.push({ phone_number: mobile });
    if (landline && !existingPhones.includes(digitsOnly(landline)))   newPhones.push({ phone_number: landline });
    if (email    && !existingEmails.includes(email.toLowerCase()))    newEmails.push({ email_address: email });

    if (newPhones.length === 0 && newEmails.length === 0) return;

    const related = {};
    if (newPhones.length) related.contact_phones = newPhones;
    if (newEmails.length) related.contact_emails = newEmails;

    await rexPost("/contacts/update", { data: { id: contactId, related } }, token);
}

// ─── Link contact to property as owner ───────────────────────────────────────
// Reads from the property side so relationship IDs are always present.
async function linkContactToProperty(contactId, propertyId, token) {
    const propRes = await rexPost("/properties/read", { id: propertyId }, token);
    let existingReln = null;
    if (propRes.status === 200) {
        const relns = propRes.body?.result?.related?.contact_reln_property ?? [];
        existingReln = relns.find(r => {
            const cId = r.contact_id ?? r.contact?.id;
            return String(cId) === String(contactId);
        });
    }

    if (existingReln) {
        if (existingReln.reln_type_id !== "owner") {
            // Promote past_owner (or any other status) back to owner
            await rexPost("/contacts/update", {
                data: {
                    id: contactId,
                    related: {
                        contact_reln_property: [{ id: existingReln.id, reln_type_id: "owner" }],
                    }
                }
            }, token);
        }
        return;
    }

    // No existing link — create it
    await rexPost("/contacts/update", {
        data: {
            id: contactId,
            related: {
                contact_reln_property: [{ property_id: propertyId, reln_type_id: "owner" }],
            }
        }
    }, token);
}

// ─── Create a new contact ─────────────────────────────────────────────────────
async function createContact(firstName, lastName, mobile, landline, email, addressStr, postalStr, token) {
    const relatedPhones = [];
    if (mobile)   relatedPhones.push({ phone_number: mobile });
    if (landline) relatedPhones.push({ phone_number: landline });
    const relatedEmails = email  ? [{ email_address: email }]  : [];

    const createRes = await rexPost("/contacts/create", {
        data: {
            type: "person",
            related: {
                contact_names:  [{ name_first: firstName, name_last: lastName }],
                contact_phones: relatedPhones,
                contact_emails: relatedEmails,
            }
        }
    }, token);

    if (createRes.status !== 200 || !createRes.body?.result) {
        throw new Error(`Contact create failed: ${createRes.body?.error?.message}`);
    }

    const contactId = createRes.body.result?.id ?? createRes.body.result;

    // Set address fields (plain strings)
    const updateData = { id: contactId };
    if (addressStr) updateData.address = addressStr;
    if (postalStr)  updateData.address_postal = postalStr;

    if (addressStr || postalStr) {
        await rexPost("/contacts/update", { data: updateData }, token);
    }

    return contactId;
}

// ─── Enrich an existing contact (add address if missing, link property) ───────
async function enrichContact(contactId, existingContact, addressStr, postalStr, token) {
    const updateData = { id: contactId };
    const currentAddr = existingContact.address;

    // Update address if blank or suburb-only (no street number present)
    const addrIsBlank = !currentAddr || currentAddr === "Array";
    const addrIsPartial = currentAddr && !/\d/.test(currentAddr); // no digit = no street number
    if ((addrIsBlank || addrIsPartial) && addressStr) {
        updateData.address = addressStr;
    }

    if (postalStr && !existingContact.address_postal) {
        updateData.address_postal = postalStr;
    }

    if (Object.keys(updateData).length > 1) {
        await rexPost("/contacts/update", { data: updateData }, token);
    }
}

// ─── Fetch existing owners from Rex by reading the property directly ──────────
// Returns array of { contactId, relnId, firstName }
async function fetchExistingOwners(propertyId, token) {
    const res = await rexPost("/properties/read", { id: propertyId }, token);
    if (res.status !== 200) return [];

    const relns = res.body?.result?.related?.contact_reln_property ?? [];
    const ownerRelns = relns.filter(r => r.reln_type_id === "owner");

    const result = [];
    for (const reln of ownerRelns) {
        const contactId = reln.contact_id ?? reln.contact?.id;
        if (!contactId) continue;

        // Get the contact's first name (may be in stub or needs a read)
        let firstName = reln.contact?.name_first || "";
        if (!firstName) {
            const cRes = await rexPost("/contacts/read", { id: contactId }, token);
            if (cRes.status === 200) firstName = cRes.body?.result?.name_first || "";
        }

        result.push({ contactId, relnId: reln.id, firstName });
    }
    return result;
}

// ─── Ownership sync — demotes old owners whose first name isn't in new set ────
async function syncOwnership(propertyId, newFirstNames, prevOwners, token) {
    if (!newFirstNames || newFirstNames.size === 0 || !prevOwners?.length) return;

    const newNames = new Set([...newFirstNames].map(n => n.toLowerCase()));

    for (const owner of prevOwners) {
        if (newNames.has((owner.firstName || "").toLowerCase())) continue; // still an owner

        // Demote this contact to past_owner using the stored reln id
        await rexPost("/contacts/update", {
            data: {
                id: owner.contactId,
                related: {
                    contact_reln_property: [{ id: owner.relnId, reln_type_id: "past_owner" }],
                }
            }
        }, token);
    }
}

// ─── Public: Initialise Rex session ──────────────────────────────────────────
async function initRexSession(email, password) {
    _propertyCache.clear();
    _pendingSync.clear();
    _rowBuffer = [];

    const loginRes = await rexPost("/Authentication/login", { email, password });
    if (loginRes.status !== 200 || typeof loginRes.body?.result !== "string") {
        console.error("Rex login failed:", loginRes.body?.error?.message ?? loginRes.body);
        return null;
    }
    return loginRes.body.result; // token
}

// ─── Internal: actual push logic (runs inside queue, never called directly) ───
async function _pushToRexNow(rowData, token, onLog = null) {
  const log = (msg, type = 'info') => { if (onLog) onLog(msg, type); else console.log(`Rex: ${msg}`); };
  try {
    const { matchStatus, foundName, foundMobile, foundLandline, foundEmail, originalAddress, suburb, state, postcode, absenteeAddr } = rowData;

    // Skip companies, trusts, and other non-person entities
    if (isBannedName(foundName)) {
        log(`Skipping banned name "${foundName}"`, 'warning');
        return;
    }

    const nameParts  = (foundName || "").trim().split(/\s+/);
    const firstName  = nameParts[0]  || "";
    const lastName   = nameParts.slice(1).join(" ") || "";
    const mobile     = normaliseMobile(foundMobile);
    const landline   = (!foundLandline || foundLandline === "N/A") ? "" : foundLandline.replace(/\s/g, "");
    const email      = (!foundEmail   || foundEmail === "N/A")   ? "" : foundEmail;

    const addressStr = formatAddressString(originalAddress, suburb, state, postcode);
    const postalStr  = matchStatus === "POTENTIAL_ABSENTEE" ? formatAbsenteeAddress(absenteeAddr) : null;

    log(`Processing: ${foundName} | mobile: ${mobile || "none"} | email: ${email || "none"}`);

    // 1. Find or create the investment property
    const propertyId = await findOrCreateProperty(originalAddress, suburb, state, postcode, token);
    if (!propertyId) {
        log(`No street number in "${originalAddress}" — skipped`, 'warning');
        return;
    }
    log(`Property ID: ${propertyId} for "${originalAddress}"`);

    // 2. Find or create contact
    // Priority: mobile → email → name → create
    let contactId;
    const byMobile = mobile ? await findContactByMobile(mobile, token) : null;

    if (byMobile) {
        contactId = byMobile.id;
        log(`Found by mobile (${mobile}) → contact ${contactId}`, 'success');
        await mergeContactDetails(contactId, null, landline, email, token);
        await enrichContact(contactId, byMobile, addressStr, postalStr, token);
    } else {
        log(`Mobile not found (${mobile || "none"}) — trying email`);
        const byEmail = email ? await findContactByEmail(email, token) : null;
        if (byEmail) {
            contactId = byEmail.id;
            log(`Found by email (${email}) → contact ${contactId}`, 'success');
            await mergeContactDetails(contactId, mobile, landline, null, token);
            await enrichContact(contactId, byEmail, addressStr, postalStr, token);
        } else {
            log(`Email not found (${email || "none"}) — trying name`);
            const byName = await findContactByName(firstName, lastName, token);
            if (byName) {
                contactId = byName.id;
                log(`Found by name (${firstName} ${lastName}) → contact ${contactId}`, 'success');
                await mergeContactDetails(contactId, mobile, landline, email, token);
                await enrichContact(contactId, byName, addressStr, postalStr, token);
            } else {
                log(`No match found — creating new contact for ${firstName} ${lastName}`, 'warning');
                contactId = await createContact(firstName, lastName, mobile, landline, email, addressStr, postalStr, token);
                log(`Created contact ${contactId}`, 'success');
            }
        }
    }

    // 3. Link contact → property as owner
    await linkContactToProperty(contactId, propertyId, token);
    log(`Linked contact ${contactId} → property ${propertyId} as owner`);

    // 4. Track for ownership sync (keyed by original address string)
    if (!_pendingSync.has(originalAddress)) {
        const prevOwners = await fetchExistingOwners(propertyId, token);
        log(`Snapshotted ${prevOwners.length} existing owner(s) for "${originalAddress}"`);
        _pendingSync.set(originalAddress, { propertyId, newFirstNames: new Set(), prevOwners });
    }
    _pendingSync.get(originalAddress).newFirstNames.add(firstName);

  } catch (err) {
    log(`Push failed for "${rowData?.foundName}": ${err.message}`, 'danger');
    console.error(`Rex push failed for "${rowData?.foundName}":`, err.message);
  }
}

// ─── Public: Queue a row — returns instantly, zero scraper impact ─────────────
function pushToRex(rowData) {
    _rowBuffer.push(rowData);
}

// ─── Public: Run ownership sync for a completed address group ────────────────
async function syncAddress(addressKey, token) {
    const pending = _pendingSync.get(addressKey);
    if (!pending) return;
    await syncOwnership(pending.propertyId, pending.newFirstNames, token);
    _pendingSync.delete(addressKey);
}

// ─── Public: Called after scrape ends — processes all buffered rows then syncs ─
// onProgress(done, total) called after each row; onLog(msg, type) for dashboard logging
async function flushPendingSync(token, onProgress = null, onLog = null) {
    const total = _rowBuffer.length;
    if (total === 0 && _pendingSync.size === 0) return;

    for (let i = 0; i < _rowBuffer.length; i++) {
        try {
            await _pushToRexNow(_rowBuffer[i], token, onLog);
        } catch (e) {
            console.error(`Rex post-run push failed for "${_rowBuffer[i]?.foundName}":`, e.message);
        }
        if (onProgress) onProgress(i + 1, total);
        await new Promise(r => setTimeout(r, 300));
    }
    _rowBuffer = [];

    // Ownership sync — demote past owners for changed properties
    for (const [addressKey, pending] of _pendingSync.entries()) {
        try {
            await syncOwnership(pending.propertyId, pending.newFirstNames, pending.prevOwners, token);
        } catch (e) {
            console.error(`Rex ownership sync failed for ${addressKey}:`, e.message);
        }
    }
    _pendingSync.clear();
}

function hasPendingData() {
    return _rowBuffer.length; // returns count (0 = falsy = nothing pending)
}

module.exports = { initRexSession, pushToRex, syncAddress, flushPendingSync, hasPendingData };
