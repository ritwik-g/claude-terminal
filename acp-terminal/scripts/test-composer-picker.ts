import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { screenshotDir } from './lib/test-paths.js';

const ARTIFACTS_DIR = screenshotDir();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testComposerPicker() {
  console.log('Testing composer engine pill...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,850'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 850 });

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));

    // Check if composer pill exists
    const pill = await page.$('.composer-engine-pill');
    console.log('Composer engine pill found:', Boolean(pill));

    if (pill) {
      const box = await pill.boundingBox();
      console.log('Composer engine pill box:', box);

      await pill.click();
      await new Promise((r) => setTimeout(r, 500));

      const popover = await page.$('.engine-switcher-popover.popover-above');
      console.log('Popover element found after click:', Boolean(popover));
      if (popover) {
        const popBox = await popover.boundingBox();
        console.log('Popover bounding box:', popBox);
      }

      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '55_composer_picker_clicked.png') });
      console.log('📸 Captured 55_composer_picker_clicked.png');
    }
  } finally {
    await browser.close();
  }
}

testComposerPicker().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
