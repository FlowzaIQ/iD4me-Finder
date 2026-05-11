const { chromium } = require("playwright");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TEST_ADDRESS = "6 BEAUTY POINT CRESCENT";
const TEST_POSTCODE = "2750";
// ──────────────────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://id4me.me/search");

  console.log("=================================================");
  console.log("⏳  Log in now. Script resumes in 20 seconds...");
  console.log("=================================================");
  for (let i = 20; i > 0; i--) {
    process.stdout.write(`\r${i}s remaining... `);
    await sleep(1000);
  }
  console.log("\n\n✅ Starting test...\n");

  // ── STEP 1: Type address into search bar ──────────────────────────────────
  console.log(`[1] Typing address: ${TEST_ADDRESS}`);
  const combo = page.getByRole("combobox", { name: /search/i });
  await combo.click({ timeout: 5000 });
  await combo.fill(TEST_ADDRESS);
  await combo.press("Enter");
  await sleep(1500);

  // ── STEP 2: Type postcode ─────────────────────────────────────────────────
  console.log(`[2] Typing postcode: ${TEST_POSTCODE}`);
  const inp = page.locator('input[type="search"]');
  await inp.click();
  await inp.fill(TEST_POSTCODE);
  await inp.press("Enter");
  await sleep(2000);

  console.log("[3] Search done. Now logging what's in the DOM before clearing...\n");

  // ── STEP 3: Log chip state before clearing ────────────────────────────────
  const chipsBefore = await page.evaluate(() => {
    const chips = document.querySelectorAll('.MuiChip-root');
    return Array.from(chips).map(c => c.innerText.trim());
  });
  console.log(`Chips found before clear: ${JSON.stringify(chipsBefore)}`);

  const clearBtnBefore = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Clear"]');
    if (!btn) return "NOT FOUND";
    const style = window.getComputedStyle(btn);
    return `FOUND — visibility:${style.visibility} opacity:${style.opacity} display:${style.display}`;
  });
  console.log(`Clear button state: ${clearBtnBefore}`);

  const deleteIconsBefore = await page.evaluate(() => {
    return document.querySelectorAll('.MuiChip-deleteIcon').length;
  });
  console.log(`MuiChip-deleteIcon count: ${deleteIconsBefore}\n`);

  // ── STEP 4: Attempt clear via Backspace ──────────────────────────────────
  console.log("[4] Attempting clear via Backspace x2 on the search input...");
  await page.locator('input[type="search"]').click();
  await page.keyboard.press('Backspace');
  await sleep(300);
  await page.keyboard.press('Backspace');
  await sleep(1000);

  const chipsAfterJs = await page.evaluate(() => {
    return document.querySelectorAll('.MuiChip-root').length;
  });
  console.log(`Chips remaining after JS clear: ${chipsAfterJs}`);

  // ── STEP 5: If chips still there, try aria-label button ───────────────────
  if (chipsAfterJs > 0) {
    console.log("\n[5] JS click didn't clear. Trying button[aria-label='Clear'] with force...");
    await page.locator('input[type="search"]').hover().catch(() => {});
    await sleep(300);
    await page.locator('button[aria-label="Clear"]').click({ force: true, timeout: 3000 }).catch(e => {
      console.log(`   aria-label click failed: ${e.message}`);
    });
    await sleep(1000);

    const chipsAfterBtn = await page.evaluate(() => {
      return document.querySelectorAll('.MuiChip-root').length;
    });
    console.log(`Chips remaining after button click: ${chipsAfterBtn}`);
  }

  // ── STEP 6: Final state ───────────────────────────────────────────────────
  const finalChips = await page.evaluate(() => {
    const chips = document.querySelectorAll('.MuiChip-root');
    return Array.from(chips).map(c => c.innerText.trim());
  });
  console.log(`\nFinal chip state: ${JSON.stringify(finalChips)}`);

  if (finalChips.length === 0) {
    console.log("\n✅ SUCCESS — search bar fully cleared.");
  } else {
    console.log("\n❌ FAILED — chips still present after all attempts.");
  }

  console.log("\nKeeping browser open for 15 seconds so you can inspect...");
  await sleep(15000);
  await browser.close();
}

main().catch(console.error);
