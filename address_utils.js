// Shared address-normalization helpers used by both the CSV parsers (main.js) and the
// Rex CRM property matcher (rex_integration.js). Single source of truth for street types.

const STREET_SUFFIX_MAP = {
  "AV":        "AVENUE",
  "AVE":       "AVENUE",
  "BLVD":      "BOULEVARD",
  "BVD":       "BOULEVARD",
  "CCT":       "CIRCUIT",
  "CRCT":      "CIRCUIT",
  "CIRCUIT":   "CIRCUIT",
  "CIR":       "CIRCLE",
  "CL":        "CLOSE",
  "CLOSE":     "CLOSE",
  "CRES":      "CRESCENT",
  "CRESCENT":  "CRESCENT",
  "CRT":       "COURT",
  "CT":        "COURT",
  "COURT":     "COURT",
  "DR":        "DRIVE",
  "DVE":       "DRIVE",
  "DRIVE":     "DRIVE",
  "GR":        "GROVE",
  "GROVE":     "GROVE",
  "HWY":       "HIGHWAY",
  "HIGHWAY":   "HIGHWAY",
  "LANE":      "LANE",
  "LINK":      "LINK",
  "LOOP":      "LOOP",
  "MEWS":      "MEWS",
  "PDE":       "PARADE",
  "PARADE":    "PARADE",
  "PKWY":      "PARKWAY",
  "PARKWAY":   "PARKWAY",
  "PL":        "PLACE",
  "PLACE":     "PLACE",
  "RD":        "ROAD",
  "ROAD":      "ROAD",
  "RISE":      "RISE",
  "CHASE":     "CHASE",
  "SQ":        "SQUARE",
  "SQUARE":    "SQUARE",
  "ST":        "STREET",
  "STREET":    "STREET",
  "TCE":       "TERRACE",
  "TERRACE":   "TERRACE",
  "WALK":      "WALK",
  "WAY":       "WAY",
};

// Expand only the last word of an address (the street type). Leaves the rest untouched.
// e.g. "4 TAMINGA CCT" -> "4 TAMINGA CIRCUIT". Cannot add a type that isn't present.
function expandStreetSuffix(address) {
  if (!address) return address;
  return address.replace(/\b(\w+)$/, match => {
    const upper = match.toUpperCase();
    return STREET_SUFFIX_MAP[upper] || match;
  });
}

// Canonical full form of a single street-type token, or "" if it isn't a known type.
// e.g. "Cct" -> "CIRCUIT", "Dr" -> "DRIVE", "TAMINGA" -> "".
function canonicalStreetType(token) {
  if (!token) return "";
  return STREET_SUFFIX_MAP[String(token).toUpperCase()] || "";
}

// Split a full street name into its base name and canonical street type.
// Strips punctuation (e.g. apostrophes), uppercases, collapses whitespace, and only peels
// a trailing known type when 2+ words remain (so a lone "MEWS" stays as the base).
// "4 TAMINGA CIRCUIT" -> { base: "TAMINGA", type: "CIRCUIT" }
// "TAMINGA"           -> { base: "TAMINGA", type: "" }
function splitStreetNameType(fullName) {
  const clean = String(fullName || "")
    .toUpperCase()
    .replace(/[^\w\s]/g, "")      // drop apostrophes / punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return { base: "", type: "" };

  const parts = clean.split(" ");
  const canon = canonicalStreetType(parts[parts.length - 1]);
  if (canon && parts.length > 1) {
    return { base: parts.slice(0, -1).join(" "), type: canon };
  }
  return { base: clean, type: "" };
}

// Type-optional street match. Two full street names refer to the same street when their
// base names are equal AND (either side lacks a type, or both canonical types agree).
// "TAMINGA" vs "TAMINGA CIRCUIT"     -> true  (one side has no type)
// "TAMINGA CCT" vs "TAMINGA CIRCUIT" -> true  (abbreviation)
// "PARK STREET" vs "PARK ROAD"       -> false (both typed, types differ)
function streetNamesMatch(a, b) {
  const A = splitStreetNameType(a);
  const B = splitStreetNameType(b);
  if (!A.base || A.base !== B.base) return false;
  if (A.type && B.type) return A.type === B.type;
  return true;
}

module.exports = {
  STREET_SUFFIX_MAP,
  expandStreetSuffix,
  canonicalStreetType,
  splitStreetNameType,
  streetNamesMatch,
};
