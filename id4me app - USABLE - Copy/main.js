const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
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
        systemInstruction: `You are an emotionless, highly strict data auditing AI. Your ONLY job is to classify names into HOMEOWNER or RELATIVE based purely on exact surname matches.
        
🎯 CORE LOGIC ENGINE:
Step 1: Identify the LAST NAME (surname) of the Target Name. This is your absolute anchor.
Step 2: Scan the Scraped Names list. If a name does NOT contain that exact surname, DELETE it from your memory.
Step 3: For the surviving names containing the surname:
    - If it matches the Target Name's exact first name or first initial, classify as HOMEOWNER.
    - If it has the exact same surname but a different first name, classify as RELATIVE.
    - If the Target Name is ONLY a surname (e.g., "CODY"), classify everyone with that surname as HOMEOWNER.

🚫 ZERO-TOLERANCE RULES:
- NEVER match a person just because they share a first name. The surname is all that matters.
- NEVER assume nicknames ("Jake" does not equal "Jacob"). Exact text matches only.
- NEVER return a name that was not physically in the Scraped Names list.

❌ EXAMPLES OF FATAL ERRORS YOU MUST AVOID:
- Target: "CLIFFORD DAVID LLEWELLYN JENKINS" | Scraped: "Engel Holmes, Brigid Holmes" -> ERROR! The surname is Jenkins. Holmes is wrong. Output MUST be: NO_MATCH
- Target: "GRAHAM CHARLES EVANS" | Scraped: "Graham Wilkins, Graham Charles Wilkins" -> ERROR! You matched the first name 'Graham' but ignored that the surname is Evans. Output MUST be: NO_MATCH

OUTPUT FORMAT:
- Return ONLY a pipe-separated list of exact scraped names with their classification using '==='.
- Example Output: "Jake Tran===HOMEOWNER | Lisa Tran===RELATIVE"
- If absolutely no one in the list shares the target surname, you MUST reply exactly with: NO_MATCH`
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
const ETA_EMA_ALPHA = 0.2;
const ETA_WARMUP_SAMPLES = 5;
let isGlobalPaused = false;     
let isGlobalStopped = false; 
let isScrapeRunning = false;
let hasProcessedAnyRow = false;
let currentBrowser = null;
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
        systemInstruction: `You are a strict data auditing AI. Classify each target name against the scraped names list using exact surname rules.

RULES:
- Use ONLY names that appear in the Scraped Names list.
- Classify each matched name as HOMEOWNER or RELATIVE using the same logic as before.
- If no matches for a target, return an empty matches array.

OUTPUT:
Return ONLY valid JSON with this shape:
{"targets":[{"target":"Full Target Name","matches":[{"name":"Exact Scraped Name","role":"HOMEOWNER"}]}]}
No extra text.`
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
            const etaMs = emaProcessingMs * remainingItems;
            
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

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getCheckpointFile(csvFilename) {
  const safeName = path.basename(csvFilename).replace('.csv', '').replace(/[^a-z0-9]/gi, '_');
  return path.join(BASE_DIR, `.checkpoint_${safeName}.json`);
}

function saveCheckpoint(csvFilename, index, outputFile) {
  const checkpointFile = getCheckpointFile(csvFilename);
  const tempFile = `${checkpointFile}.tmp`; 
  const data = { lastCompletedIndex: index, outputFile: outputFile, savedAt: new Date().toISOString() };
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

async function askWhetherToSaveSessionCsv(outputFile) {
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
      fileName: path.basename(outputFile)
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/T/, "_").replace(/:/g, "-").replace(/\..+/, "");
}

/* ==================================================
   UTILITIES & SCORING
================================================== */
const randomDelay = (min, max) => new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
const normalize = txt => (txt || "").toUpperCase().replace(/\s+/g, " ").trim();
const normalizeLoose = txt => (txt || "").toLowerCase().replace(/\s+/g, " ").trim();
const normalizePhone = txt => (txt || "").replace(/\D/g, "");
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
  return ["PTY", "PTY LTD", "LTD", "LIMITED", "NOMINEES", "HOLDINGS", "TRUST", "TRUSTEE", "COUNCIL", "STATE OF", "CITY OF", "INC", "CORP", "GOVERNMENT", "ARCHBISHOP", "UNITING CHURCH", "ABORIGINAL HOUSING", "PROPRIETORS OF SP", "STRATA PLAN", "BODY CORPORATE", "OWNERS CORPORATION", "HOUSING COMMISSION", "DEPARTMENT OF", "MINISTER FOR", "TOWN OF", "CROWN"].some(b => n.includes(b));
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
      Landline: w.landline, 
      Email: w.email, 
      Last_Seen: w.lastSeen 
  }));
}

/* ==================================================
   PLAYWRIGHT PAGE LOGIC
================================================== */
let searchCounter = 0;
const REFRESH_PAGE_EVERY = 50;

async function waitForPageReady(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    await page.waitForSelector('input[type="search"]', { timeout: 10000, state: 'visible' });
    await randomDelay(500, 800);
  } catch (e) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('input[type="search"]', { timeout: 15000, state: 'visible' });
      await randomDelay(1000, 1500);
    }
  }
}

async function ensureNormalSearch(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");

    // If already in normal search mode, nothing to do.
    const normalModeBtn = page.getByRole('button', { name: /^search$/i }).first();
    if (await normalModeBtn.isVisible().catch(() => false)) return true;

    // If smart search is visible, switch via the split-button dropdown.
    const smartModeBtn = page.getByRole('button', { name: /smart search/i }).first();
    if (await smartModeBtn.isVisible().catch(() => false)) {
      const dropdown = page.getByTestId('split-button-dropdown-button');
      if (await dropdown.count() > 0) {
        await dropdown.click({ timeout: 3000 });
        const normalItem = page.getByRole('menuitem', { name: 'Search', exact: true });
        if (await normalItem.count() > 0) {
          await normalItem.click({ timeout: 3000 });
          await randomDelay(400, 700);
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
  if (searchCounter % REFRESH_PAGE_EVERY === 0) {
    updateStatus(`Performing health refresh (${searchCounter} done)...`, true);
    if (!page.isClosed()) {
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await waitForPageReady(page);
      await randomDelay(2000, 3000);
    }
  }
}

async function clearSearch(page) {
  try {
    if (page.isClosed()) throw new Error("Target closed");
    const btn = page.getByRole("button", { name: "Clear" });
    if (await btn.count() > 0) {
      await btn.click({ timeout: 5000 });
      await randomDelay(DELAY_MIN, DELAY_MAX);
      await waitForPageReady(page);
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
    await randomDelay(2000, 3000);
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
                const mobile = (await cells.nth(6).innerText({ timeout: 500 }).catch(() => "")).split("\n")[0].trim();
                const email = await cells.nth(7).innerText({ timeout: 500 }).catch(() => "");
                const landline = (await cells.nth(8).innerText({ timeout: 500 }).catch(() => "")).split("\n")[0].trim();
                const lastSeen = await cells.nth(9).innerText({ timeout: 500 }).catch(() => "");
                
                if (!name) continue;

                const key = `${normalizeLoose(name)}|${normalizeLoose(addr)}|${normalizePhone(mobile)}|${normalizePhone(landline)}|${normalizeLoose(email)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ name, addr, mobile, email, landline, lastSeen });
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
        
        // 5. If we are at the bottom and nothing new has appeared for 5 straight cycles, we are done.
        if (stagnantScrolls >= 5) {
            break;
        }

        await page.waitForSelector('div[role="row"]', { state: 'attached', timeout: isFastMode() ? 800 : 2000 }).catch(() => {});
        await page.waitForTimeout(isFastMode() ? 80 : 200); // Brief wait for new rows to render
    }

    return { success: true, data: out };

  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    if (retryCount < 2) {
      await randomDelay(2000, 3000);
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
  if (await scrollBox.count() > 0) {
      await scrollBox.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }).catch(() => {});
      await page.waitForTimeout(100);
  }

  for (let i = 0; i < 60; i++) {
      if (pendingChecks.size === 0) break;

      const rows = page.locator('div[role="row"]');
      const rowCount = await rows.count();

      // Get the names we are currently looking for in this pass
      const namesWeAreLookingFor = Array.from(pendingChecks.values()).map(p => p.Name).join(', ');
      addActivity(`Scanning ${rowCount} rows on screen. Looking for: ${namesWeAreLookingFor}`, 'info');

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
              
              // New, more robust check
              if (rowTextForLogging.toLowerCase().includes(nameToFind.toLowerCase()) && (rowTextForLogging.includes(mobile) || digitMatch)) {
                  addActivity(`MATCH FOUND for ${nameToFind} in row text.`, 'success');
                  await row.scrollIntoViewIfNeeded().catch(() => {});
                  await row.hover({ timeout: 1000 }).catch(() => {});

                  const icon = row.locator('button:has([data-testid="PhoneIphoneOutlinedIcon"]), button:has([data-testid="PhoneOutlinedIcon"]), [data-testid="PhoneIphoneOutlinedIcon"], [data-testid="PhoneOutlinedIcon"]').first();
                  
                  if (await icon.count() > 0) {
                      addActivity(`Phone icon found for ${person.Name}. Attempting to trigger tooltip.`, 'info');
                      
                      try {
                          const iconButton = icon.locator('xpath=ancestor::button[1]');
                          const hoverTarget = (await iconButton.count()) > 0 ? iconButton : icon;

                          await hoverTarget.hover({ timeout: 1000 });
                          const box = await hoverTarget.boundingBox().catch(() => null);
                          if (box) {
                              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
                          }
                      } catch (interactionError) {
                          addActivity(`Hover failed for ${person.Name}. Trying JS events.`, 'warning');
                          await icon.evaluate(node => {
                              node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                              node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                          }).catch(jsError => addActivity(`JS dispatch failed: ${jsError.message}`, 'danger'));
                      }
                      
                      await page.waitForTimeout(800);

                      let status = "unknown";
                      const tooltip = page.locator('[role="tooltip"], .MuiTooltip-popper').first();

                      await page.waitForSelector('[role="tooltip"], .MuiTooltip-popper', { state: 'visible', timeout: 1500 }).catch(() => {});

                      if (await tooltip.count() > 0) {
                          const tooltipText = await tooltip.innerText().catch(() => "COULD_NOT_READ_TOOLTIP");
                          addActivity(`Tooltip text for ${person.Name}: "${tooltipText}"`, 'info');
                          if (tooltipText.includes("Can Call")) status = "callable";
                          else if (tooltipText.includes("Cannot Call")) status = "blocked";
                          else if (tooltipText.includes("Expired")) status = "expired";
                      } else {
                          addActivity(`No tooltip element found for ${person.Name}.`, 'warning');
                      }
                      
                      if (status === "unknown") {
                          const attemptCount = (dncrAttempts.get(uniqueKey) || 0) + 1;
                          dncrAttempts.set(uniqueKey, attemptCount);
                          if (attemptCount >= 3) {
                              addActivity(`DNCR status still unknown for ${person.Name}. Reached ${attemptCount}/3; defaulting to 'unknown'.`, 'danger');
                              await page.mouse.move(0, 0).catch(() => {});
                              await page.keyboard.press('Escape').catch(() => {});
                              enrichedPeople.push({ ...person, DNCR: "unknown" });
                              pendingChecks.delete(uniqueKey);
                          } else {
                              addActivity(`DNCR status still unknown for ${person.Name}. Attempt ${attemptCount}/3; will retry.`, 'warning');
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
      
      if (pendingChecks.size > 0 && await scrollBox.count() > 0) {
          const step = isFastMode() ? 600 : 360;
          await scrollBox.evaluate((el, scrollStep) => { el.scrollBy(0, scrollStep); el.dispatchEvent(new Event('scroll')); }, step).catch(() => {});
          await page.waitForTimeout(isFastMode() ? 100 : 200);
      }
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
    const cacheKey = `${address}_${postcode}`.toLowerCase();
    let rows;

    if (globalAddressCache.has(cacheKey)) {
        // We already searched this address recently! Pull the data from memory.
        rows = globalAddressCache.get(cacheKey);
        addActivity(`Memory: Skipped typing, loaded ${address} from cache.`, 'info');
    } else {
        // We haven't seen this address yet. Use the browser to search it.
        await clearSearch(page);
        await addFirstChip(page, address);
        await addChip(page, postcode);
        
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

// 3. Ask the AI to classify Homeowners and Relatives
    updateStatus(`AI is classifying family for ${ownerName}...`, true);
    const aiMatchedString = await aiNameMatch(ownerName, rows);
    
    if (aiMatchedString === "NO_MATCH") return { status: "NO_MATCH", people: [] };

    // Break down the AI's new tagged list: "Name===ROLE | Name===ROLE"
    const aiClassifications = parseAiClassificationString(aiMatchedString);

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
    const rowsResult = await getRows(page);
    if (!rowsResult.success) return { success: false, data: [], error: "SERVICE_FAILURE", errorMessage: rowsResult.errorMessage || "" };
    return { success: true, data: rowsResult.data };
  } catch (error) {
    if (page && page.isClosed()) throw new Error("Target closed");
    return { success: false, data: [], error: "SERVICE_FAILURE", errorMessage: error.message || "" };
  }
}

async function resolveAbsenteeOwner(page, ownerName) {
  const attempts = generateNameVariations(ownerName);
  for (const attemptName of attempts) {
    addActivity(`Absentee lookup: searching "${attemptName}"`, 'info');
    const rowsResult = await searchId4meByName(page, attemptName);
    if (!rowsResult.success) {
      addActivity(`Absentee lookup failed for "${attemptName}" (service error).`, 'warning');
      return { resolved: false, skipped: true, reason: "service_failure" };
    }

    const rows = rowsResult.data || [];
    addActivity(`Absentee lookup: "${attemptName}" returned ${rows.length} results`, 'info');

    const decision = evaluateAbsenteeResolution(rows, {
      maxResultCount: MAX_RESULT_COUNT
    });

    if (decision.resolved) {
      addActivity(`Absentee resolved for ${ownerName}: ${decision.mobile}`, 'success');
      return { resolved: true, mobile: decision.mobile };
    }

    if (decision.reason === "no_results") {
      continue; // Try next name variation
    }

    if (decision.reason === "too_many_results" || decision.reason === "no_mobile") {
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

    const cacheKey = `${address}_${postcode}`.toLowerCase();
    let rows;

    if (globalAddressCache.has(cacheKey)) {
        rows = globalAddressCache.get(cacheKey);
        addActivity(`Memory: Skipped typing, loaded ${address} from cache.`, 'info');
    } else {
        await clearSearch(page);
        await addFirstChip(page, address);
        await addChip(page, postcode);
        
        updateStatus(`Waiting for ID4Me to load ${address}...`, true);
        await page.waitForSelector('.MuiDataGrid-row, div[role="row"]', { state: 'attached', timeout: isFastMode() ? 3000 : 5000 }).catch(() => {});
        await page.waitForTimeout(isFastMode() ? 100 : 300);
        
        updateStatus(`Scraping all residents for ${address}...`, true);
        const rowsResult = await getRows(page);
    
        if (!rowsResult.success) return null;
        
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

    updateStatus(`AI is classifying family for ${ownerList.join(", ")}...`, true);
    let groupedClassifications = await aiNameMatchGrouped(ownerList, rows);

    if (!groupedClassifications) {
        groupedClassifications = {};
        for (const ownerName of ownerList) {
            const aiMatchedString = await aiNameMatch(ownerName, rows);
            groupedClassifications[normalizeLoose(ownerName)] = parseAiClassificationString(aiMatchedString);
        }
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
    await page.goto("https://id4me.me/search", { timeout: 15000 });
    if (page.url().includes("auth0.com") || page.url().includes("login")) {
        await performLogin(page);
    }
    await ensureNormalSearch(page);
  } catch (e) { 
    // 🛑 Pass the grenade directly to the main loop! Don't swallow it!
    if (e.message === "Incorrect Login Details") throw e; 
    
    if (page && page.isClosed()) throw new Error("Target closed");
  }
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
ipcMain.on('start-scrape', async (event, speedMode, isStrictHomeownersOnly, outputMode, dncrEnabled = false, absenteeEnabled = false, headlessEnabled = false) => {
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
        DELAY_MIN = 1200; DELAY_MAX = 2000;
        BETWEEN_OWNERS_MIN = 3500; BETWEEN_OWNERS_MAX = 5500;
        addActivity("🚶 Normal Mode selected", "info");
    }

    // Reset Global UI Variables
    stats = { total: 0, processed: 0, found: 0, notFound: 0, errors: 0 };
        recentProcessingTimes = []; 
        emaProcessingMs = null;
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

    // 3. Checkpoint Logic
    checkpoint = loadCheckpoint(selectedFile);
    if (checkpoint) {
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
    const rows = parse(fileContent, { relax_quotes: true, skip_empty_lines: true, trim: true, relax_column_count: true });
    
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
    browser = await chromium.launch({ headless: !!headlessEnabled, channel: 'chrome' });
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
    stream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });
    if (!fileExists || startIndex === 0) {
      stream.write("Original_Name,Original_Address,Match_Status,Found_Name,Found_Mobile,DNCR_Status,Found_Landline,Found_Email,Found_LastSeen,Last_Sold_Date\n");
    }

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
          saveCheckpoint(selectedFile, i, OUTPUT_FILE);
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
                addActivity(`Rate limit hit scanning ${ownerName}. Pausing app.`, 'danger');
                stoppedEarly = true; break;
            }
            groupedResultsByAddress.set(addressKey, groupedResults);
        }

        let result = groupedResults.get(normalizeLoose(ownerName)) || { status: "NO_MATCH", people: [] };

        if (result.serviceError || result.status === "SERVICE_FAILURE") {
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
            absenteeResolved = await resolveAbsenteeOwner(page, ownerName);
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
            stream.write(stringify([[ownerName, address, RESOLVED_STATUS, ownerName, absenteeResolved.mobile || "N/A", "N/A", "N/A", "N/A", "N/A", lastSoldDate || "N/A"]]));
        }

// 🚀 THE FINAL FILTER GATE
        if (!handledAbsentee) {
        let finalPeopleToWrite = result.people;

        if (isStrictHomeownersOnly) {
            // Filter strictly for HOMEOWNER status AND a valid mobile number
            finalPeopleToWrite = finalPeopleToWrite.filter(p => 
                p.Status === "HOMEOWNER" && 
                p.Mobile && 
                p.Mobile.trim() !== "" && 
                p.Mobile.toUpperCase() !== "N/A"
            );
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
                        stream.write(stringify([[ownerName, address, person.Status, person.Name, person.Mobile, person.DNCR || "N/A", person.Landline, person.Email, person.Last_Seen, lastSoldDate || "N/A"]]));
                    }
                }
            } else {
                // 📄 Standard Spreadsheet Mode
                addActivity(`${ownerName} - Found (${finalPeopleToWrite.length} matches)`, 'success');
                for (const person of finalPeopleToWrite) {
                    stream.write(stringify([[ownerName, address, person.Status, person.Name, person.Mobile, person.DNCR || "N/A", person.Landline, person.Email, person.Last_Seen, lastSoldDate || "N/A"]]));
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
                stream.write(stringify([[ownerName, address, result.status, "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", lastSoldDate || "N/A"]]));
            }
        }
        }

        sendStats();
        
        // ⏱️ Stop Stopwatch & Update ETA
        const itemEndTime = Date.now();
        const sampleMs = itemEndTime - itemStartTime;
        recentProcessingTimes.push(sampleMs);
        if (recentProcessingTimes.length > 10) recentProcessingTimes.shift(); 
        // Exponential moving average for smoother ETA
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
            saveCheckpoint(selectedFile, i, OUTPUT_FILE);
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
            saveCheckpoint(selectedFile, i, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        // 🛑 Target Closed by User
        if (errMsg.includes("Target closed") || errMsg.includes("browser has been closed") || (page && page.isClosed())) {
            addActivity(`🛑 Browser was closed manually! Automation paused.`, 'danger');
            updateStatus("Browser Closed - Session Saved", false);
            saveCheckpoint(selectedFile, i, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        // 🌐 Network Failure Detected
        if (isNetworkFailure(errMsg)) {
            addActivity(`🌐 Network failure detected. Session saved.`, 'danger');
            updateStatus("Network Lost - Session Saved", false);
            saveCheckpoint(selectedFile, i, OUTPUT_FILE);
            stoppedEarly = true;
            break;
        }

        stats.processed++;
        stats.errors++;
        addActivity(`${ownerName} - Script Error`, 'danger');
        stream.write(stringify([[ownerName, address, "SCRIPT_ERROR", errMsg, "N/A", "N/A", "N/A", "N/A", "N/A", lastSoldDate || "N/A"]]));
        
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
    
    if (stoppedEarly) {
        updateStatus("Automation stopped early. Your progress is saved.", false);

        if (outputMode === 'csv' && OUTPUT_FILE && fs.existsSync(OUTPUT_FILE)) {
            const shouldSaveCsv = await askWhetherToSaveSessionCsv(OUTPUT_FILE);
            if (!shouldSaveCsv) {
                try {
                    fs.unlinkSync(OUTPUT_FILE);
                    // Keep the checkpoint even if the CSV is discarded so progress isn't lost.
                    addActivity("Session CSV discarded by user. Progress kept.", "warning");
                    updateStatus("Session stopped early. CSV discarded, progress kept.", false);
                } catch (e) {
                    addActivity(`Could not discard CSV: ${e.message}`, "danger");
                }
            } else {
                addActivity(`Session CSV saved: ${path.basename(OUTPUT_FILE)}`, "success");
            }
        }
    } else {
        updateStatus("Job Complete!", false);
        addActivity("Finished processing all records successfully.", 'info');
        clearCheckpoint(selectedFile);
    }
    
    if (browser && browser.isConnected()) await browser.close();
    currentBrowser = null;
    currentBrowser = null;
    isScrapeRunning = false;
    hasProcessedAnyRow = false;
    event.reply('scrape-finished');

  } catch (error) {
    updateStatus(`Fatal Error: ${error.message}`, false);
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



