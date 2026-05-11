const assert = require("assert");
const {
  generateNameVariations,
  evaluateAbsenteeResolution,
  MAX_RESULT_COUNT,
  RESOLVED_STATUS
} = require("../absentee_utils");

function row(addr) {
  return { addr };
}

function rowFull(name, mobile, addr) {
  return { name, mobile, addr };
}

// Exact match → resolved (single mobile)
{
  const rows = [rowFull("John Smith", "0412 111 111", "10 King St")];
  const result = evaluateAbsenteeResolution(rows, {
    maxResultCount: MAX_RESULT_COUNT
  });
  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.mobile, "0412111111");
}

// Variation match → resolved (name variations)
{
  const variations = generateNameVariations("Kristin Craig Daisy Whitham");
  assert.ok(variations.includes("Kristin Craig Whitham"));
  assert.ok(variations.includes("Kristin Daisy Whitham"));
  assert.ok(variations.includes("Kristin Whitham"));
}

// Mobile prioritization: most frequent (name, mobile)
{
  const rows = [
    rowFull("John Smith", "0412 111 111", "A St"),
    rowFull("John Smith", "0412 111 111", "B St"),
    rowFull("John Smith", "0412 111 111", "C St"),
    rowFull("John Smith", "0412 222 222", "D St"),
    rowFull("John Smith", "0412 222 222", "E St")
  ];
  const result = evaluateAbsenteeResolution(rows, {
    maxResultCount: MAX_RESULT_COUNT
  });
  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.mobile, "0412111111");
}

// ≥50 results → skipped
{
  const rows = Array.from({ length: 50 }, () => rowFull("John Smith", "0412 111 111", "10 King St"));
  const result = evaluateAbsenteeResolution(rows, {
    maxResultCount: 50
  });
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.reason, "too_many_results");
}

// CSV status update correctness (constant)
{
  assert.strictEqual(RESOLVED_STATUS, "POTENTIAL_ABSENTEE");
}

console.log("Absentee tests passed.");
