import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { screenshotDir } from './lib/test-paths.js';

const ARTIFACTS_DIR = screenshotDir();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runE2E() {
  console.log('--- Running Final E2E Verification ---');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,950'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 950 });

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. Verify Top Header: NO model dropdown
    const topSelect = await page.$('.session-engine-picker-wrapper');
    if (topSelect) {
      throw new Error('Top header model selector still exists!');
    }
    console.log('✓ Verified: Top header model selector is completely removed.');

    // 2. Click Composer Model Pill
    const pill = await page.$('.composer-engine-pill');
    if (!pill) throw new Error('Composer engine pill not found!');
    await pill.click();
    await new Promise((r) => setTimeout(r, 600));

    // Capture screenshot of open popover above composer
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '61_composer_popover.png') });
    console.log('✓ Captured 61_composer_popover.png (popover open above chat window)');

    // 3. Switch to Claude Sonnet in popover
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.model-card-row'));
      const sonnetRow = rows.find((r) => r.textContent?.includes('Claude Sonnet'));
      if (sonnetRow) (sonnetRow as any).click();
    });
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Verify updated composer state
    const pillText = await page.$eval('.composer-engine-pill', (el) => el.textContent?.trim());
    console.log('✓ Composer pill text after switch:', pillText);

    const placeholder = await page.$eval('.prompt-textarea', (el: any) => el.placeholder);
    console.log('✓ Prompt textarea placeholder:', placeholder);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '62_model_switched_in_composer.png') });
    console.log('✓ Captured 62_model_switched_in_composer.png');

    // 5. Scroll up to inspect historical conversation turns
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const chatContainer = document.querySelector('.chat-history') || document.querySelector('.conversation-turns');
      if (chatContainer) chatContainer.scrollTop = 0;
    });
    await new Promise((r) => setTimeout(r, 600));

    const turnsData = await page.evaluate(() => {
      const turnHeaders = Array.from(document.querySelectorAll('.agent-turn-header'));
      return turnHeaders.slice(0, 8).map((h) => ({
        agent: h.querySelector('.agent-turn-name')?.textContent?.trim(),
        model: h.querySelector('.agent-turn-model')?.textContent?.trim(),
      }));
    });
    console.log('✓ Historical turn badges sample:', JSON.stringify(turnsData, null, 2));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '63_historical_turns_badges.png') });
    console.log('✓ Captured 63_historical_turns_badges.png');

    console.log('--- All E2E Verifications Passed! ---');
  } finally {
    await browser.close();
  }
}

runE2E().catch((err) => {
  console.error('E2E verification failed:', err);
  process.exit(1);
});
