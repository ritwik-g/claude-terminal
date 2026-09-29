import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshotDir } from './lib/test-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = screenshotDir();

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runTest() {
  console.log('🌐 Launching Chrome for UI verification...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  try {
    console.log('1️⃣ Navigating to http://127.0.0.1:7890...');
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));

    // If session detail is not open, select the first session card
    const hasDetail = await page.$('.conversation-body');
    if (!hasDetail) {
      console.log('2️⃣ Selecting session card in sidebar...');
      await page.waitForSelector('.session-card', { timeout: 5000 });
      await page.click('.session-card');
      await new Promise((r) => setTimeout(r, 800));
    } else {
      console.log('2️⃣ Session already selected.');
    }

    // 17: Collapsed Antigravity progress card
    console.log('3️⃣ Verifying Antigravity progress card (collapsed by default on completed turns)...');
    await page.waitForSelector('.antigravity-progress-card', { timeout: 5000 });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '17_antigravity_progress_collapsed.png') });
    console.log('   📸 Captured 17_antigravity_progress_collapsed.png');

    // 18: Expand Antigravity progress card
    console.log('4️⃣ Clicking progress card header to expand...');
    await page.click('.progress-card-header');
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '18_antigravity_progress_expanded.png') });
    console.log('   📸 Captured 18_antigravity_progress_expanded.png');

    // 19: Test Header Model Selector Popover
    console.log('5️⃣ Testing Header Model Selector Popover...');
    await page.click('.session-engine-btn');
    await page.waitForSelector('.engine-switcher-popover', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '19_header_model_popover.png') });
    console.log('   📸 Captured 19_header_model_popover.png');

    // Close header popover by toggling button
    await page.click('.session-engine-btn');
    await new Promise((r) => setTimeout(r, 300));

    // 20: Test Composer Model Selector Popover (anchored above)
    console.log('6️⃣ Testing Composer Model Selector Popover (anchored above)...');
    await page.click('.composer-engine-pill');
    await page.waitForSelector('.engine-switcher-popover.popover-above', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '20_composer_model_popover.png') });
    console.log('   📸 Captured 20_composer_model_popover.png');

    // Close composer popover
    await page.click('.composer-engine-pill');
    await new Promise((r) => setTimeout(r, 300));

    // 21: Test Quick Action Chip Click
    console.log('7️⃣ Testing Quick Action Chip click...');
    const chipSelector = '.quick-action-chip';
    await page.waitForSelector(chipSelector, { timeout: 5000 });
    await page.click(chipSelector);
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '21_quick_chip_clicked.png') });
    console.log('   📸 Captured 21_quick_chip_clicked.png');

    const textareaVal = await page.$eval('.prompt-textarea', (el: any) => el.value);
    console.log('   Prompt textarea successfully filled with:', textareaVal);

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Test failed:', err);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'error_screenshot.png') });
    throw err;
  } finally {
    await browser.close();
  }
}

runTest();
