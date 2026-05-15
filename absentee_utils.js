const normalizeLoose = (txt) => (txt || "").toLowerCase().replace(/\s+/g, " ").trim();
const MAX_RESULT_COUNT = 35;
const RESOLVED_STATUS = "POTENTIAL_ABSENTEE";
const HIGH_FREQ_THRESHOLD = 3; // mobiles appearing this many times or more qualify for multi-row output

const AU_STATES = ['QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

function extractState(addr) {
    if (!addr) return null;
    const upper = addr.toUpperCase();
    for (const state of AU_STATES) {
        if (new RegExp(`\\b${state}\\b`).test(upper)) return state;
    }
    return null; // No recognisable state abbreviation — treat as interstate
}

function generateNameVariations(fullName) {
    const tokens = (fullName || "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return tokens.length ? [tokens.join(" ")] : [];

    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    const middle = tokens.slice(1, -1);

    const variants = [];
    const full = tokens.join(" ").trim();
    if (full) variants.push(full);

    if (middle.length > 0) {
        for (let i = middle.length - 1; i >= 0; i--) {
            const trimmed = [first, ...middle.filter((_, idx) => idx !== i), last].join(" ").trim();
            if (trimmed.split(" ").length >= 2) variants.push(trimmed);
        }
    }

    const firstLast = `${first} ${last}`.trim();
    if (firstLast) variants.push(firstLast);

    return [...new Set(variants)];
}

// Picks the highest-scoring entry from a groupCounts map using frequency scoring.
function pickBest(groupCounts, mobileCounts, nameCounts) {
    let best = null;
    for (const entry of groupCounts.values()) {
        const mobileFreq = mobileCounts.get(entry.mobile) || 0;
        const nameFreq = nameCounts.get(entry.name) || 0;
        const score = entry.count;
        if (!best) {
            best = { ...entry, mobileFreq, nameFreq, score };
            continue;
        }
        if (score > best.score) {
            best = { ...entry, mobileFreq, nameFreq, score };
        } else if (score === best.score) {
            if (mobileFreq > best.mobileFreq) {
                best = { ...entry, mobileFreq, nameFreq, score };
            } else if (mobileFreq === best.mobileFreq && nameFreq > best.nameFreq) {
                best = { ...entry, mobileFreq, nameFreq, score };
            }
        }
    }
    return best;
}

// Returns the most frequently occurring address for a given mobile across the raw result rows.
function getMostCommonAddr(rows, targetMobile) {
    const addrCounts = new Map();
    for (const row of rows) {
        const mobile = (row && row.mobile ? `${row.mobile}` : "").replace(/\D/g, "");
        if (mobile !== targetMobile) continue;
        const addr = (row && row.addr ? row.addr : "").trim();
        if (!addr) continue;
        addrCounts.set(addr, (addrCounts.get(addr) || 0) + 1);
    }
    let bestAddr = "";
    let bestCount = 0;
    for (const [addr, count] of addrCounts.entries()) {
        if (count > bestCount) { bestCount = count; bestAddr = addr; }
    }
    return bestAddr;
}

// Returns the first non-empty value of a field among rows matching the given mobile.
function getFirstFieldForMobile(rows, targetMobile, field) {
    for (const row of rows) {
        const mobile = (row && row.mobile ? `${row.mobile}` : "").replace(/\D/g, "");
        if (mobile !== targetMobile) continue;
        const val = (row && row[field] ? `${row[field]}` : "").trim();
        if (val) return val;
    }
    return "";
}

function evaluateAbsenteeResolution(rows, options) {
    const maxResultCount = options.maxResultCount;
    const propertyState = options.propertyState || null;

    const total = Array.isArray(rows) ? rows.length : 0;

    if (total === 0) {
        return { resolved: false, reason: "no_results", total };
    }
    if (total >= maxResultCount) {
        return { resolved: false, reason: "too_many_results", total };
    }

    // Build candidate groups: unique (name+mobile) combinations with occurrence counts.
    const mobileCounts = new Map();
    const nameCounts = new Map();
    const groupCounts = new Map();

    for (const row of rows) {
        const name = normalizeLoose(row && row.name ? row.name : "");
        const mobile = (row && row.mobile ? `${row.mobile}` : "").replace(/\D/g, "");
        const addr = (row && row.addr ? row.addr : "").trim();
        if (!name || !mobile) continue;

        mobileCounts.set(mobile, (mobileCounts.get(mobile) || 0) + 1);
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);

        const key = `${name}|${mobile}`;
        const entry = groupCounts.get(key) || { count: 0, name, mobile, addr, landline: "", email: "", lastSeen: "" };
        entry.count += 1;
        // Keep the first non-empty value seen for each contact field
        if (!entry.landline && row && row.landline) entry.landline = `${row.landline}`.trim();
        if (!entry.email && row && row.email) entry.email = `${row.email}`.trim();
        if (!entry.lastSeen && row && row.lastSeen) entry.lastSeen = `${row.lastSeen}`.trim();
        groupCounts.set(key, entry);
    }

    if (groupCounts.size === 0) {
        return { resolved: false, reason: "no_mobile", total };
    }

    // HIGH-FREQUENCY RULE
    // Any mobile appearing >= HIGH_FREQ_THRESHOLD times is considered strongly confirmed.
    // State filtering is bypassed entirely for these candidates.
    // 1 qualifier → return it directly. 2+ qualifiers → return all as multipleRows.
    const highFreqMobiles = [...mobileCounts.entries()].filter(([, count]) => count >= HIGH_FREQ_THRESHOLD);
    if (highFreqMobiles.length === 1) {
        const [mobile] = highFreqMobiles[0];
        return {
            resolved: true, mobile, total,
            addr: getMostCommonAddr(rows, mobile),
            landline: getFirstFieldForMobile(rows, mobile, "landline"),
            email: getFirstFieldForMobile(rows, mobile, "email"),
            lastSeen: getFirstFieldForMobile(rows, mobile, "lastSeen"),
        };
    }
    if (highFreqMobiles.length >= 2) {
        const multipleRows = highFreqMobiles.map(([mobile]) => ({
            mobile,
            addr: getMostCommonAddr(rows, mobile),
            landline: getFirstFieldForMobile(rows, mobile, "landline"),
            email: getFirstFieldForMobile(rows, mobile, "email"),
            lastSeen: getFirstFieldForMobile(rows, mobile, "lastSeen"),
        }));
        return { resolved: true, multipleRows, total };
    }

    // Case: ≤5 total results — too few to be ambiguous, use best-pick regardless of state.
    if (total <= 5) {
        const best = pickBest(groupCounts, mobileCounts, nameCounts);
        return { resolved: true, mobile: best.mobile, name: best.name, addr: best.addr || "", landline: best.landline || "", email: best.email || "", lastSeen: best.lastSeen || "", total };
    }

    // Cases for 6–20 results: apply same-state prioritisation when property state is known.
    if (propertyState) {
        const sameStateCandidates = new Map();
        for (const [key, entry] of groupCounts.entries()) {
            if (extractState(entry.addr) === propertyState) {
                sameStateCandidates.set(key, entry);
            }
        }

        if (sameStateCandidates.size > 0) {
            // Same-state results exist — pick the best one, ignore interstate entirely.
            const best = pickBest(sameStateCandidates, mobileCounts, nameCounts);
            return { resolved: true, mobile: best.mobile, name: best.name, addr: best.addr || "", landline: best.landline || "", email: best.email || "", lastSeen: best.lastSeen || "", total };
        }

        // No same-state results found.
        const uniqueMobiles = new Set([...groupCounts.values()].map(e => e.mobile));
        if (uniqueMobiles.size >= 4) {
            // Too many different people with no geographic anchor — skip.
            return { resolved: false, reason: "no_same_state_match", total };
        }
        // ≤3 unique mobiles with no same-state match — narrow enough to use.
    }

    // Fallback: no property state provided, or no-same-state with ≤3 unique mobiles.
    const best = pickBest(groupCounts, mobileCounts, nameCounts);
    return { resolved: true, mobile: best.mobile, name: best.name, addr: best.addr || "", landline: best.landline || "", email: best.email || "", lastSeen: best.lastSeen || "", total };
}

module.exports = {
    generateNameVariations,
    evaluateAbsenteeResolution,
    MAX_RESULT_COUNT,
    RESOLVED_STATUS
};
