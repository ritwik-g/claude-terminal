import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { screenshotDir } from './lib/test-paths.js';

const ARTIFACTS_DIR = screenshotDir();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testClickModelInComposer() {
  console.log('Testing clicking model in composer popover...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,850'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 850 });

  page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.error('BROWSER PAGE ERROR:', err));

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));

    const pill = await page.$('.composer-engine-pill');
    if (!pill) throw new Error('Composer engine pill not found');

    await pill.click();
    await new Promise((r) => setTimeout(r, 600));

    // Find the Opus row in the popover
    const opusRow = await page.evaluateHandle(() => {
      const rows = Array.from(document.querySelectorAll('.model-card-row'));
      return rows.find((r) => r.textContent?.includes('Claude Opus'));
    });

    console.log('Opus row found in popover:', Boolean(opusRow));
    if (opusRow) {
      await (opusRow as any).click();
      await new Promise((r) => setTimeout(r, 2000));
    }

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '56_after_opus_click.png') });
    console.log('📸 Captured 56_after_opus_click.png');

    // Check what the current session model is now
    const pillText = await page.$eval('.composer-engine-pill', (el) => el.textContent);
    console.log('Current composer pill text after click:', pillText);
  } finally {
    await browser.close();
  }
}

testClickModelInComposer().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
