const assert = require("assert");
const {
  expandStreetSuffix,
  canonicalStreetType,
  splitStreetNameType,
  streetNamesMatch,
} = require("../address_utils");

// ─── splitStreetNameType ──────────────────────────────────────────────────────
assert.deepStrictEqual(splitStreetNameType("TAMINGA CIRCUIT"), { base: "TAMINGA", type: "CIRCUIT" });
assert.deepStrictEqual(splitStreetNameType("TAMINGA"),          { base: "TAMINGA", type: "" });
assert.deepStrictEqual(splitStreetNameType("TAMINGA CCT"),      { base: "TAMINGA", type: "CIRCUIT" });
// apostrophes / punctuation stripped, whitespace collapsed
assert.deepStrictEqual(splitStreetNameType("O'CONNELL  ST"),    { base: "OCONNELL", type: "STREET" });
// a lone type word stays as the base (2+ words required to peel a type)
assert.deepStrictEqual(splitStreetNameType("MEWS"),             { base: "MEWS", type: "" });
assert.deepStrictEqual(splitStreetNameType(""),                 { base: "", type: "" });

// ─── canonicalStreetType ──────────────────────────────────────────────────────
assert.strictEqual(canonicalStreetType("Cct"),     "CIRCUIT");
assert.strictEqual(canonicalStreetType("Dr"),      "DRIVE");
assert.strictEqual(canonicalStreetType("TAMINGA"), "");

// ─── streetNamesMatch (the core dedup rule) ───────────────────────────────────
// The reported bug: Rex holds "TAMINGA" (no type), import brings "TAMINGA CIRCUIT".
assert.strictEqual(streetNamesMatch("TAMINGA", "TAMINGA CIRCUIT"), true);
// Abbreviation variants collapse.
assert.strictEqual(streetNamesMatch("TAMINGA CCT", "TAMINGA CIRCUIT"), true);
assert.strictEqual(streetNamesMatch("TAMINGA Cct", "taminga circuit"), true);
// Genuinely different streets with the same base name stay separate.
assert.strictEqual(streetNamesMatch("TAMINGA DRIVE", "TAMINGA STREET"), false);
assert.strictEqual(streetNamesMatch("PARK STREET", "PARK ROAD"), false);
// Different base names never match.
assert.strictEqual(streetNamesMatch("PARK", "PARKLEA"), false);
// Multi-word street names.
assert.strictEqual(streetNamesMatch("GRAND VIEW", "GRAND VIEW WAY"), true);
assert.strictEqual(streetNamesMatch("GRAND VIEW WAY", "GRAND VIEW ROAD"), false);

// ─── expandStreetSuffix (unchanged behaviour after the move) ──────────────────
assert.strictEqual(expandStreetSuffix("4 TAMINGA CCT"), "4 TAMINGA CIRCUIT");
assert.strictEqual(expandStreetSuffix("10 KING ST"),    "10 KING STREET");
assert.strictEqual(expandStreetSuffix("4 TAMINGA"),     "4 TAMINGA"); // no type to expand
assert.strictEqual(expandStreetSuffix(""),              "");

console.log("address.test.js: all assertions passed");
