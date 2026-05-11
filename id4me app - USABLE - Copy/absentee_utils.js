const normalizeLoose = (txt) => (txt || "").toLowerCase().replace(/\s+/g, " ").trim();
const MAX_RESULT_COUNT = 50;
const RESOLVED_STATUS = "POTENTIAL_ABSENTEE";

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

function evaluateAbsenteeResolution(rows, options) {
    const maxResultCount = options.maxResultCount;

    const total = Array.isArray(rows) ? rows.length : 0;
    if (total === 0) {
        return { resolved: false, reason: "no_results", total };
    }
    if (total >= maxResultCount) {
        return { resolved: false, reason: "too_many_results", total };
    }

    const mobileCounts = new Map();
    const nameCounts = new Map();
    const groupCounts = new Map();

    for (const row of rows) {
        const name = normalizeLoose(row && row.name ? row.name : "");
        const mobile = (row && row.mobile ? `${row.mobile}` : "").replace(/\D/g, "");
        if (!name || !mobile) continue;

        mobileCounts.set(mobile, (mobileCounts.get(mobile) || 0) + 1);
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);

        const key = `${name}|${mobile}`;
        const entry = groupCounts.get(key) || { count: 0, name, mobile };
        entry.count += 1;
        groupCounts.set(key, entry);
    }

    if (groupCounts.size === 0) {
        return { resolved: false, reason: "no_mobile", total };
    }

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

    return { resolved: true, mobile: best.mobile, name: best.name, total };
}

module.exports = {
    generateNameVariations,
    evaluateAbsenteeResolution,
    MAX_RESULT_COUNT,
    RESOLVED_STATUS
};
