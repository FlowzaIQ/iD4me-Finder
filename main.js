const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require('http');
const { google } = require('googleapis');
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { generateNameVariations, evaluateAbsenteeResolution, MAX_RESULT_COUNT, RESOLVED_STATUS } = require("./absentee_utils");
const { isNetworkFailure } = require("./network_utils");
const { normalizeDateString } = require("./date_utils");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyCwUrMmVTZ9rzDQZvDtbIGbLYAtEkx5A6g"); // 🔴 Paste your key here!

async function aiNameMatch(targetName, scrapedRows) {
    if (!scrapedRows || scrapedRows.length === 0) return "NO_MATCH";

    const cleanRows = scrapedRows.map(r => r.name.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim());
    const nameList = cleanRows.join(", ");

    console.log(`\n--- 🧠 AI DEBUG X-RAY ---`);
    console.log(`🎯 CSV Target Name : "${targetName}"`);
    console.log(`📄 Scraped from Web: "${nameList}"`);

    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        systemInstruction: `You are an emotionless, highly strict data auditing AI. Your ONLY job is to classify names into HOMEOWNER, RELATIVE, or POSSIBLE_HOMEOWNER based on name matching rules.

🎯 CORE LOGIC ENGINE:
Step 1: Identify the LAST NAME (surname) of the Target Name. This is your absolute anchor.
Step 2: Scan the Scraped Names list. Split into two groups:
    - Group A: names that DO share the exact target surname.
    - Group B: names that do NOT share the target surname.
Step 3: For Group A (same surname):
    - If it matches the Target Name's exact first name or first initial, classify as HOMEOWNER.
    - If it has the exact same surname but a different first name, classify as RELATIVE.
    - If the Target Name is ONLY a surname (e.g., "CODY"), classify everyone with that surname as HOMEOWNER.
Step 4: For Group B (different surname — possible name change e.g. maiden → married):
    - ONLY classify if: the Target Name has 3+ parts AND the scraped name has 3+ parts AND their first name AND middle name (second word) both match exactly.
    - If that condition is met, classify as POSSIBLE_HOMEOWNER.
    - Otherwise, discard the name entirely.

🚫 ZERO-TOLERANCE RULES:
- NEVER match a person just because they share a first name. The surname is all that matters UNLESS Step 4 applies.
- NEVER assume nicknames ("Jake" does not equal "Jacob"). Exact text matches only.
- NEVER return a name that was not physically in the Scraped Names list.

❌ EXAMPLES OF FATAL ERRORS YOU MUST AVOID:
- Target: "CLIFFORD DAVID LLEWELLYN JENKINS" | Scraped: "Engel Holmes, Brigid Holmes" -> ERROR! The surname is Jenkins. Holmes is wrong. Output MUST be: NO_MATCH
- Target: "GRAHAM CHARLES EVANS" | Scraped: "Graham Wilkins, Graham Charles Wilkins" -> ERROR! You matched the first name 'Graham' but ignored that the surname is Evans. Output MUST be: NO_MATCH
- Target: "DENISE MAYER" | Scraped: "Denise Trenaman" -> ERROR! No middle name to verify — too ambiguous. Output MUST be: NO_MATCH

✅ CORRECT POSSIBLE_HOMEOWNER EXAMPLE:
- Target: "DENISE HELEN MAYER" | Scraped: "Denise Helen Trenaman" -> First "DENISE" matches, middle "HELEN" matches, surnames differ → Output: "Denise Helen Trenaman===POSSIBLE_HOMEOWNER"

OUTPUT FORMAT:
- Return ONLY a pipe-separated list of exact scraped names with their classification using '==='.
- Example Output: "Jake Tran===HOMEOWNER | Lisa Tran===RELATIVE | Denise Helen Trenaman===POSSIBLE_HOMEOWNER"
- If absolutely no one qualifies under any step, you MUST reply exactly with: NO_MATCH`
    }, {
        // Keeps the AI fast and stops it from rambling
        maxOutputTokens: 400, 
        temperature: 0.1
    });

    const prompt = `Target Name: ${targetName}\nScraped Names: ${nameList}`;

    try {
        const result = await model.generateContent(prompt);
        let aiAnswer = result.response.text().replace(/\s+/g, ' ').trim();
        
        console.log(`🤖 AI Decided     : "${aiAnswer}"`);
        console.log(`-------------------------\n`);
        return aiAnswer;
    } catch (error) {
        return "NO_MATCH";
    }
}

let mainWindow;

/* ==================================================
   GLOBAL VARIABLES & TIMINGS
================================================== */
let stats = { total: 0, processed: 0, found: 0, notFound: 0, errors: 0 };
let recentProcessingTimes = [];
let emaProcessingMs = null;
const ETA_EMA_ALPHA = 0.05;  // Lower = smoother, less reactive to single outliers
const ETA_WARMUP_SAMPLES = 5;
let runStartTime = null;      // Wall-clock anchor for blended ETA
let isGlobalPaused = false;     
let isGlobalStopped = false; 
let isScrapeRunning = false;
let hasProcessedAnyRow = false;
let currentBrowser = null;
let activeAuthServer = null;
let globalAddressCache = new Map(); // 🧠 ADD THIS LINE (The Memory Bank)
let globalDncrCache = new Map(); // 🧠 DNCR Memory Bank
let globalSelectedFile = ""; 
let currentSpeedMode = "normal";

// These must be 'let' so the Speed Controller can change them!
let DELAY_MIN = 1200;
let DELAY_MAX = 2000;
let BETWEEN_OWNERS_MIN = 3500;
let BETWEEN_OWNERS_MAX = 5500;

/* ==================================================
   UI LOGGER AND HELPERS
================================================== */
function sendStats() {
    if (mainWindow) mainWindow.webContents.send('stats-update', stats);
}

function updateStatus(msg, isSpinning = true) {
    if (mainWindow) mainWindow.webContents.send('status-update', { msg, isSpinning });
}

function addActivity(msg, type = 'info') {
    if (mainWindow) mainWindow.webContents.send('activity-update', { msg, type });
}

function parseAiClassificationString(aiMatchedString) {
    const aiClassifications = {};
    if (!aiMatchedString || aiMatchedString.trim() === "" || aiMatchedString === "NO_MATCH") return aiClassifications;
    aiMatchedString.split('|').forEach(pair => {
        const parts = pair.split('===');
        if (parts.length === 2) {
            aiClassifications[parts[0].trim().toLowerCase()] = parts[1].trim();
        }
    });
    return aiClassifications;
}

async function aiNameMatchGrouped(targetNames, scrapedRows) {
    if (!targetNames || targetNames.length === 0) return null;
    if (!scrapedRows || scrapedRows.length === 0) return null;

    const cleanRows = scrapedRows.map(r => r.name.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim());
    const nameList = cleanRows.join(", ");
    const targetsList = targetNames.join(" | ");

    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        systemInstruction: `You are a strict data auditing AI. Classify each target name against the scraped names list using these rules.

RULES:
- Use ONLY names that appear in the Scraped Names list.
- For names sharing the target's surname: classify as HOMEOWNER (first name or initial matches) or RELATIVE (different first name, same surname).
- For names NOT sharing the target's surname: classify as POSSIBLE_HOMEOWNER ONLY if the target has 3+ name parts AND the scraped name has 3+ name parts AND both share the exact same first name AND the exact same middle name (second word). This handles name changes (e.g. maiden → married). Otherwise discard.
- If no matches for a target, return an empty matches array.

OUTPUT:
Return ONLY valid JSON with this shape:
{"targets":[{"target":"Full Target Name","matches":[{"name":"Exact Scraped Name","role":"HOMEOWNER"}]}]}
Roles may be HOMEOWNER, RELATIVE, or POSSIBLE_HOMEOWNER. No extra text.`
    }, {
        maxOutputTokens: 700,
        temperature: 0.1
    });

    const prompt = `Targets: ${targetsList}\nScraped Names: ${nameList}`;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1) {
            text = text.slice(firstBrace, lastBrace + 1);
        }
        const parsed = JSON.parse(text);
        const out = {};
        const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
        for (const t of targets) {
            const key = normalizeLoose(t.target || "");
            const map = {};
            const matches = Array.isArray(t.matches) ? t.matches : [];
            for (const m of matches) {
                if (m && m.name && m.role) {
                    map[m.name.trim().toLowerCase()] = `${m.role}`.trim();
                }
            }
            if (key) out[key] = map;
        }
        return out;
    } catch (error) {
        return null;
    }
}

function isFastMode() {
    return currentSpeedMode === "fast";
}

function updateProgress() {
    if (mainWindow && stats.total > 0) {
        const percent = Math.round((stats.processed / stats.total) * 100);
        
        let etaString = "Calculating...";
        if (emaProcessingMs !== null && recentProcessingTimes.length >= ETA_WARMUP_SAMPLES) {
            const remainingItems = stats.total - stats.processed;

            // EMA-based estimate
            const emaEta = emaProcessingMs * remainingItems;

            // Wall-clock-based estimate: actual elapsed / items done * items remaining
            let wallEta = emaEta;
            if (runStartTime !== null && stats.processed > 0) {
                const elapsedMs = Date.now() - runStartTime;
                const actualMsPerItem = elapsedMs / stats.processed;
                wallEta = actualMsPerItem * remainingItems;
            }

            // Blend: 40% EMA (responsive), 60% wall-clock (stable)
            const etaMs = 0.4 * emaEta + 0.6 * wallEta;

            const totalSecs = Math.floor(etaMs / 1000);
            const h = Math.floor(totalSecs / 3600);
            const m = Math.floor((totalSecs % 3600) / 60);
            const s = totalSecs % 60;

            if (h > 0) etaString = `${h}h ${m}m ${s}s`;
            else if (m > 0) etaString = `${m}m ${s}s`;
            else etaString = `${s}s`;
        }

        mainWindow.webContents.send('progress-update', { 
            percent, 
            processed: stats.processed, 
            total: stats.total,
            eta: etaString,
            fileName: globalSelectedFile
        });
    }
}

/* ==================================================
   PATH & CHECKPOINT CONFIGURATION
================================================== */
const BASE_DIR = app.getPath('userData'); // A hidden system folder for app settings/checkpoints
const OUTPUT_DIR = path.join(app.getPath('documents'), "ID4Me_Scraper_Results"); // A normal folder in their Documents

// 🔑 Google OAuth Credentials (stored in secrets.js, excluded from git)
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = require('./secrets');
const GOOGLE_OAUTH_PORT = 42813;
const GOOGLE_AUTH_FILE = path.join(BASE_DIR, 'google_auth.json');
const CSV_SETTINGS_FILE = path.join(BASE_DIR, 'csv_settings.json');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getCheckpointFile(csvFilename) {
  const safeName = path.basename(csvFilename).replace('.csv', '').replace(/[^a-z0-9]/gi, '_');
  return path.join(BASE_DIR, `.checkpoint_${safeName}.json`);
}

function saveCheckpoint(csvFilename, index, outputFile, extra = {}) {
  const checkpointFile = getCheckpointFile(csvFilename);
  const tempFile = `${checkpointFile}.tmp`;
  // Merge with existing checkpoint so persistent fields (e.g. spreadsheetId) survive per-row saves
  let existing = {};
  try {
    if (fs.existsSync(checkpointFile)) existing = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  } catch (e) {}
  const data = { ...existing, lastCompletedIndex: index, outputFile: outputFile, savedAt: new Date().toISOString(), ...extra };
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, checkpointFile);
    return true;
  } catch (e) {
    addActivity(`Checkpoint failed: ${e.message}`, 'danger');
    return false;
  }
}

function loadCheckpoint(csvFilename) {
  const checkpointFile = getCheckpointFile(csvFilename);
  if (!fs.existsSync(checkpointFile)) return null;
  try {
    const content = fs.readFileSync(checkpointFile, 'utf8');
    if (!content || content.trim() === "") return null;
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function clearCheckpoint(csvFilename) {
  const checkpointFile = getCheckpointFile(csvFilename);
  if (fs.existsSync(checkpointFile)) fs.unlinkSync(checkpointFile);
}

async function askWhetherToSaveSessionCsv(outputFile, isResumedSession = false) {
  if (!mainWindow || mainWindow.isDestroyed() || !outputFile) return true;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (keepFile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(keepFile);
    };

    const timeoutId = setTimeout(() => finish(true), 120000);

    ipcMain.once('save-session-csv-decision', (_event, payload) => {
      const shouldSave = payload && payload.save === true;
      finish(shouldSave);
    });

    mainWindow.webContents.send('prompt-save-session-csv', {
      fileName: path.basename(outputFile),
      isResumedSession
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/T/, "_").replace(/:/g, "-").replace(/\..+/, "");
}

/* ==================================================
   POST-RUN DEDUPLICATION
   Removes duplicate rows per address where name AND mobile match exactly.
   Prefers rows that have a mobile number over blank/N/A ones.
   Columns: 0=ownerName, 1=address, 2=status, 3=personName, 4=mobile
================================================== */
function deduplicateOutputCsv(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const rows = parse(content, { relax_quotes: true, skip_empty_lines: false, relax_column_count: true });
        if (rows.length === 0) return 0;

        // Separate header (if present) from data rows
        const isHeader = rows[0] && typeof rows[0][3] === 'string' && rows[0][3].toLowerCase().includes('name');
        const header = isHeader ? rows[0] : null;
        const dataRows = isHeader ? rows.slice(1) : rows;

        const normalisePhone = v => (v || "").replace(/\D/g, '');
        const hasMobile = v => normalisePhone(v).length > 0;

        // Group rows by address (col 1) → name (col 3) → mobile bucket
        // Key: address + personName + normalisedMobile
        const seen = new Map(); // key → row index in kept[]
        const kept = [];
        let removedCount = 0;

        for (const row of dataRows) {
            if (!row || row.length === 0) continue;

            const originalName = (row[0] || "").trim();
            const address = (row[1] || "").trim();
            const personName = (row[3] || "").trim();
            const mobile = (row[4] || "").trim();
            const normMobile = normalisePhone(mobile);

            // Build dedup key: original search name + address + found name + normalised mobile.
            // originalName is included so two different owners at the same address who both get
            // NO_MATCH (Found_Name="N/A", mobile="") are not incorrectly collapsed into one row.
            const dedupKey = `${originalName}|||${address}|||${personName}|||${normMobile}`;

            if (!seen.has(dedupKey)) {
                seen.set(dedupKey, kept.length);
                kept.push(row);
            } else {
                // Duplicate found — prefer the one with a mobile number
                const existingIndex = seen.get(dedupKey);
                const existingMobile = kept[existingIndex][4] || "";
                if (!hasMobile(existingMobile) && hasMobile(mobile)) {
                    // Replace the no-mobile version with this one that has a number
                    kept[existingIndex] = row;
                }
                removedCount++;
            }
        }

        // Write cleaned file back
        const output = (header ? [header, ...kept] : kept)
            .map(r => stringify([r]))
            .join('');
        fs.writeFileSync(filePath, output, 'utf8');
        return removedCount;
    } catch (e) {
        addActivity(`Deduplication failed: ${e.message}`, 'warning');
        return 0;
    }
}

/* ==================================================
   UTILITIES & SCORING
================================================== */
const randomDelay = (min, max) => new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
const normalize = txt => (txt || "").toUpperCase().replace(/\s+/g, " ").trim();
const normalizeLoose = txt => (txt || "").toLowerCase().replace(/\s+/g, " ").trim();
const normalizePhone = txt => (txt || "").replace(/\D/g, "");
// Rejects non-phone text like "Last called 25-Feb-2026" (< 8 digits when stripped)
const isPhoneNumber = txt => normalizePhone(txt).length >= 8;
const safeValue = txt => {
    if (!txt) return "";
    const cleaned = `${txt}`.trim();
    if (cleaned.toUpperCase() === "N/A") return "";
    return cleaned;
};
const buildRelativeKey = (person) => {
    const name = normalizeLoose(safeValue(person.Name));
    const email = normalizeLoose(safeValue(person.Email));
    const mobile = normalizePhone(safeValue(person.Mobile));
    const landline = normalizePhone(safeValue(person.Landline));
    return `${name}|${email}|${mobile}|${landline}`;
};
function isBusiness(name) {
  if (!name) return false;
  const n = name.toUpperCase();
  return ["PTY", "PTY LTD", "LTD", "LIMITED", "NOMINEES", "HOLDINGS", "TRUST", "TRUSTEE", "COUNCIL", "STATE OF", "CITY OF", "INC", "CORP", "GOVERNMENT", "ARCHBISHOP", "UNITING CHURCH", "ABORIGINAL HOUSING", "PROPRIETORS OF SP", "STRATA PLAN", "BODY CORPORATE", "OWNERS CORPORATION", "HOUSING COMMISSION", "DEPARTMENT OF", "MINISTER FOR", "TOWN OF", "CROWN", "RESERVE FOR", "RESERVE", "AUTHORITY", "THE PROPRIETORS", "ROMAN CATHOLIC", "SALVATION ARMY", "PUBLIC TRUSTEE", "DIOCESE", "PARISH", "CHURCH", "COMPANY", "INVESTMENTS"].some(b => n.includes(b));
}
function isExcludedOwnerName(name) {
  if (!name) return false;
  const n = name.toUpperCase();
  return [
    "STATE OF",
    "WATER CORPORATION",
    "COMMISSION",
    "HOUSING",
    "ARCHBISHOP",
    "ARCHIBISHOP"
  ].some(b => n.includes(b));
}
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

function expandStreetSuffix(address) {
  if (!address) return address;
  // Only expand the last word of the address (the street type)
  return address.replace(/\b(\w+)$/, match => {
    const upper = match.toUpperCase();
    return STREET_SUFFIX_MAP[upper] || match;
  });
}

function splitPriceFinderOwners(rawOwner) {
  if (!rawOwner || rawOwner.trim() === "" || rawOwner.trim() === "-") return ["", "", ""];

  // If it's a business/entity, put it in owner_1 and skip splitting
  if (isBusiness(rawOwner)) return [rawOwner.trim(), "", ""];

  // Split on semicolons first, then ampersands within each chunk
  const parts = rawOwner
    .split(";")
    .flatMap(chunk => chunk.split("&"))
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return ["", "", ""];

  // Shared surname rule: if the last part has 3+ words, its last word may be a
  // shared surname. Append it to any earlier part that only has 2 words.
  const lastPart = parts[parts.length - 1];
  const lastPartWords = lastPart.split(" ").filter(Boolean);
  if (parts.length > 1 && lastPartWords.length >= 2) {
    const sharedSurname = lastPartWords[lastPartWords.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const words = parts[i].split(" ").filter(Boolean);
      if (words.length <= 2) {
        parts[i] = parts[i] + " " + sharedSurname;
      }
    }
  }

  // Cap at 3 owners
  const [o1 = "", o2 = "", o3 = ""] = parts;
  return [o1, o2, o3];
}

function parsePriceFinderCSV(rows) {
  // Find header row indices
  const header = rows[0].map(h => h.toLowerCase().trim());
  const col = name => header.indexOf(name);

  const idxAddress  = col("imported_address");
  const idxSuburb   = col("imported_suburb");
  const idxState    = col("imported_state");
  const idxPostcode = col("imported_postcode");
  const idxDate     = col("sold_date");
  const idxOwner    = col("owner_surname");

  // Group rows by address to handle duplicates
  const addressMap = new Map();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const address  = expandStreetSuffix((r[idxAddress] || "").trim().toUpperCase());
    const suburb   = (r[idxSuburb]   || "").trim();
    const state    = (r[idxState]    || "").trim();
    const postcode = (r[idxPostcode] || "").trim();
    const rawDate  = (r[idxDate]     || "").trim();
    const rawOwner = (r[idxOwner]    || "").trim();

    if (!address) continue;

    // Normalise date from DD/MM/YYYY to DD Mon YYYY
    let date = rawDate;
    const dateParts = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dateParts) {
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const day   = dateParts[1].padStart(2, "0");
      const month = months[parseInt(dateParts[2], 10) - 1] || dateParts[2];
      const year  = dateParts[3];
      date = `${day} ${month} ${year}`;
    }

    const addressKey = `${address.toUpperCase()}|${postcode}`;
    const entry = { address, suburb, state, postcode, date, rawOwner, rawDate };

    if (!addressMap.has(addressKey)) {
      addressMap.set(addressKey, [entry]);
    } else {
      addressMap.get(addressKey).push(entry);
    }
  }

  // Resolve duplicates and build final rows
  const result = [];

  for (const [, entries] of addressMap) {
    if (entries.length === 1) {
      // No duplicate — straightforward
      const e = entries[0];
      const [o1, o2, o3] = splitPriceFinderOwners(e.rawOwner);
      result.push([e.address, e.suburb, e.state, e.postcode, e.date, o1, o2, o3]);
    } else {
      // Multiple rows for same address — check if resale or strata
      // Parse dates for comparison (DD/MM/YYYY → comparable)
      const withParsedDate = entries.map(e => {
        const m = e.rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        const ts = m ? new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`).getTime() : 0;
        return { ...e, ts };
      });

      // Group by sold_date — use parsed timestamp so minor formatting differences
      // (e.g. "1/01/2024" vs "01/01/2024") don't incorrectly trigger the resale path.
      const dateGroups = new Map();
      for (const e of withParsedDate) {
        const dk = e.ts > 0 ? String(e.ts) : (e.rawDate || "unknown");
        if (!dateGroups.has(dk)) dateGroups.set(dk, []);
        dateGroups.get(dk).push(e);
      }

      if (dateGroups.size === 1) {
        // Same date → strata/multiple owners on same title, keep all
        for (const e of withParsedDate) {
          const [o1, o2, o3] = splitPriceFinderOwners(e.rawOwner);
          result.push([e.address, e.suburb, e.state, e.postcode, e.date, o1, o2, o3]);
        }
      } else {
        // Different dates → resale history, keep only most recent
        withParsedDate.sort((a, b) => b.ts - a.ts);
        const mostRecent = withParsedDate[0];
        const [o1, o2, o3] = splitPriceFinderOwners(mostRecent.rawOwner);
        result.push([mostRecent.address, mostRecent.suburb, mostRecent.state, mostRecent.postcode, mostRecent.date, o1, o2, o3]);
      }
    }
  }

  return result;
}

function parseOwnershipSearchCSV(rows) {
  const header = rows[0].map(h => h.toLowerCase().trim());
  const col = name => header.indexOf(name);

  const idxStreet   = col("street");
  const idxLocality = col("locality");
  const idxPostcode = col("postcode");
  const idxDate     = col("last sale date");
  const idxOwner    = col("current owners");
  const idxGovNum   = col("government number");

  const addressMap = new Map();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const address  = expandStreetSuffix((r[idxStreet]   || "").trim().toUpperCase());
    const suburb   = (r[idxLocality] || "").trim();
    const govNum   = (r[idxGovNum]   || "").trim();
    const state    = (govNum.match(/^([A-Za-z]+)/) || [])[1]?.toUpperCase() || "";
    const postcode = (r[idxPostcode] || "").trim();
    const rawDate  = (r[idxDate]     || "").trim();
    const rawOwner = (r[idxOwner]    || "").trim().replace(/\.+$/, "");

    if (!address) continue;

    let date = rawDate;
    const dateParts = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dateParts) {
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const day   = dateParts[1].padStart(2, "0");
      const month = months[parseInt(dateParts[2], 10) - 1] || dateParts[2];
      const year  = dateParts[3];
      date = `${day} ${month} ${year}`;
    }

    const addressKey = `${address.toUpperCase()}|${postcode}`;
    const entry = { address, suburb, state, postcode, date, rawOwner, rawDate };

    if (!addressMap.has(addressKey)) {
      addressMap.set(addressKey, [entry]);
    } else {
      addressMap.get(addressKey).push(entry);
    }
  }

  const result = [];

  for (const [, entries] of addressMap) {
    if (entries.length === 1) {
      const e = entries[0];
      const [o1, o2, o3] = splitPriceFinderOwners(e.rawOwner);
      result.push([e.address, e.suburb, e.state, e.postcode, e.date, o1, o2, o3]);
    } else {
      const withParsedDate = entries.map(e => {
        const m = e.rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        const ts = m ? new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`).getTime() : 0;
        return { ...e, ts };
      });

      const dateGroups = new Map();
      for (const e of withParsedDate) {
        const dk = e.ts > 0 ? String(e.ts) : (e.rawDate || "unknown");
        if (!dateGroups.has(dk)) dateGroups.set(dk, []);
        dateGroups.get(dk).push(e);
      }

      if (dateGroups.size === 1) {
        for (const e of withParsedDate) {
          const [o1, o2, o3] = splitPriceFinderOwners(e.rawOwner);
          result.push([e.address, e.suburb, e.state, e.postcode, e.date, o1, o2, o3]);
        }
      } else {
        withParsedDate.sort((a, b) => b.ts - a.ts);
        const mostRecent = withParsedDate[0];
        const [o1, o2, o3] = splitPriceFinderOwners(mostRecent.rawOwner);
        result.push([mostRecent.address, mostRecent.suburb, mostRecent.state, mostRecent.postcode, mostRecent.date, o1, o2, o3]);
      }
    }
  }

  return result;
}

function isEmpty(name) { return !name || name.trim() === "" || name.trim() === "-"; }
function tokenize(name) { return normalize(name).split(" ").filter(Boolean); }
function getFirstLast(name) {
  const parts = tokenize(name).map(p => p.replace(/[^A-Z]/g, ''));
  if (parts.length === 0) return { first: "", last: "" };
  return { first: parts[0], last: parts[parts.length - 1] };
}
function isCoOwnerNameMatch(candidate, owner) {
  const c = getFirstLast(candidate);
  const o = getFirstLast(owner);
  if (!c.first || !c.last || !o.first || !o.last) return false;
  if (c.last !== o.last) return false;

  const cInitial = c.first.length === 1;
  const oInitial = o.first.length === 1;
  if (cInitial || oInitial) {
    return cInitial && oInitial && c.first === o.first;
  }
  return c.first === o.first;
}
function scoreNameMatch(owner, candidate) {
  const o = tokenize(owner), c = tokenize(candidate);
  let score = 0;
  if (c.every(t => o.includes(t))) score += 5;
  score += c.filter(t => o.includes(t)).length;
  if (o[o.length - 1] === c[c.length - 1]) score += 10;
  if (o.length === 1 && o[o.length - 1] === c[c.length - 1]) score += 20;
  return score;
}

/* ==================================================
   FUZZY FIRST-NAME HELPERS
   Catches minor spelling differences (e.g. "Abdulah" vs "Abdula").
================================================== */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

function isSimilarFirstName(a, b) {
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 4) return false; // too short to fuzz safely
    const dist = levenshtein(a, b);
    if (minLen >= 8) return dist <= 2;
    if (minLen >= 5) return dist <= 1;
    return false;
}

/* ==================================================
   DETERMINISTIC NAME CLASSIFIER (used in fast + normal mode)
   Replicates the AI's surname-matching rules with zero latency.
================================================== */
function classifyNamesAlgorithm(targetName, scrapedRows) {
    const cleanTarget = targetName.replace(/[^A-Za-z\s]/g, '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    const targetSurname = cleanTarget[cleanTarget.length - 1];
    const targetFirst = cleanTarget.length > 1 ? cleanTarget[0] : null;
    const targetMiddle = cleanTarget.length > 2 ? cleanTarget[1] : null;

    if (!targetSurname) return {};

    const result = {};
    for (const row of scrapedRows) {
        const cleaned = row.name
            .replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        const parts = cleaned.replace(/[^A-Za-z\s]/g, '').trim().toUpperCase().split(/\s+/).filter(Boolean);
        const rowSurname = parts[parts.length - 1];
        const rowFirst = parts.length > 1 ? parts[0] : null;
        const rowMiddle = parts.length > 2 ? parts[1] : null;

        if (rowSurname !== targetSurname) {
            // Possible name change (e.g. maiden → married): only flag if first AND middle both match exactly
            if (targetFirst && targetMiddle && rowFirst && rowMiddle &&
                rowFirst === targetFirst && rowMiddle === targetMiddle) {
                result[cleaned.toLowerCase()] = "POSSIBLE_HOMEOWNER";
            }
            continue;
        }

        let role;
        if (!targetFirst) {
            // Target is surname-only (e.g. "CODY") — everyone with that surname is HOMEOWNER
            role = "HOMEOWNER";
        } else if (!rowFirst || rowFirst === targetFirst || isSimilarFirstName(rowFirst, targetFirst)) {
            // Exact match or close spelling variant (e.g. "Abdulah" vs "Abdula")
            role = "HOMEOWNER";
        } else if (rowFirst.length === 1 || targetFirst.length === 1) {
            // Initial match (e.g. "J" matches "JAKE")
            role = rowFirst[0] === targetFirst[0] ? "HOMEOWNER" : "RELATIVE";
        } else {
            role = "RELATIVE";
        }

        result[cleaned.toLowerCase()] = role;
    }
    return result;
}

// Grouped version: runs classifyNamesAlgorithm for each target and returns same shape as aiNameMatchGrouped
function classifyNamesAlgorithmGrouped(targetNames, scrapedRows) {
    const out = {};
    for (const targetName of targetNames) {
        const key = normalizeLoose(targetName);
        out[key] = classifyNamesAlgorithm(targetName, scrapedRows);
    }
    return out;
}

function buildPeopleFromWinners(rawWinners) {
  if (!rawWinners || rawWinners.length === 0) return [];

  const uniqueWinners = new Map();
  for (const w of rawWinners) {
      const exactNameKey = w.name.replace(/[\u00A0\u2000-\u200B]/g, ' ').trim().toLowerCase();
      const mobileRaw = (w.mobile || "");
      const mobileKey = mobileRaw.replace(/\D/g, '');
      const hasMobile = mobileKey.length > 0 && !mobileRaw.toLowerCase().includes('n/a');
      const uniqueKey = hasMobile ? `${exactNameKey}__${mobileKey}` : `${exactNameKey}__nomobile`;

      const existing = uniqueWinners.get(uniqueKey);
      if (!existing) {
          uniqueWinners.set(uniqueKey, w);
      } else {
          if (existing.role === "HOMEOWNER" && w.role !== "HOMEOWNER") continue;
          if (w.role === "HOMEOWNER") {
              uniqueWinners.set(uniqueKey, w);
          }
      }
  }

  return Array.from(uniqueWinners.values()).map(w => ({
      Status: w.role,
      Name: w.name.replace(/[\u00A0\u2000-\u200B]/g, ' ').trim(),
      Address: w.addr,
      Mobile: w.mobile,
      AllMobiles: w.allMobiles || [w.mobile].filter(Boolean),
      Landline: w.landline,
      AllLandlines: w.allLandlines || [w.landline].filter(Boolean),
      Email: w.email,
      Last_Seen: w.lastSeen
  }));
}

/* ==================================================
   PLAYWRIGHT PAGE LOGIC
================================================== */
let searchCounter = 0;

async function waitForPageReady(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    await page.waitForSelector('input[type="search"]', { timeout: 10000, state: 'visible' });
    if (!isFastMode()) await randomDelay(500, 800);
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('input[type="search"]', { timeout: 15000, state: 'visible' });
      await randomDelay(isFastMode() ? 200 : 1000, isFastMode() ? 200 : 1500);
    }
  }
}

async function ensureNormalSearch(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");

    const normalModeBtn = page.getByRole('button', { name: /^search$/i }).first();
    const smartModeBtn = page.getByRole('button', { name: /smart search/i }).first();

    // Wait for the search-mode UI to render before checking. Without this, both
    // buttons can be invisible on a slow/fresh page load, causing the function to
    // exit without switching — leaving Smart Search active and breaking getRows.
    try {
      await Promise.race([
        normalModeBtn.waitFor({ state: 'visible', timeout: 8000 }),
        smartModeBtn.waitFor({ state: 'visible', timeout: 8000 }),
      ]);
    } catch (_) { /* buttons may not exist on all pages */ }

    // Already in normal search mode — nothing to do.
    if (await normalModeBtn.isVisible().catch(() => false)) return true;

    // Smart search is active — switch to normal via the split-button dropdown.
    if (await smartModeBtn.isVisible().catch(() => false)) {
      const dropdown = page.getByTestId('split-button-dropdown-button');
      if (await dropdown.count() > 0) {
        await dropdown.click({ timeout: 3000 });
        const normalItem = page.getByRole('menuitem', { name: 'Search', exact: true });
        if (await normalItem.count() > 0) {
          await normalItem.click({ timeout: 3000 });
          if (!isFastMode()) await randomDelay(400, 700);
          // Confirm the switch succeeded before continuing.
          await normalModeBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        }
      }
    }

    return true;
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    return false;
  }
}

async function healthCheckAndRefresh(page) {
  searchCounter++;
  const refreshInterval = currentSpeedMode === 'fast' ? 150 : currentSpeedMode === 'normal' ? 75 : 50;
  if (searchCounter % refreshInterval === 0) {
    updateStatus(`Performing health refresh (${searchCounter} done)...`, true);
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await waitForPageReady(page);
      if (!isFastMode()) await randomDelay(2000, 3000);
    }
  }
}

async function clearSearch(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    const chipCount = await page.evaluate(() => document.querySelectorAll('.MuiChip-root').length);
    if (chipCount > 0) {
      await page.locator('input[type="search"]').click({ timeout: 3000 });
      for (let i = 0; i < chipCount; i++) {
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);
      }
      await randomDelay(DELAY_MIN, DELAY_MAX);
    }
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (!page.isClosed()) { await page.reload({ waitUntil: 'load', timeout: 30000 }); await waitForPageReady(page); }
  }
}

async function addFirstChip(page, txt) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    const combo = page.getByRole("combobox", { name: /search/i });
    await combo.click({ timeout: 5000 });
    await combo.fill(txt);
    await combo.press("Enter");
    await randomDelay(DELAY_MIN, DELAY_MAX);
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await waitForPageReady(page);
      const combo = page.getByRole("combobox", { name: /search/i });
      await combo.click({ timeout: 5000 }); await combo.fill(txt); await combo.press("Enter");
      await randomDelay(DELAY_MIN * 2, DELAY_MAX * 2);
    }
  }
}

async function addChip(page, txt) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    const inp = page.locator('input[type="search"]');
    await inp.waitFor({ timeout: 8000, state: 'visible' });
    await inp.click(); await inp.fill(txt); await inp.press("Enter");
    await randomDelay(DELAY_MIN, DELAY_MAX);
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    await randomDelay(isFastMode() ? 200 : 2000, isFastMode() ? 200 : 3000);
    const inp = page.locator('input[type="search"]');
    await inp.waitFor({ timeout: 5000, state: 'visible' });
    await inp.click(); await inp.fill(txt); await inp.press("Enter");
  }
}

async function getRows(page, retryCount = 0) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    if (await page.getByRole('heading', { name: 'No results found' }).isVisible().catch(()=>false)) return { success: true, data: [] };

    // 1. Wait for the grid to be ready and get the scrollable element
    const scrollBoxLocator = page.locator('.MuiDataGrid-virtualScroller, .ag-body-viewport, .table-container').first();
    await scrollBoxLocator.waitFor({ state: 'visible', timeout: 10000 });

    const out = [];
    const seen = new Set();
    let stagnantScrolls = 0;

    // 2. Loop and scroll until we've seen everything
    for (let i = 0; i < 150; i++) { // Max 150 scrolls to prevent an infinite loop
        const previousSeenCount = seen.size;

        // 3. Scrape all currently visible rows using Playwright locators
        const rows = page.locator('div[role="row"]');
        const rowCount = await rows.count();

        for (let j = 1; j < rowCount; j++) {
            try {
                const row = rows.nth(j);
                const cells = row.locator('div[role="gridcell"]');
                if (await cells.count() < 10) continue;

                const name = await cells.nth(3).innerText({ timeout: 500 }).catch(() => "");
                const addr = await cells.nth(5).innerText({ timeout: 500 }).catch(() => "");
                const allMobiles = (await cells.nth(6).innerText({ timeout: 500 }).catch(() => "")).split("\n").map(s => s.trim()).filter(s => s && isPhoneNumber(s));
                const mobile = allMobiles[0] || "";
                const email = await cells.nth(7).innerText({ timeout: 500 }).catch(() => "");
                const allLandlines = (await cells.nth(8).innerText({ timeout: 500 }).catch(() => "")).split("\n").map(s => s.trim()).filter(s => s && isPhoneNumber(s));
                const landline = allLandlines[0] || "";
                const lastSeen = await cells.nth(9).innerText({ timeout: 500 }).catch(() => "");

                if (!name) continue;

                const key = `${normalizeLoose(name)}|${normalizeLoose(addr)}|${normalizePhone(mobile)}|${normalizePhone(landline)}|${normalizeLoose(email)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ name, addr, mobile, allMobiles, email, landline, allLandlines, lastSeen });
                }
            } catch (e) { /* Ignore individual row errors */ }
        }

        // 4. Directly evaluate our position and command a scroll
        const isAtBottom = await scrollBoxLocator.evaluate(node => {
            return (node.scrollHeight - node.scrollTop) <= (node.clientHeight + 5); // Check if we're at the bottom
        });

        if (isAtBottom) {
            if (seen.size === previousSeenCount) {
                stagnantScrolls++; // If at bottom and no new rows, increment counter
            } else {
                stagnantScrolls = 0; // If new rows appeared, reset
            }
        } else {
            // If not at the bottom, scroll the box down directly
            const step = isFastMode() ? 900 : 500;
            await scrollBoxLocator.evaluate((node, scrollStep) => { node.scrollBy(0, scrollStep); }, step);
            stagnantScrolls = 0;
        }
        
        // 5. If we are at the bottom and nothing new has appeared for N straight cycles, we are done.
        if (stagnantScrolls >= (isFastMode() ? 3 : 5)) {
            break;
        }

        await page.waitForSelector('div[role="row"]', { state: 'attached', timeout: isFastMode() ? 1500 : 2000 }).catch(() => {});
        await page.waitForTimeout(isFastMode() ? 150 : 200); // Brief wait for new rows to render
    }

    // Final pass: scroll back to top and re-read to catch rows unloaded during downward scroll
    await scrollBoxLocator.evaluate(node => { node.scrollTop = 0; }).catch(() => {});
    await page.waitForTimeout(isFastMode() ? 200 : 400);
    const finalRows = page.locator('div[role="row"]');
    const finalRowCount = await finalRows.count();
    for (let j = 1; j < finalRowCount; j++) {
        try {
            const row = finalRows.nth(j);
            const cells = row.locator('div[role="gridcell"]');
            if (await cells.count() < 10) continue;
            const name = await cells.nth(3).innerText({ timeout: 500 }).catch(() => "");
            const addr = await cells.nth(5).innerText({ timeout: 500 }).catch(() => "");
            const allMobiles = (await cells.nth(6).innerText({ timeout: 500 }).catch(() => "")).split("\n").map(s => s.trim()).filter(s => s && isPhoneNumber(s));
            const mobile = allMobiles[0] || "";
            const email = await cells.nth(7).innerText({ timeout: 500 }).catch(() => "");
            const allLandlines = (await cells.nth(8).innerText({ timeout: 500 }).catch(() => "")).split("\n").map(s => s.trim()).filter(s => s && isPhoneNumber(s));
            const landline = allLandlines[0] || "";
            const lastSeen = await cells.nth(9).innerText({ timeout: 500 }).catch(() => "");
            if (!name) continue;
            const key = `${normalizeLoose(name)}|${normalizeLoose(addr)}|${normalizePhone(mobile)}|${normalizePhone(landline)}|${normalizeLoose(email)}`;
            if (!seen.has(key)) { seen.add(key); out.push({ name, addr, mobile, allMobiles, email, landline, allLandlines, lastSeen }); }
        } catch (e) {}
    }

    return { success: true, data: out };

  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (retryCount < 2) {
      await randomDelay(isFastMode() ? 500 : 2000, isFastMode() ? 500 : 3000);
      return await getRows(page, retryCount + 1);
    }
    return { success: false, data: [], error: "SERVICE_FAILURE" };
  }
}

async function enrichPeopleWithDncr(page, people) {
  const enrichedPeople = [];
  const pendingChecks = new Map();
  const dncrAttempts = new Map();

  for (const person of people) {
    const mobile = (person.Mobile || "").trim();
    if (!mobile || mobile.toUpperCase() === "N/A") {
      enrichedPeople.push({ ...person, DNCR: "N/A" });
    } else if (globalDncrCache.has(mobile)) {
      addActivity(`DNCR CACHE HIT for ${person.Name} (${mobile}): ${globalDncrCache.get(mobile)}`, 'info');
      enrichedPeople.push({ ...person, DNCR: globalDncrCache.get(mobile) });
    } else {
      const uniqueKey = `${person.Name}_${mobile}`;
      pendingChecks.set(uniqueKey, person);
    }
  }

  if (pendingChecks.size === 0) return enrichedPeople;

  addActivity(`Starting fresh DNCR check for ${pendingChecks.size} people.`, 'info');

  const scrollBox = page.locator('.MuiDataGrid-virtualScroller, .ag-body-viewport, .table-container').first();
  const hasScrollBox = await scrollBox.count() > 0;

  // Helper: do one full directional pass through the grid (down or up)
  async function doScrollPass(direction) {
      if (hasScrollBox) {
          // Reset to the appropriate starting edge
          await scrollBox.evaluate((el, dir) => {
              el.scrollTop = dir === 'down' ? 0 : el.scrollHeight;
              el.dispatchEvent(new Event('scroll'));
          }, direction).catch(() => {});
          await page.waitForTimeout(200);
      }

      let lastScrollTop = -1;
      let stuckCount = 0;

      for (let i = 0; i < 120; i++) {
          if (pendingChecks.size === 0) break;

          // Detect if the grid has stopped scrolling (hit the end) — bail out early
          if (hasScrollBox) {
              const currentScrollTop = await scrollBox.evaluate(el => el.scrollTop).catch(() => -1);
              if (currentScrollTop === lastScrollTop) {
                  stuckCount++;
                  if (stuckCount >= 3) {
                      addActivity(`[Pass:${direction}] Grid end reached. Ending pass early.`, 'info');
                      break;
                  }
              } else {
                  stuckCount = 0;
              }
              lastScrollTop = currentScrollTop;
          }

          const rows = page.locator('div[role="row"]');
          const rowCount = await rows.count();

          const namesWeAreLookingFor = Array.from(pendingChecks.values()).map(p => p.Name).join(', ');
          addActivity(`[Pass:${direction}] Scanning ${rowCount} rows on screen. Looking for: ${namesWeAreLookingFor}`, 'info');

          for (let j = 1; j < rowCount; j++) {
              if (pendingChecks.size === 0) break;

          const row = rows.nth(j);
          const rowTextForLogging = (await row.innerText({ timeout: 500 }).catch(() => "ERROR_READING_ROW") || "").replace(/\s+/g, " ");
          
          // Log the text of every single row for debugging purposes.
          if (!isFastMode()) {
              addActivity(`DEBUG: Row ${j} text: "${rowTextForLogging}"`, 'info');
          }

          for (const [uniqueKey, person] of pendingChecks.entries()) {
              const mobile = person.Mobile.trim();
              const nameToFind = person.Name.trim();
              const mobileDigits = mobile.replace(/\D/g, '');
              const rowDigits = rowTextForLogging.replace(/\D/g, '');
              const digitMatch = mobileDigits && (rowDigits.includes(mobileDigits) || (mobileDigits.length >= 8 && rowDigits.includes(mobileDigits.slice(-8))));

              // Primary match: name + mobile. Fallback: mobile digits only (handles name format differences)
              const nameMatch = rowTextForLogging.toLowerCase().includes(nameToFind.toLowerCase());
              const mobileOnlyMatch = digitMatch && !nameMatch;
              const isMatch = (nameMatch && (rowTextForLogging.includes(mobile) || digitMatch)) || mobileOnlyMatch;

              if (isMatch) {
                  if (mobileOnlyMatch) {
                      addActivity(`MOBILE-ONLY MATCH for ${nameToFind} (name format may differ in DNCR).`, 'warning');
                  } else {
                      addActivity(`MATCH FOUND for ${nameToFind} in row text.`, 'success');
                  }
                  await row.scrollIntoViewIfNeeded().catch(() => {});
                  await row.hover({ timeout: 1000 }).catch(() => {});

                  const icon = row.locator('button:has([data-testid="PhoneIphoneOutlinedIcon"]), button:has([data-testid="PhoneOutlinedIcon"]), [data-testid="PhoneIphoneOutlinedIcon"], [data-testid="PhoneOutlinedIcon"]').first();

                  if (await icon.count() > 0) {
                      addActivity(`Phone icon found for ${person.Name}. Attempting to trigger tooltip.`, 'info');

                      let status = "unknown";

                      // Try up to 3 hover attempts with move-away-and-back between each
                      for (let hoverAttempt = 1; hoverAttempt <= 3 && status === "unknown"; hoverAttempt++) {
                          try {
                              // Move away first to reset any lingering tooltip state
                              await page.mouse.move(0, 0).catch(() => {});
                              await page.waitForTimeout(150);

                              const iconButton = icon.locator('xpath=ancestor::button[1]');
                              const hoverTarget = (await iconButton.count()) > 0 ? iconButton : icon;

                              await hoverTarget.hover({ timeout: 1500 });
                              const box = await hoverTarget.boundingBox().catch(() => null);
                              if (box) {
                                  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
                              }
                          } catch (interactionError) {
                              addActivity(`Hover attempt ${hoverAttempt} failed for ${person.Name} — skipping attempt.`, 'warning');
                          }

                          await page.waitForSelector('[role="tooltip"], .MuiTooltip-popper', { state: 'visible', timeout: 2000 }).catch(() => {});
                          await page.waitForTimeout(500);

                          const tooltip = page.locator('[role="tooltip"], .MuiTooltip-popper').first();
                          const tooltipVisible = await tooltip.isVisible().catch(() => false);

                          if (tooltipVisible) {
                              const tooltipText = await tooltip.innerText().catch(() => "");
                              if (tooltipText && tooltipText !== "COULD_NOT_READ_TOOLTIP") {
                                  addActivity(`Tooltip text for ${person.Name} (attempt ${hoverAttempt}): "${tooltipText}"`, 'info');

                                  // "Phone Status:" alone means the tooltip rendered but the value never loaded.
                                  // Resolve as unknown immediately — retrying never helps here.
                                  const trimmed = tooltipText.trim();
                                  if (trimmed === "Phone Status" || trimmed === "Phone Status:") {
                                      addActivity(`Tooltip shows only header for ${person.Name} — resolving as unknown immediately.`, 'warning');
                                      status = "confirmed_unknown";
                                      break;
                                  }

                                  // DNCR explicitly returned "Unknown" for both fields — this is a confirmed result, not a timing issue
                                  if (tooltipText.includes("DNCR Status: Unknown") && tooltipText.includes("Phone Status: Unknown")) {
                                      addActivity(`DNCR confirmed unknown status for ${person.Name}. Resolving immediately.`, 'info');
                                      status = "confirmed_unknown";
                                      break;
                                  }

                                  // Check "Cannot Call" BEFORE "Can Call" — "Cannot Call" is the legally critical status
                                  if (tooltipText.includes("Cannot Call")) status = "blocked";
                                  else if (tooltipText.includes("Can Call")) status = "callable";
                                  else if (tooltipText.includes("Expired")) status = "expired";

                                  // If both blocked and callable appear (multiple state registrations), treat as blocked
                                  if (status === "callable" && tooltipText.includes("Cannot Call")) {
                                      addActivity(`Conflicting DNCR statuses for ${person.Name} — defaulting to 'blocked' (safer).`, 'warning');
                                      status = "blocked";
                                  }
                              } else {
                                  addActivity(`Tooltip visible but empty for ${person.Name} (attempt ${hoverAttempt}).`, 'warning');
                              }
                          } else {
                              addActivity(`No tooltip found for ${person.Name} (attempt ${hoverAttempt}/3).`, 'warning');
                          }
                      }
                      
                      if (status === "confirmed_unknown") {
                          // DNCR explicitly returned unknown — treat as a real result, no retries
                          await page.mouse.move(0, 0).catch(() => {});
                          await page.keyboard.press('Escape').catch(() => {});
                          globalDncrCache.set(mobile, "unknown");
                          enrichedPeople.push({ ...person, DNCR: "unknown" });
                          pendingChecks.delete(uniqueKey);
                      } else if (status === "unknown") {
                          const attemptCount = (dncrAttempts.get(uniqueKey) || 0) + 1;
                          dncrAttempts.set(uniqueKey, attemptCount);
                          if (attemptCount >= 3) {
                              addActivity(`DNCR detector could not read status for ${person.Name} after ${attemptCount} attempts — marking as Detector Failed.`, 'danger');
                              await page.mouse.move(0, 0).catch(() => {});
                              await page.keyboard.press('Escape').catch(() => {});
                              globalDncrCache.set(mobile, "Detector Failed");
                              enrichedPeople.push({ ...person, DNCR: "Detector Failed" });
                              pendingChecks.delete(uniqueKey);
                          } else {
                              addActivity(`DNCR status still unreadable for ${person.Name}. Attempt ${attemptCount}/3; will retry.`, 'warning');
                              await page.mouse.move(0, 0).catch(() => {});
                              await page.keyboard.press('Escape').catch(() => {});
                          }
                      } else {
                          addActivity(`Final DNCR status for ${person.Name}: ${status}`, 'success');

                          await page.mouse.move(0, 0).catch(() => {});
                          await page.keyboard.press('Escape').catch(() => {});

                          globalDncrCache.set(mobile, status);
                          enrichedPeople.push({ ...person, DNCR: status });
                          pendingChecks.delete(uniqueKey);
                      }
                  }
                  break; // Move to the next row after finding a match
              }
          }
      }
      
          if (pendingChecks.size > 0 && hasScrollBox) {
              const step = isFastMode() ? 800 : 480;
              await scrollBox.evaluate((el, s) => { el.scrollBy(0, s); el.dispatchEvent(new Event('scroll')); }, direction === 'down' ? step : -step).catch(() => {});
              await page.waitForTimeout(isFastMode() ? 100 : 200);
          }
      }
  }

  // First pass: scroll down from top
  await doScrollPass('down');

  // Second pass: scroll up from bottom (catches cases where virtualised grid skipped rows going down)
  if (pendingChecks.size > 0) {
      addActivity(`${pendingChecks.size} person(s) still pending after downward pass. Trying upward pass.`, 'warning');
      await doScrollPass('up');
  }

  for (const [uniqueKey, person] of pendingChecks.entries()) {
    const attempts = dncrAttempts.get(uniqueKey) || 0;
    addActivity(`DNCR check timed out or failed for ${person.Name} after ${attempts} attempts. Defaulting to 'unknown'.`, 'danger');
    enrichedPeople.push({ ...person, DNCR: "unknown" });
  }

  return enrichedPeople;
}
async function addressScan(page, address, postcode, ownerName, suburb, coOwners = [], retryCount = 0) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    
    // 1. Check the Memory Bank first!
    const cacheKey = `${address}_${suburb || postcode}`.toLowerCase();
    let rows;

    if (globalAddressCache.has(cacheKey)) {
        // We already searched this address recently! Pull the data from memory.
        rows = globalAddressCache.get(cacheKey);
        addActivity(`Memory: Skipped typing, loaded ${address} from cache.`, 'info');
    } else {
        // We haven't seen this address yet. Use the browser to search it.
        await clearSearch(page);
        await addFirstChip(page, suburb ? `${address} ${suburb}` : address);
        
        updateStatus(`Waiting for ID4Me to load ${address}...`, true);
        // 🚀 SPEED OPTIMIZATION: State-based wait instead of hardcoded 1.5s
        await page.waitForSelector('.MuiDataGrid-row, div[role="row"]', { state: 'attached', timeout: isFastMode() ? 3000 : 5000 }).catch(() => {});
        await page.waitForTimeout(isFastMode() ? 100 : 300); // Tiny buffer for DOM to settle
        
        // 📜 NEW ROBUST SCROLL: Harvest all names using Playwright's native tools
        updateStatus(`Scraping all residents for ${ownerName}...`, true);
        const rowsResult = await getRows(page); // Use the reliable getRows function
    
        if (!rowsResult.success) return { status: "SERVICE_FAILURE", people: [], serviceError: true };
        
        rows = rowsResult.data;
        
        // Save the result into the Memory Bank for the next person!
        globalAddressCache.set(cacheKey, rows); 
    }

    // 2. If the memory (or the fresh search) says there's no data, instantly bail out.
    if (rows.length === 0) return { status: "NO_ADDRESS_MATCH", people: [] };

// 3. Classify Homeowners and Relatives
    let aiClassifications;
    if (currentSpeedMode === 'safe') {
        updateStatus(`AI is classifying family for ${ownerName}...`, true);
        const aiMatchedString = await aiNameMatch(ownerName, rows);
        if (aiMatchedString === "NO_MATCH") return { status: "NO_MATCH", people: [] };
        aiClassifications = parseAiClassificationString(aiMatchedString);
    } else {
        updateStatus(`Classifying family for ${ownerName}...`, true);
        aiClassifications = classifyNamesAlgorithm(ownerName, rows);
        if (Object.keys(aiClassifications).length === 0) return { status: "NO_MATCH", people: [] };
    }

    // 4. Match results back to the row data and attach their new Role
    let rawWinners = [];
    for (const r of rows) {
        const cleanScrapedName = r.name.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (aiClassifications[cleanScrapedName]) {
            r.role = aiClassifications[cleanScrapedName]; // Attach "HOMEOWNER" or "RELATIVE"
            rawWinners.push(r);
        }
    }

    if (rawWinners.length === 0) return { status: "NO_MATCH", people: [] };

    // 5. Skip co-owners masquerading as relatives for this address
    if (coOwners && coOwners.length > 0) {
        const otherOwners = coOwners.filter(o => !isCoOwnerNameMatch(o, ownerName));

        if (otherOwners.length > 0) {
            rawWinners = rawWinners.filter(w => {
                if (w.role !== "RELATIVE") return true;
                return !otherOwners.some(o => isCoOwnerNameMatch(w.name, o));
            });
        }
    }

    if (rawWinners.length === 0) return { status: "NO_MATCH", people: [] };
    const people = buildPeopleFromWinners(rawWinners);
    if (people.length === 0) return { status: "NO_MATCH", people: [] };

    return { status: "VERIFIED", people };

  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (retryCount < 2) {
      await randomDelay((retryCount + 1) * 3000, (retryCount + 1) * 3000 + 1000);
      if (!page.isClosed()) { try { await page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (e) {} }
      return await addressScan(page, address, postcode, ownerName, suburb, coOwners, retryCount + 1);
    }
    return { status: "SERVICE_FAILURE", people: [], serviceError: true };
  }
}

async function searchId4meByName(page, fullName) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    await clearSearch(page);
    await addFirstChip(page, fullName);
    await page.waitForSelector('.MuiDataGrid-row, div[role="row"]', { state: 'attached', timeout: isFastMode() ? 3000 : 5000 }).catch(() => {});
    await page.waitForTimeout(isFastMode() ? 100 : 300);

    // Read the pagination counter (e.g. "1–13 of 13 results") before scrolling all rows.
    // If the total exceeds MAX_RESULT_COUNT, bail immediately without calling getRows.
    const paginationText = await page.getByText(/of \d+ results?/i).first().innerText({ timeout: 2000 }).catch(() => "");
    const countMatch = paginationText.match(/of (\d+) results?/i);
    if (countMatch) {
        const totalCount = parseInt(countMatch[1], 10);
        if (totalCount > MAX_RESULT_COUNT) {
            return { success: true, data: [], tooMany: true, totalCount };
        }
    }

    const rowsResult = await getRows(page);
    if (!rowsResult.success) return { success: false, data: [], error: "SERVICE_FAILURE", errorMessage: rowsResult.errorMessage || "" };
    return { success: true, data: rowsResult.data };
  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    return { success: false, data: [], error: "SERVICE_FAILURE", errorMessage: error.message || "" };
  }
}

async function resolveAbsenteeOwner(page, ownerName, propertyState) {
  const attempts = generateNameVariations(ownerName);
  for (const attemptName of attempts) {
    addActivity(`Absentee lookup: searching "${attemptName}"`, 'info');
    const rowsResult = await searchId4meByName(page, attemptName);
    if (!rowsResult.success) {
      addActivity(`Absentee lookup failed for "${attemptName}" (service error).`, 'warning');
      return { resolved: false, skipped: true, reason: "service_failure" };
    }

    // Pagination showed >20 results before we even scrolled — name is too common.
    // Shorter variations would return even more results, so stop immediately.
    if (rowsResult.tooMany) {
      addActivity(`Absentee lookup skipped for "${attemptName}" (${rowsResult.totalCount} results — too many).`, 'warning');
      return { resolved: false, skipped: true, reason: "too_many_results" };
    }

    const rows = rowsResult.data || [];
    addActivity(`Absentee lookup: "${attemptName}" returned ${rows.length} results`, 'info');

    const decision = evaluateAbsenteeResolution(rows, {
      maxResultCount: MAX_RESULT_COUNT,
      propertyState: propertyState || null
    });

    if (decision.resolved) {
      addActivity(`Absentee resolved for ${ownerName}: ${decision.mobile}`, 'success');
      return { resolved: true, mobile: decision.mobile, absenteeAddr: decision.addr || "" };
    }

    if (decision.reason === "no_results") {
      continue; // Try next name variation
    }

    if (
      decision.reason === "too_many_results" ||
      decision.reason === "no_mobile" ||
      decision.reason === "no_same_state_match"
    ) {
      addActivity(`Absentee lookup skipped for ${ownerName} (${decision.reason}).`, 'warning');
      return { resolved: false, skipped: true, reason: decision.reason };
    }
  }

  addActivity(`Absentee lookup: no match for ${ownerName}.`, 'info');
  return { resolved: false, skipped: false, reason: "no_match" };
}

async function addressScanGrouped(page, address, postcode, ownerNames, suburb, coOwners = [], retryCount = 0) {
  try {
    if (page.isClosed()) throw new Error("Target closed");

    const cacheKey = `${address}_${suburb || postcode}`.toLowerCase();
    let rows;

    if (globalAddressCache.has(cacheKey)) {
        rows = globalAddressCache.get(cacheKey);
        addActivity(`Memory: Skipped typing, loaded ${address} from cache.`, 'info');
    } else {
        // Guarantee normal search mode is active before typing — guards against the
        // race condition where ensureLoggedIn ran before the UI finished rendering.
        await ensureNormalSearch(page);
        await clearSearch(page);
        await addFirstChip(page, suburb ? `${address} ${suburb}` : address);

        updateStatus(`Waiting for ID4Me to load ${address}...`, true);
        await page.waitForSelector('.MuiDataGrid-row, div[role="row"]', { state: 'attached', timeout: isFastMode() ? 3000 : 5000 }).catch(() => {});
        await page.waitForTimeout(isFastMode() ? 100 : 300);

        updateStatus(`Scraping all residents for ${address}...`, true);
        const rowsResult = await getRows(page);

        if (!rowsResult.success) {
            // getRows failed — possibly still in wrong search mode on first attempt.
            // Reload, re-ensure normal search, and retry once before giving up.
            if (retryCount < 1) {
                addActivity(`Search failed for ${address} — re-checking search mode and retrying.`, 'warning');
                await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
                await waitForPageReady(page);
                await ensureNormalSearch(page);
                return await addressScanGrouped(page, address, postcode, ownerNames, suburb, coOwners, retryCount + 1);
            }
            return null;
        }

        rows = rowsResult.data;
        globalAddressCache.set(cacheKey, rows);
    }

    const results = new Map();
    const ownerList = (ownerNames || []).filter(o => !isEmpty(o));

    if (rows.length === 0) {
        for (const ownerName of ownerList) {
            results.set(normalizeLoose(ownerName), { status: "NO_ADDRESS_MATCH", people: [] });
        }
        return results;
    }

    let groupedClassifications;
    if (currentSpeedMode === 'safe') {
        updateStatus(`AI is classifying family for ${ownerList.join(", ")}...`, true);
        groupedClassifications = await aiNameMatchGrouped(ownerList, rows);
        if (!groupedClassifications) {
            groupedClassifications = {};
            for (const ownerName of ownerList) {
                const aiMatchedString = await aiNameMatch(ownerName, rows);
                groupedClassifications[normalizeLoose(ownerName)] = parseAiClassificationString(aiMatchedString);
            }
        }
    } else {
        updateStatus(`Classifying family for ${ownerList.join(", ")}...`, true);
        groupedClassifications = classifyNamesAlgorithmGrouped(ownerList, rows);
    }

    for (const ownerName of ownerList) {
        const ownerKey = normalizeLoose(ownerName);
        const aiClassifications = groupedClassifications[ownerKey] || {};

        let rawWinners = [];
        for (const r of rows) {
            const cleanScrapedName = r.name.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            if (aiClassifications[cleanScrapedName]) {
                rawWinners.push({ ...r, role: aiClassifications[cleanScrapedName] });
            }
        }

        if (rawWinners.length === 0) {
            results.set(ownerKey, { status: "NO_MATCH", people: [] });
            continue;
        }

        if (coOwners && coOwners.length > 0) {
            const otherOwners = coOwners.filter(o => !isCoOwnerNameMatch(o, ownerName));

            if (otherOwners.length > 0) {
                rawWinners = rawWinners.filter(w => {
                    if (w.role !== "RELATIVE") return true;
                    return !otherOwners.some(o => isCoOwnerNameMatch(w.name, o));
                });
            }
        }

        if (rawWinners.length === 0) {
            results.set(ownerKey, { status: "NO_MATCH", people: [] });
            continue;
        }

        const people = buildPeopleFromWinners(rawWinners);
        if (people.length === 0) {
            results.set(ownerKey, { status: "NO_MATCH", people: [] });
            continue;
        }

        results.set(ownerKey, { status: "VERIFIED", people });
    }

    return results;
  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (retryCount < 2) {
      await randomDelay((retryCount + 1) * 3000, (retryCount + 1) * 3000 + 1000);
      if (!page.isClosed()) { try { await page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (e) {} }
      return await addressScanGrouped(page, address, postcode, ownerNames, suburb, coOwners, retryCount + 1);
    }
    const results = new Map();
    const ownerList = (ownerNames || []).filter(o => !isEmpty(o));
    for (const ownerName of ownerList) {
        results.set(normalizeLoose(ownerName), { status: "SERVICE_FAILURE", people: [], serviceError: true });
    }
    return results;
  }
}

async function fallbackScan(page, address, postcode, ownerName) {
  const parts = tokenize(ownerName);
  const variants = [ownerName];
  if (parts.length >= 4) { variants.push([parts[0], ...parts.slice(2)].join(" ")); variants.push([parts[0], parts[1], ...parts.slice(3)].join(" ")); }
  if (parts.length >= 3) variants.push(`${parts[0]} ${parts[parts.length - 1]}`);
  
  for (const v of [...new Set(variants)]) {
    try {
      if (page.isClosed()) throw new Error("Target closed");
      await clearSearch(page); await addFirstChip(page, address); await addChip(page, v); await addChip(page, postcode);
      const rowsResult = await getRows(page);
      if (!rowsResult.success) return { status: "SERVICE_FAILURE", people: [], serviceError: true };
      if (rowsResult.data.length === 0) continue;

      let best = rowsResult.data.map(r => ({ ...r, score: scoreNameMatch(ownerName, r.name) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
      if (best.length > 0) return { status: "VERIFIED_FALLBACK", people: best.slice(0, 1).map(w => ({ Name: w.name, Address: w.addr, Mobile: w.mobile, Landline: w.landline, Email: w.email, Last_Seen: w.lastSeen })) };
    } catch (error) { 
      if (page && page.isClosed()) throw new Error("Target closed");
      continue; 
    }
  }
  return { status: "NO_MATCH", people: [] };
}

// 🚀 HubSpot API Integration
async function sendToHubSpot(person, propertyAddress, apiKey) {
    if (!apiKey) throw new Error("Missing API Key");

    // We split the name to fit CRM First/Last name fields
    const nameParts = person.Name.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';

    const payload = {
        properties: {
            firstname: firstName,
            lastname: lastName,
            phone: person.Mobile !== "N/A" ? person.Mobile : "",
            address: propertyAddress,
            lifecyclestage: "lead",
            // You can easily add custom HubSpot properties here later!
        }
    };

    try {
        const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || "API Rejected Request");
        }
        return true;
    } catch (error) {
        throw new Error(`HubSpot Error: ${error.message}`);
    }
}

async function performLogin(page) {
  let creds = { email: '', password: '' };
  try {
      if (fs.existsSync(AUTH_FILE)) creds = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {}

  if (!creds.email || !creds.password) {
      throw new Error("Incorrect Login Details"); // Kill switch if empty!
  }
  
  try {
    updateStatus("Injecting ID4Me Credentials...", true);
    await page.goto("https://id4me.me/search");
    if (isFastMode()) {
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    } else {
        await page.waitForTimeout(2000);
    }
    
    if (page.url().includes("auth0.com") || page.url().includes("login")) {
      await page.locator('#loginemail').first().fill(creds.email);
      await page.locator('#loginpassword').first().fill(creds.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
      
      // 🛑 YOUR ORIGINAL IDEA: Wait up to 4 seconds to see if the exact error text appears
      try {
          await page.locator('#loginform').getByText('Wrong email or password.').waitFor({ timeout: 4000 });
          // If the code makes it to this line, the error text popped up!
          throw new Error("Incorrect Login Details"); 
      } catch (err) {
          if (err.message === "Incorrect Login Details") throw err; // Pass the grenade up
          // If it timed out, that is GREAT! It means no error appeared and we logged in successfully.
      }
      
      if (isFastMode()) {
          await page.waitForSelector('input[type="search"]', { timeout: 8000, state: 'visible' }).catch(() => {});
      } else {
          await page.waitForTimeout(2000); // Give the dashboard time to load
      }
    }
    return true;
  } catch (error) { 
    if (error.message === "Incorrect Login Details") throw error; // Pass the grenade up
    return false; 
  }
}

async function ensureLoggedIn(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    const url = page.url();
    // Only navigate if we've been kicked to the login page — don't reload if already on search
    if (url.includes("auth0.com") || url.includes("login") || !url.includes("id4me.me")) {
        await page.goto("https://id4me.me/search", { timeout: 15000 });
        if (page.url().includes("auth0.com") || page.url().includes("login")) {
            await performLogin(page);
        }
    }
    await ensureNormalSearch(page);
  } catch (e) {
    if (e.message === "Incorrect Login Details") throw e;
    if (page && page.isClosed()) throw new Error("Target closed");
  }
}

/* ==================================================
   GOOGLE SHEETS HELPERS
================================================== */
function createOAuth2Client() {
    return new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        `http://localhost:${GOOGLE_OAUTH_PORT}/oauth-callback`
    );
}

function loadGoogleTokens() {
    try {
        if (fs.existsSync(GOOGLE_AUTH_FILE)) return JSON.parse(fs.readFileSync(GOOGLE_AUTH_FILE, 'utf8'));
    } catch (e) {}
    return null;
}

async function flushSheetsBuffer(sheetsClient, spreadsheetId, buffer) {
    if (!sheetsClient || !buffer.length) return;
    const rows = buffer.splice(0, buffer.length);
    try {
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'RAW',
            requestBody: { values: rows }
        });
    } catch (e) {
        console.error('Sheets flush error:', e.message);
    }
}

async function createLiveSheet(title) {
    const tokens = loadGoogleTokens();
    if (!tokens?.refresh_token) throw new Error('Google account not connected');

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(tokens);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const sheet = await sheets.spreadsheets.create({
        requestBody: { properties: { title } }
    });
    const spreadsheetId = sheet.data.spreadsheetId;

    await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { role: 'reader', type: 'anyone' }
    });

    return { spreadsheetId, sheets, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

/* ==================================================
   ELECTRON IPC LISTENERS
================================================== */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 700,
    icon: path.join(__dirname, 'assets', 'icon.ico'), //
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// 📂 Opens the output folder
ipcMain.on('open-output-folder', () => {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    shell.openPath(OUTPUT_DIR);
});

// ⏸️ Handles Pause/Resume
ipcMain.on('toggle-pause', (event, pausedState) => {
    isGlobalPaused = pausedState;
    if (isGlobalPaused) {
        updateStatus("⏸️ Paused. Click Resume to continue.", false);
        addActivity("Automation paused by user.", "warning");
    } else {
        updateStatus("▶️ Resuming...", true);
        addActivity("Automation resumed.", "success");
    }
});

// 🔐 Secure Credentials Storage
const AUTH_FILE = path.join(BASE_DIR, "auth.json");

// 🎯 Secure CRM Settings Storage
const CRM_FILE = path.join(BASE_DIR, "crm_settings.json");

ipcMain.handle('get-crm-settings', () => {
    try {
        if (fs.existsSync(CRM_FILE)) return JSON.parse(fs.readFileSync(CRM_FILE, 'utf8'));
    } catch (e) {}
    return { mode: 'csv', apiKey: '' };
});

ipcMain.on('save-crm-settings', (event, settings) => {
    try {
        fs.writeFileSync(CRM_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error("Failed to save CRM file");
    }
});

ipcMain.handle('get-credentials', () => {
    try {
        if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    } catch (e) {}
    return { email: '', password: '' };
});

ipcMain.on('save-credentials', (event, creds) => {
    try {
        fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2));
    } catch (e) {
        console.error("Failed to save auth file");
    }
});

// 📊 CSV Mode Settings
ipcMain.handle('get-csv-settings', () => {
    try {
        if (fs.existsSync(CSV_SETTINGS_FILE)) return JSON.parse(fs.readFileSync(CSV_SETTINGS_FILE, 'utf8'));
    } catch (e) {}
    return { liveSheets: false };
});

ipcMain.on('save-csv-settings', (event, settings) => {
    try { fs.writeFileSync(CSV_SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) {}
});

// 🔑 Google Account Auth
ipcMain.handle('google-auth-status', () => {
    const tokens = loadGoogleTokens();
    return { connected: !!(tokens?.refresh_token), email: tokens?.email || null };
});

ipcMain.on('google-auth-disconnect', () => {
    try { fs.unlinkSync(GOOGLE_AUTH_FILE); } catch (e) {}
    if (mainWindow) mainWindow.webContents.send('google-auth-result', { success: false });
});

ipcMain.on('google-auth-start', () => {
    // Kill any previous auth attempt that didn't complete
    if (activeAuthServer) {
        try { activeAuthServer.close(); } catch (e) {}
        activeAuthServer = null;
    }

    const oauth2Client = createOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
    });

    const server = http.createServer(async (req, res) => {
        if (!req.url.startsWith('/oauth-callback')) return;
        const code = new URL(req.url, `http://localhost:${GOOGLE_OAUTH_PORT}`).searchParams.get('code');
        if (!code) { res.writeHead(400); res.end('No code'); server.close(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Connected! You can close this tab.</h2></body></html>');
        server.close();
        try {
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);
            let email = null;
            try {
                const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
                const info = await oauth2.userinfo.get();
                email = info.data.email;
            } catch (e) {}
            fs.writeFileSync(GOOGLE_AUTH_FILE, JSON.stringify({ ...tokens, email }, null, 2));
            if (mainWindow) mainWindow.webContents.send('google-auth-result', { success: true, email });
        } catch (e) {
            if (mainWindow) mainWindow.webContents.send('google-auth-result', { success: false, error: e.message });
        }
    });

    // Auto-cancel if the user closes the browser without completing auth
    const authTimeout = setTimeout(() => {
        if (server.listening) {
            server.close();
            if (mainWindow) mainWindow.webContents.send('google-auth-result', { success: false, cancelled: true });
        }
    }, 3 * 60 * 1000);

    server.on('close', () => {
        clearTimeout(authTimeout);
        activeAuthServer = null;
    });

    server.on('error', (err) => {
        clearTimeout(authTimeout);
        activeAuthServer = null;
        if (mainWindow) mainWindow.webContents.send('google-auth-result', { success: false, error: err.message });
    });

    activeAuthServer = server;
    server.listen(GOOGLE_OAUTH_PORT, 'localhost', () => {
        shell.openExternal(authUrl);
    });
});

// 🛑 Handles Manual Stop
ipcMain.on('stop-scrape', () => {
    isGlobalStopped = true;
    isGlobalPaused = false; // Automatically release the holding pattern if they try to stop while paused
    if (!isScrapeRunning) {
        updateStatus("No active run to stop.", false);
        return;
    }
    if (!hasProcessedAnyRow) {
        updateStatus("Stopping... No records processed yet.", true);
        return;
    }
    updateStatus("Finishing current row and stopping...", true);
});

ipcMain.on('force-close-windows', async () => {
    try {
        if (currentBrowser && currentBrowser.isConnected()) {
            await currentBrowser.close();
        }
    } catch (e) {}
    currentBrowser = null;
});

// 🚀 Main Scraper Logic
ipcMain.on('start-scrape', async (event, speedMode, isStrictHomeownersOnly, outputMode, dncrEnabled = false, absenteeEnabled = false, headlessEnabled = false, liveSheets = false) => {
  let browser;
  let OUTPUT_FILE = null;
  let selectedFile = "";
  let stream = null;
  let stoppedEarly = false;
  isScrapeRunning = true;
  hasProcessedAnyRow = false;
  const seenRelativesByAddress = new Map();
  try {
    // 1. APPLY SPEED SETTINGS
    currentSpeedMode = speedMode || "normal";
    if (speedMode === 'fast') {
        // 🏎️ NO BRAKES MODE
        DELAY_MIN = 100; DELAY_MAX = 300; // Bare minimum so the search bar doesn't glitch
        BETWEEN_OWNERS_MIN = 0; BETWEEN_OWNERS_MAX = 0; // ZERO wait time between rows
        addActivity("🏎️ Brakes removed. Relying on AI latency.", "warning");
    } else if (speedMode === 'safe') {
        DELAY_MIN = 2000; DELAY_MAX = 3500;
        BETWEEN_OWNERS_MIN = 8000; BETWEEN_OWNERS_MAX = 12000;
        addActivity("🐢 Safe Mode selected (Anti-Ban)", "success");
    } else {
        DELAY_MIN = 400; DELAY_MAX = 700;
        BETWEEN_OWNERS_MIN = 800; BETWEEN_OWNERS_MAX = 1500;
        addActivity("🚶 Normal Mode selected", "info");
    }

    // Reset Global UI Variables
    stats = { total: 0, processed: 0, found: 0, notFound: 0, errors: 0 };
        recentProcessingTimes = [];
        emaProcessingMs = null;
        runStartTime = null;
    isGlobalPaused = false;
    isGlobalStopped = false; 
    globalAddressCache.clear(); // 🧠 ADD THIS LINE (Wipes memory for the new file)
    globalDncrCache.clear(); // 🧠 Wipes DNCR memory
    
    sendStats();
    updateProgress();

    // 2. Native File Picker Dialog
    const filePaths = dialog.showOpenDialogSync(mainWindow, {
      title: 'Select Input CSV',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile']
    });

    if (!filePaths || filePaths.length === 0) {
      updateStatus("File selection cancelled.", false);
      isScrapeRunning = false;
      hasProcessedAnyRow = false;
      event.reply('scrape-finished');
      return;
    }

    const INPUT_FILE = filePaths[0];
    selectedFile = path.basename(INPUT_FILE);
    globalSelectedFile = selectedFile;
    addActivity(`Loaded file: ${selectedFile}`, 'info');

    let startIndex = 0;
    let checkpoint = null;
    let priorCheckpointIndex = -1;

    // 3. Checkpoint Logic
    checkpoint = loadCheckpoint(selectedFile);
    if (checkpoint && checkpoint.completed) {
      // This spreadsheet was previously run to completion
      const completedDate = checkpoint.savedAt ? new Date(checkpoint.savedAt).toLocaleDateString() : "a previous session";
      const totalRows = checkpoint.totalRows || (checkpoint.lastCompletedIndex + 1);

      if (!checkpoint.askedAboutRerun) {
        // First time re-opening — ask once
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'question',
          buttons: ['Yes, run again', 'Cancel'],
          title: 'Already Completed',
          message: `This spreadsheet was already fully completed (${totalRows} records on ${completedDate}).\n\nWould you like to run it again?`,
        });
        if (choice === 1) {
          // Cancel — mark as asked so we don't nag again
          saveCheckpoint(selectedFile, checkpoint.lastCompletedIndex, checkpoint.outputFile, {
            completed: true, totalRows, askedAboutRerun: true
          });
          updateStatus("Operation cancelled.", false);
          isScrapeRunning = false;
          hasProcessedAnyRow = false;
          event.reply('scrape-finished');
          return;
        }
      } else {
        // Already asked once — show a simpler restart dialog
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'question',
          buttons: ['Start New Run', 'Cancel'],
          title: 'Already Completed',
          message: `This spreadsheet was previously completed (${totalRows} records).\n\nStart a new run?`,
        });
        if (choice === 1) {
          updateStatus("Operation cancelled.", false);
          isScrapeRunning = false;
          hasProcessedAnyRow = false;
          event.reply('scrape-finished');
          return;
        }
      }
      // User chose to run again — clear and start fresh
      clearCheckpoint(selectedFile);
      OUTPUT_FILE = path.join(OUTPUT_DIR, `Results_${selectedFile.replace('.csv', '')}_${timestamp()}.csv`);
      addActivity("Starting fresh run (previous run was completed).", 'info');
    } else if (checkpoint) {
      priorCheckpointIndex = checkpoint.lastCompletedIndex;
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Continue from Checkpoint', 'Restart from Beginning', 'Cancel'],
        title: 'Checkpoint Found',
        message: `A checkpoint was found.\nCompleted: ${checkpoint.lastCompletedIndex + 1} records.`,
      });

      if (choice === 2) {
        updateStatus("Operation cancelled.", false);
        isScrapeRunning = false;
        hasProcessedAnyRow = false;
        event.reply('scrape-finished');
        return;
      } else if (choice === 0) {
        startIndex = checkpoint.lastCompletedIndex + 1;
        OUTPUT_FILE = checkpoint.outputFile;
        addActivity("Resuming from checkpoint.", 'info');
      } else {
        clearCheckpoint(selectedFile);
        OUTPUT_FILE = path.join(OUTPUT_DIR, `Results_${selectedFile.replace('.csv', '')}_${timestamp()}.csv`);
        addActivity("Starting fresh run.", 'info');
      }
    } else {
      OUTPUT_FILE = path.join(OUTPUT_DIR, `Results_${selectedFile.replace('.csv', '')}_${timestamp()}.csv`);
    }

    // 4. Read CSV
    const fileContent = fs.readFileSync(INPUT_FILE, "utf8");
    let rawRows = parse(fileContent, { relax_quotes: true, skip_empty_lines: true, trim: true, relax_column_count: true });

    // Detect CSV format by checking header row
    const headerCells = rawRows.length > 0 ? rawRows[0].map(h => h.toLowerCase().trim()) : [];
    const isPriceFinder    = headerCells.includes("imported_address");
    const isOwnershipSearch = !isPriceFinder && headerCells.includes("current owners");

    const rows = isPriceFinder     ? parsePriceFinderCSV(rawRows)
               : isOwnershipSearch ? parseOwnershipSearchCSV(rawRows)
               : rawRows;

    const ownersList = [];
    const ownersByAddress = new Map();
    const groupedResultsByAddress = new Map();
    for (const r of rows) {
      if (!r || r.length < 8) continue;
      for (const o of [r[5], r[6], r[7]]) {
        if (!isEmpty(o) && !isBusiness(o) && !isExcludedOwnerName(o)) {
          ownersList.push({ row: r, owner: o });
          const addressKey = `${normalize(r[0])}|${normalize(r[3])}`;
          if (!ownersByAddress.has(addressKey)) ownersByAddress.set(addressKey, []);
          ownersByAddress.get(addressKey).push(o);
        }
      }
    }

    if (ownersList.length === 0) throw new Error("No valid owners found in this CSV.");
    
    // Set Totals
    stats.total = ownersList.length;
    stats.processed = startIndex;
    sendStats();
    updateProgress();

    // 5. Launch Browser
    updateStatus("Launching browser...", true);
    try {
        browser = await chromium.launch({ headless: !!headlessEnabled, channel: 'chrome' });
    } catch {
        try {
            browser = await chromium.launch({ headless: !!headlessEnabled, channel: 'msedge' });
        } catch {
            throw new Error('No compatible browser found. Please install Google Chrome or Microsoft Edge to use this app.');
        }
    }
    currentBrowser = browser;
    const context = await browser.newContext();

    // 🚀 SPEED OPTIMIZATION: Block unnecessary resources if in Fast Mode
    if (speedMode === 'fast') {
        await context.route('**/*', route => {
            const type = route.request().resourceType();
            if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });
    }

    const page = await context.newPage();

    // Timer
    // Automatically log in using saved credentials
    await ensureLoggedIn(page);

    // If the checkpoint points to a missing output file (e.g. user discarded it),
    // generate a new output file but keep the checkpoint progress.
    if (checkpoint && startIndex > 0 && OUTPUT_FILE && !fs.existsSync(OUTPUT_FILE)) {
        const newOutputFile = path.join(OUTPUT_DIR, `Results_${selectedFile.replace('.csv', '')}_${timestamp()}.csv`);
        OUTPUT_FILE = newOutputFile;
        saveCheckpoint(selectedFile, startIndex - 1, OUTPUT_FILE);
        addActivity("Previous output file was missing. Created a new results file and kept your progress.", "warning");
    }

    const fileExists = fs.existsSync(OUTPUT_FILE);
    // Track where prior session data ends so discard only removes this run's appended rows
    let priorSessionEndOffset = 0;
    if (fileExists && startIndex > 0) {
        priorSessionEndOffset = fs.statSync(OUTPUT_FILE).size;
    }
    stream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });
    if (!fileExists || startIndex === 0) {
      const headerCols = "Original_Name,Original_Address,Match_Status,Found_Name,Found_Mobile,DNCR_Status,Found_Landline,Found_Email,Found_LastSeen,Last_Sold_Date";
      stream.write(absenteeEnabled ? headerCols + ",Absentee_Address\n" : headerCols + "\n");
    }

    // 📊 Google Sheets live output setup
    let sheetsClient = null;
    let sheetsSpreadsheetId = null;
    let sheetsBuffer = [];
    let sheetsFlushInterval = null;

    if (liveSheets) {
        try {
            const tokens = loadGoogleTokens();
            if (!tokens?.refresh_token) throw new Error('Google account not connected');
            const oauth2Client = createOAuth2Client();
            oauth2Client.setCredentials(tokens);
            sheetsClient = google.sheets({ version: 'v4', auth: oauth2Client });

            const savedSheetId = checkpoint?.spreadsheetId;

            if (savedSheetId && startIndex > 0) {
                // ── RESUME: reconnect to the existing sheet, no new header ──
                sheetsSpreadsheetId = savedSheetId;
                const sheetsUrl = checkpoint.sheetsUrl || `https://docs.google.com/spreadsheets/d/${savedSheetId}`;
                mainWindow.webContents.send('sheets-url', sheetsUrl);
                addActivity('Resuming Google Sheets live view — appending to existing sheet.', 'success');
            } else {
                // ── FRESH RUN: create a new sheet and write the header ──
                const drive = google.drive({ version: 'v3', auth: oauth2Client });
                const sheetTitle = `ID4Me Live - ${selectedFile.replace('.csv', '')} ${timestamp()}`;
                const sheet = await sheetsClient.spreadsheets.create({
                    requestBody: { properties: { title: sheetTitle } }
                });
                sheetsSpreadsheetId = sheet.data.spreadsheetId;
                const sheetsUrl = `https://docs.google.com/spreadsheets/d/${sheetsSpreadsheetId}`;
                await drive.permissions.create({
                    fileId: sheetsSpreadsheetId,
                    requestBody: { role: 'reader', type: 'anyone' }
                });
                mainWindow.webContents.send('sheets-url', sheetsUrl);
                // Persist the sheet ID immediately so every subsequent saveCheckpoint keeps it
                saveCheckpoint(selectedFile, startIndex - 1, OUTPUT_FILE, {
                    spreadsheetId: sheetsSpreadsheetId,
                    sheetsUrl
                });
                const headerRow = absenteeEnabled
                    ? ["Original_Name","Original_Address","Match_Status","Found_Name","Found_Mobile","DNCR_Status","Found_Landline","Found_Email","Found_LastSeen","Last_Sold_Date","Absentee_Address"]
                    : ["Original_Name","Original_Address","Match_Status","Found_Name","Found_Mobile","DNCR_Status","Found_Landline","Found_Email","Found_LastSeen","Last_Sold_Date"];
                sheetsBuffer.push(headerRow);
                addActivity('Google Sheets live view created — link shown above.', 'success');
            }

            sheetsFlushInterval = setInterval(() => flushSheetsBuffer(sheetsClient, sheetsSpreadsheetId, sheetsBuffer), 5000);
        } catch (e) {
            addActivity(`Google Sheets setup failed: ${e.message}. Continuing with local CSV only.`, 'warning');
            liveSheets = false;
        }
    }

    const writeRow = (rowArray) => {
        stream.write(stringify([rowArray]));
        if (liveSheets) {
            sheetsBuffer.push(rowArray);
            if (sheetsBuffer.length >= 10) flushSheetsBuffer(sheetsClient, sheetsSpreadsheetId, sheetsBuffer);
        }
    };

      // 6. MAIN PROCESSING LOOP
    for (let i = startIndex; i < stats.total; i++) {
      
      while (isGlobalPaused) {
          if (page && page.isClosed()) break; 
          await new Promise(r => setTimeout(r, 500)); 
      }

      // 🛑 STOP LOGIC (Aborts cleanly)
      if (isGlobalStopped) {
          addActivity(`🛑 Automation stopped manually!`, 'danger');
          updateStatus("Stopped - Session Saved", false);
          // Row i hasn't been processed yet — save i-1 so resume correctly retries row i
          saveCheckpoint(selectedFile, i - 1, OUTPUT_FILE);
          stoppedEarly = true;
          break; // This kicks the script out of the loop completely
      }

      const record = ownersList[i];
      const ownerName = record.owner, address = record.row[0], suburb = record.row[1], postcode = record.row[3];
      const lastSoldDate = normalizeDateString(record.row[4]);

      updateStatus(`Scanning: ${ownerName} (${address})`, true);
      const itemStartTime = Date.now(); // ⏱️ Start Stopwatch

      try {
        await ensureLoggedIn(page);
        await healthCheckAndRefresh(page);

        const addressKey = `${normalize(address)}|${normalize(postcode)}`;
        const coOwners = ownersByAddress.get(addressKey) || [];
        let groupedResults = groupedResultsByAddress.get(addressKey);

        if (!groupedResults) {
            const ownerNames = Array.from(new Set(coOwners.filter(o => !isEmpty(o)).map(o => o.trim())));
            groupedResults = await addressScanGrouped(page, address, postcode, ownerNames, suburb, coOwners);
            if (!groupedResults) {
                // addressScanGrouped already retried internally — this is a genuine failure.
                addActivity(`Rate limit hit scanning ${ownerName}. Pausing app.`, 'danger');
                stoppedEarly = true; break;
            }
            groupedResultsByAddress.set(addressKey, groupedResults);
        }

        let result = groupedResults.get(normalizeLoose(ownerName)) || { status: "NO_MATCH", people: [] };

        if (result.serviceError || result.status === "SERVICE_FAILURE") {
            // SERVICE_FAILURE after all retries — likely a genuine rate limit or outage.
            addActivity(`Rate limit hit scanning ${ownerName}. Pausing app.`, 'danger');
            stoppedEarly = true; break;
        }

        let absenteeResolved = null;
        const hasHomeowner = Array.isArray(result.people) && result.people.some(p => p.Status === "HOMEOWNER");
        const hasRelatives = Array.isArray(result.people) && result.people.some(p => p.Status === "RELATIVE");
        const shouldAbsenteeLookup = absenteeEnabled && (
            result.status === "NO_MATCH" ||
            result.status === "NO_ADDRESS_MATCH" ||
            (!hasHomeowner && hasRelatives)
        );
        if (shouldAbsenteeLookup) {
            if (!hasHomeowner && hasRelatives) {
                addActivity(`Owner missing — relatives found, initiating absentee search for ${ownerName}.`, 'warning');
            }
            updateStatus(`Absentee lookup for ${ownerName}...`, true);
            const propertyState = (record.row[2] || "").trim().toUpperCase() || null;
            absenteeResolved = await resolveAbsenteeOwner(page, ownerName, propertyState);
        }

        
        // New Strict Logic: Skip fallback entirely
        if (result.status === "NO_MATCH") {
            updateStatus(`${ownerName} not found as owner-occupier. Skipping.`, false);
            // It will now naturally drop down to your "Not Found" logger and move to the next row instantly.
        }

        stats.processed++;
        hasProcessedAnyRow = true;

        let handledAbsentee = false;
        if (absenteeResolved && absenteeResolved.resolved) {
            handledAbsentee = true;
            stats.found++;
            addActivity(`${ownerName} - Absentee resolved`, 'success');

            let absenteeDncr = "N/A";
            if (dncrEnabled && absenteeResolved.mobile) {
                const absenteeMobile = absenteeResolved.mobile.replace(/\D/g, '');
                const fakePerson = { Name: ownerName, Mobile: absenteeMobile, Status: RESOLVED_STATUS };
                const enriched = await enrichPeopleWithDncr(page, [fakePerson]);
                absenteeDncr = enriched[0]?.DNCR || "unknown";
            }

            const absenteeAddrCell = absenteeResolved.absenteeAddr || "N/A";
            const absenteeRow = [ownerName, address, RESOLVED_STATUS, ownerName, absenteeResolved.mobile || "N/A", absenteeDncr, "N/A", "N/A", "N/A", lastSoldDate || "N/A"];
            if (absenteeEnabled) absenteeRow.push(absenteeAddrCell);
            writeRow(absenteeRow);
        }

// 🚀 THE FINAL FILTER GATE
        if (!handledAbsentee) {
        let finalPeopleToWrite = result.people;

        if (isStrictHomeownersOnly) {
            // Filter strictly for HOMEOWNER status AND at least one valid mobile number
            finalPeopleToWrite = finalPeopleToWrite.filter(p => {
                if (p.Status !== "HOMEOWNER") return false;
                const phones = (p.AllMobiles || [p.Mobile]).filter(ph => ph && ph.trim() !== "" && ph.toUpperCase() !== "N/A");
                return phones.length > 0;
            });

            // Expand homeowners with multiple phones into one row per phone number
            const expanded = [];
            for (const person of finalPeopleToWrite) {
                const phones = (person.AllMobiles || [person.Mobile]).filter(ph => ph && ph.trim() !== "" && ph.toUpperCase() !== "N/A");
                if (phones.length <= 1) {
                    expanded.push(person);
                } else {
                    for (const phone of phones) {
                        expanded.push({ ...person, Mobile: phone });
                    }
                }
            }
            finalPeopleToWrite = expanded;
        }

        if (!isStrictHomeownersOnly && finalPeopleToWrite.length > 0) {
            const seen = seenRelativesByAddress.get(addressKey) || new Set();
            const deduped = [];
            for (const person of finalPeopleToWrite) {
                if (person.Status !== "RELATIVE") {
                    deduped.push(person);
                    continue;
                }
                const key = buildRelativeKey(person);
                if (seen.has(key)) continue;
                seen.add(key);
                deduped.push(person);
            }
            seenRelativesByAddress.set(addressKey, seen);
            finalPeopleToWrite = deduped;
        }

        if (finalPeopleToWrite.length > 0) {
            if (dncrEnabled) {
                updateStatus(`Checking DNCR status for ${ownerName}...`, true);
                finalPeopleToWrite = await enrichPeopleWithDncr(page, finalPeopleToWrite);
            } else {
                finalPeopleToWrite = finalPeopleToWrite.map(p => ({ ...p, DNCR: "N/A" }));
            }

            stats.found++;
            
            // 🔀 THE OUTPUT FORK: Where is this data going?
            if (outputMode === 'hubspot') {
                // 🚀 Send to CRM
                let crmSettings = { apiKey: '' };
                try { crmSettings = JSON.parse(fs.readFileSync(CRM_FILE, 'utf8')); } catch (e) {}
                
                for (const person of finalPeopleToWrite) {
                    try {
                        await sendToHubSpot(person, address, crmSettings.apiKey);
                        addActivity(`🚀 Beamed ${person.Name} to HubSpot!`, 'success');
                    } catch (apiError) {
                        addActivity(`⚠️ CRM Error for ${person.Name}: ${apiError.message}`, 'warning');
                        // Fallback: If HubSpot rejects it, write it to the CSV so you don't lose the lead!
                        const fallbackRow = [ownerName, address, person.Status, person.Name, person.Mobile, person.DNCR || "N/A", person.Landline, person.Email, person.Last_Seen, lastSoldDate || "N/A"];
                        if (absenteeEnabled) fallbackRow.push("");
                        writeRow(fallbackRow);
                    }
                }
            } else {
                // 📄 Standard Spreadsheet Mode
                addActivity(`${ownerName} - Found (${finalPeopleToWrite.length} matches)`, 'success');
                for (const person of finalPeopleToWrite) {
                    const personRow = [ownerName, address, person.Status, person.Name, person.Mobile, person.DNCR || "N/A", person.Landline, person.Email, person.Last_Seen, lastSoldDate || "N/A"];
                    if (absenteeEnabled) personRow.push("");
                    writeRow(personRow);
                }
            }

        } else {
            // Either no one was found, or everyone got filtered out!
            stats.notFound++;
            
            if (isStrictHomeownersOnly) {
                // In Strict Mode, we DO NOT write junk rows to the CSV. Just log it and skip.
                addActivity(`${ownerName} - Skipped (No valid homeowner mobile)`, 'warning');
            } else {
                // In Normal Mode, we write the NO_MATCH row so they know it was checked.
                addActivity(`${ownerName} - No Match`, 'warning');
                const noMatchRow = [ownerName, address, result.status, "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", lastSoldDate || "N/A"];
                if (absenteeEnabled) noMatchRow.push("");
                writeRow(noMatchRow);
            }
        }
        }

        sendStats();
        
        // ⏱️ Stop Stopwatch & Update ETA
        const itemEndTime = Date.now();
        if (runStartTime === null) runStartTime = itemStartTime;
        const sampleMs = itemEndTime - itemStartTime;
        recentProcessingTimes.push(sampleMs);
        if (recentProcessingTimes.length > 20) recentProcessingTimes.shift();
        // Exponential moving average — low alpha keeps it smooth against outliers
        emaProcessingMs = emaProcessingMs === null
            ? sampleMs
            : (ETA_EMA_ALPHA * sampleMs + (1 - ETA_EMA_ALPHA) * emaProcessingMs);

        updateProgress();
        saveCheckpoint(selectedFile, i, OUTPUT_FILE);

      } catch (rowError) {
        const errMsg = rowError.message || "";
        
        // 🛑 THE SAFE AUTH KILL SWITCH
        if (errMsg.includes("Incorrect Login Details")) {
            addActivity(`Authentication Failed: Please verify your ID4Me credentials in the sidebar.`, 'danger');
            updateStatus("Session Aborted - Invalid Login", false);
            // Row i failed without writing output — save i-1 so resume retries row i
            saveCheckpoint(selectedFile, i - 1, OUTPUT_FILE);
            stoppedEarly = true;

            // Just break the loop! Do NOT close the browser here or it causes a deadlock!
            break;
        }


        // 🛑 Error 23: Multiple Sessions Detected
        let isSessionConflict = false;
        if (page && !page.isClosed()) {
            isSessionConflict = await page.getByText(/Multiple active sessions/i).isVisible({ timeout: 1000 }).catch(() => false);
        }

        if (isSessionConflict) {
            addActivity(`🛑 Error 23: Multiple active sessions detected!`, 'danger');
            updateStatus("Session Conflict - Automation Paused", false);
            saveCheckpoint(selectedFile, i - 1, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        // 🛑 Target Closed by User
        if (errMsg.includes("Target closed") || errMsg.includes("browser has been closed") || (page && page.isClosed())) {
            addActivity(`🛑 Browser was closed manually! Automation paused.`, 'danger');
            updateStatus("Browser Closed - Session Saved", false);
            saveCheckpoint(selectedFile, i - 1, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        // 🌐 Network Failure Detected
        if (isNetworkFailure(errMsg)) {
            addActivity(`🌐 Network failure detected. Session saved.`, 'danger');
            updateStatus("Network Lost - Session Saved", false);
            saveCheckpoint(selectedFile, i - 1, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        stats.processed++;
        stats.errors++;
        addActivity(`${ownerName} - Script Error`, 'danger');
        const errorRow = [ownerName, address, "SCRIPT_ERROR", errMsg, "N/A", "N/A", "N/A", "N/A", "N/A", lastSoldDate || "N/A"];
        if (absenteeEnabled) errorRow.push("");
        writeRow(errorRow);
        
        sendStats();
        updateProgress();
        saveCheckpoint(selectedFile, i, OUTPUT_FILE);
        
        try { if (!page.isClosed()) await page.reload(); } catch (e) {}
        continue;
      }
      // 🚀 BRAKES REMOVED: No artificial delay between owners
      if (speedMode !== 'fast') {
          await randomDelay(BETWEEN_OWNERS_MIN, BETWEEN_OWNERS_MAX);
      }
    }
    
    await new Promise((resolve) => stream.end(resolve));

    // Flush any remaining Sheets rows and clean up
    if (sheetsFlushInterval) clearInterval(sheetsFlushInterval);
    if (liveSheets) await flushSheetsBuffer(sheetsClient, sheetsSpreadsheetId, sheetsBuffer);
    if (mainWindow) mainWindow.webContents.send('sheets-url', null);

    if (stoppedEarly) {
        updateStatus("Automation stopped early. Your progress is saved.", false);

        if (outputMode === 'csv' && OUTPUT_FILE && fs.existsSync(OUTPUT_FILE)) {
            const shouldSaveCsv = await askWhetherToSaveSessionCsv(OUTPUT_FILE, priorSessionEndOffset > 0);
            if (!shouldSaveCsv) {
                try {
                    if (priorSessionEndOffset > 0) {
                        // Resumed session: truncate back to where prior session ended,
                        // preserving run 1's data. Only this run's appended rows are removed.
                        fs.truncateSync(OUTPUT_FILE, priorSessionEndOffset);
                        saveCheckpoint(selectedFile, priorCheckpointIndex, OUTPUT_FILE);
                        addActivity("This session's data discarded. Prior session results preserved.", "warning");
                    } else {
                        // Fresh run with no prior data: safe to delete the whole file.
                        fs.unlinkSync(OUTPUT_FILE);
                        addActivity("Session CSV discarded by user. Progress kept.", "warning");
                    }
                    updateStatus("Session stopped early. CSV discarded, progress kept.", false);
                } catch (e) {
                    addActivity(`Could not discard CSV: ${e.message}`, "danger");
                }
            } else {
                updateStatus("Cleaning up duplicates...", true);
                const removed = deduplicateOutputCsv(OUTPUT_FILE);
                if (removed > 0) addActivity(`Removed ${removed} duplicate record${removed !== 1 ? 's' : ''} from output.`, 'info');
                addActivity(`Session CSV saved: ${path.basename(OUTPUT_FILE)}`, "success");
            }
        }
    } else {
        updateStatus("Cleaning up duplicates...", true);
        if (outputMode === 'csv' && OUTPUT_FILE && fs.existsSync(OUTPUT_FILE)) {
            const removed = deduplicateOutputCsv(OUTPUT_FILE);
            if (removed > 0) addActivity(`Removed ${removed} duplicate record${removed !== 1 ? 's' : ''} from output.`, 'info');
        }
        updateStatus("Job Complete!", false);
        addActivity("Finished processing all records successfully.", 'info');
        // Save a "completed" marker so re-opening this CSV shows a one-time notice
        saveCheckpoint(selectedFile, ownersList.length - 1, OUTPUT_FILE, { completed: true, totalRows: ownersList.length });
    }
    
    if (browser && browser.isConnected()) await browser.close();
    currentBrowser = null;
    currentBrowser = null;
    isScrapeRunning = false;
    hasProcessedAnyRow = false;
    event.reply('scrape-finished');

  } catch (error) {
    updateStatus(`Fatal Error: ${error.message}`, false);
    if (sheetsFlushInterval) clearInterval(sheetsFlushInterval);
    if (mainWindow) mainWindow.webContents.send('sheets-url', null);
    if (stream) {
        try { await new Promise((resolve) => stream.end(resolve)); } catch (e) {}
    }
    if (outputMode === 'csv' && OUTPUT_FILE && fs.existsSync(OUTPUT_FILE)) {
        const shouldSaveCsv = await askWhetherToSaveSessionCsv(OUTPUT_FILE);
        if (!shouldSaveCsv) {
            try {
                fs.unlinkSync(OUTPUT_FILE);
                if (selectedFile) clearCheckpoint(selectedFile);
                addActivity("Session CSV discarded after fatal stop.", "warning");
            } catch (e) {
                addActivity(`Could not discard CSV after fatal stop: ${e.message}`, "danger");
            }
        } else {
            addActivity(`Session CSV saved after fatal stop: ${path.basename(OUTPUT_FILE)}`, "success");
        }
    }
    if (browser && browser.isConnected()) await browser.close();
    isScrapeRunning = false;
    hasProcessedAnyRow = false;
    event.reply('scrape-finished');
  }
});



