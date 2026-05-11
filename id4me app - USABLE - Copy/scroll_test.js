const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  // TODO: Update these to your real credentials.
  const EMAIL = process.env.ID4ME_EMAIL || "tonyh@synergyrealtor.com.au" ;
  const PASSWORD = process.env.ID4ME_PASSWORD || "Synergy2750$";

  await page.goto('https://id4me.biz/');
  await page.getByRole('link', { name: 'Login' }).click();
  await page.locator('#loginemail').fill(EMAIL);
  await page.locator('#loginpassword').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Switch from Smart Search to Search (if available)
  const searchMode = page.getByRole('combobox', { name: /search/i }).first();
  if (await searchMode.count() > 0) {
    await searchMode.click().catch(() => {});
    await page.getByRole('option', { name: /search/i }).first().click().catch(() => {});
  }

  // Search for address: 6 ABBEY ROW
  const searchInput = page.locator('input[type="search"]').first();
  await searchInput.waitFor({ timeout: 15000, state: 'visible' });
  await searchInput.click();
  await searchInput.fill('6 ABBEY ROW');
  await searchInput.press('Enter');
  await page.waitForTimeout(400); 

  // Click the column separator, then scroll using ArrowDown on body.
  const separator = page.locator('div:nth-child(6) > .MuiDataGrid-columnSeparator');
  if (await separator.count() > 0) {
    await separator.first().click().catch(() => {});
  }

  let lastRowText = "";
  for (let i = 0; i < 120; i++) {
    await page.locator('body').press('ArrowDown').catch(() => {});
    await page.waitForTimeout(80);

    const rows = page.getByRole('row');
    const count = await rows.count();
    if (count > 1) {
      const lastRow = rows.nth(count - 1);
      const text = await lastRow.innerText().catch(() => "");
      if (text && text === lastRowText) {
        // Possibly reached end; keep going a bit to confirm.
      } else if (text) {
        lastRowText = text;
      }
    }
  }

  // Keep the browser open for manual observation.
  await page.pause();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
