const assert = require("assert");
const { isNetworkFailure } = require("../network_utils");

assert.strictEqual(isNetworkFailure("net::ERR_INTERNET_DISCONNECTED"), true);
assert.strictEqual(isNetworkFailure("net::ERR_NETWORK_CHANGED"), true);
assert.strictEqual(isNetworkFailure("net::ERR_NAME_NOT_RESOLVED"), true);
assert.strictEqual(isNetworkFailure("net::ERR_CONNECTION_TIMED_OUT"), true);
assert.strictEqual(isNetworkFailure("net::ERR_CONNECTION_RESET"), true);
assert.strictEqual(isNetworkFailure("net::ERR_CONNECTION_CLOSED"), true);
assert.strictEqual(isNetworkFailure("net::ERR_ADDRESS_UNREACHABLE"), true);
assert.strictEqual(isNetworkFailure("Error: ERR_NETWORK_ACCESS_DENIED"), true);
assert.strictEqual(isNetworkFailure("Timeout exceeded while waiting for selector"), false);
assert.strictEqual(isNetworkFailure("Rate limit hit scanning"), false);
assert.strictEqual(isNetworkFailure(""), false);

console.log("Network tests passed.");
