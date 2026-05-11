const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.google.com/');
  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill('cats');
  await searchBox.press('Enter');
  await page.waitForLoadState('networkidle');

  // Scroll to bottom
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(150);
  }

  await page.pause();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
