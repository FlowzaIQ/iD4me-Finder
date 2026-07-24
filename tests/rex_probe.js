// READ-ONLY Rex probe — proves the dedup fix against live Rex data without writing anything.
// It logs in, searches suburb + street number (exactly like findOrCreateProperty does),
// and reports which existing property the NEW matcher would link to. Creates nothing.
//
// Usage (PowerShell):
//   $env:REX_EMAIL="you@agency.com"; $env:REX_PASSWORD="..."; node tests/rex_probe.js "4 TAMINGA CIRCUIT" "D'AGUILAR"
//
// Args: <full street address incl. type>  <suburb>

const https = require("https");
const { splitStreetNameType, streetNamesMatch } = require("../address_utils");

const [, , address, suburb] = process.argv;
const email = process.env.REX_EMAIL;
const password = process.env.REX_PASSWORD;

if (!address || !suburb || !email || !password) {
  console.error('Usage: REX_EMAIL/REX_PASSWORD env vars + node tests/rex_probe.js "<address>" "<suburb>"');
  process.exit(1);
}

function rexPost(path, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = https.request(
      { hostname: "api.rexsoftware.com", path: `/v1/rex${path}`, method: "POST", headers, timeout: 20000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout on ${path}`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Mirror parseAddressComponents just enough to pull the street number + full name.
function parse(addr) {
  const parts = (addr || "").trim().split(/\s+/);
  const numIdx = parts.findIndex((p) => /^\d/.test(p));
  const number = numIdx >= 0 ? parts[numIdx] : "";
  const rest = numIdx >= 0 ? parts.slice(numIdx + 1) : parts;
  return { number, fullStreetName: rest.join(" ") };
}

(async () => {
  const login = await rexPost("/Authentication/login", { email, password });
  const token = login.body?.result;
  if (typeof token !== "string") {
    console.error("Login failed:", login.body?.error?.message ?? login.body);
    process.exit(1);
  }
  console.log("Logged in OK.\n");

  const { number, fullStreetName } = parse(address);
  console.log(`Incoming:  "${address}"  ->  number=${number}, street="${fullStreetName}"`);
  console.log(`Parsed as:`, splitStreetNameType(fullStreetName), "\n");

  const res = await rexPost(
    "/properties/search",
    { criteria: [
        { name: "property.adr_suburb_or_town", value: suburb },
        { name: "property.adr_street_number", value: number },
      ], limit: 20 },
    token
  );
  const rows = res.body?.result?.rows || [];
  console.log(`Rex returned ${rows.length} property(ies) at ${number} in ${suburb}:\n`);

  let matched = null;
  for (const r of rows) {
    const rFull = [r.adr_street_name || "", r.adr_street_type || ""].filter(Boolean).join(" ");
    const isMatch = streetNamesMatch(rFull, fullStreetName);
    if (isMatch && !matched) matched = r;
    console.log(`  #${r.id}  "${rFull}"  ${isMatch ? "<== WOULD LINK (no new property)" : "(different street)"}`);
  }

  console.log("");
  if (matched) {
    console.log(`RESULT: links to existing property #${matched.id} — NO duplicate would be created. ✅`);
  } else if (rows.length) {
    console.log("RESULT: candidates exist but none match — a new property WOULD be created.");
  } else {
    console.log("RESULT: nothing at this number/suburb yet — a new property WOULD be created (expected for a fresh address).");
  }
})().catch((e) => { console.error(e); process.exit(1); });
