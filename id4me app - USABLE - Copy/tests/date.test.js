const assert = require("assert");
const { normalizeDateString } = require("../date_utils");

assert.strictEqual(normalizeDateString("09 Jun 2000"), "09 Jun 2000");
assert.strictEqual(normalizeDateString("9 Jun 2000"), "9 Jun 2000");
assert.strictEqual(normalizeDateString("2000-06-09"), "2000-06-09");
assert.strictEqual(normalizeDateString("2000/06/09"), "2000/06/09");
assert.strictEqual(normalizeDateString("09/06/2000"), "09/06/2000");
assert.strictEqual(normalizeDateString(""), "N/A");
assert.strictEqual(normalizeDateString(null), "N/A");

console.log("Date tests passed.");
