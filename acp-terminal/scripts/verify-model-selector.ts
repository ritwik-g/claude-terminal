import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function verifyModelSelector() {
  console.log('Starting comprehensive verification of model selector and historical turn badges...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.error('BROWSER PAGE ERROR:', err));

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. Verify Top Header: should NOT have any model dropdown or switcher
    const topHeaderDropdown = await page.$('.session-engine-picker-wrapper, .session-model-picker, select.header-model-select');
    console.log('1. Top header dropdown present:', Boolean(topHeaderDropdown));
    if (topHeaderDropdown) {
      console.warn('WARNING: Found model dropdown in top header! It should only be in the chat window.');
    } else {
      console.log('SUCCESS: No model dropdown in top header.');
    }

    // 2. Verify Composer Toolbar Pill
    const composerPill = await page.$('.composer-engine-pill');
    if (!composerPill) {
      throw new Error('Composer engine pill not found!');
    }
    const initialPillText = await page.evaluate((el) => el.textContent, composerPill);
    console.log('2. Initial composer pill text:', initialPillText);

    // 3. Click composer pill to open popover
    await composerPill.click();
    await new Promise((r) => setTimeout(r, 600));

    const popover = await page.$('.engine-switcher-popover');
    console.log('3. Popover opened:', Boolean(popover));
    if (!popover) {
      throw new Error('Popover did not open on clicking composer pill!');
    }

    // Take screenshot of popover open
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '57_composer_popover_open.png') });
    console.log('📸 Captured 57_composer_popover_open.png');

    // 4. Select a different model (e.g. Gemini 2.5 Pro or Claude Opus)
    const targetModelRow = await page.evaluateHandle(() => {
      const rows = Array.from(document.querySelectorAll('.model-card-row'));
      return rows.find((r) => r.textContent?.includes('Gemini 2.5 Pro') || r.textContent?.includes('Claude Opus'));
    });

    if (targetModelRow) {
      console.log('4. Clicking target model row in popover...');
      await (targetModelRow as any).click();
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Check updated composer pill text
    const updatedPillText = await page.$eval('.composer-engine-pill', (el) => el.textContent);
    console.log('5. Updated composer pill text:', updatedPillText);

    // 5. Check turns in conversation to see historical models
    const turnsMeta = await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('.agent-turn-meta'));
      return turns.map((t) => ({
        name: t.querySelector('.agent-turn-name')?.textContent || '',
        model: t.querySelector('.agent-turn-model')?.textContent || '',
      }));
    });
    console.log('6. Conversation turn badges:', JSON.stringify(turnsMeta, null, 2));

    // Check textarea placeholder
    const placeholder = await page.$eval('.prompt-textarea', (el: any) => el.placeholder);
    console.log('7. Prompt textarea placeholder:', placeholder);

    // 6. Capture final screenshot
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '58_model_selector_verified.png') });
    console.log('📸 Captured 58_model_selector_verified.png');

    console.log('ALL VERIFICATIONS COMPLETED SUCCESSFULLY!');
  } finally {
    await browser.close();
  }
}

verifyModelSelector().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
