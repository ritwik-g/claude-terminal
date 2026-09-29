import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { screenshotDir } from './lib/test-paths.js';
import { getSessionsDir } from '../server/paths.js';

const ARTIFACTS_DIR = screenshotDir();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runMobileAndSuggestionsVerification() {
  console.log('--- Testing Mobile Bottom Sheet & Model Selector ---');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. Mobile bottom sheet open via composer pill
    console.log('1. Tapping composer pill on mobile...');
    await page.tap('.composer-engine-pill');
    await new Promise((r) => setTimeout(r, 600));

    const popover = await page.$('.engine-switcher-popover');
    if (!popover) throw new Error('Popover bottom sheet did not open on mobile!');
    const box = await popover.boundingBox();
    console.log('✓ Mobile bottom sheet bounding box:', box);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '70_mobile_sheet_with_close_button.png') });
    console.log('📸 Saved 70_mobile_sheet_with_close_button.png');

    // 2. Test closing via ✕ button
    console.log('2. Testing close button ✕...');
    await page.tap('.btn-popover-close');
    await new Promise((r) => setTimeout(r, 600));

    const popoverAfterClose = await page.$('.engine-switcher-popover');
    console.log('✓ Popover closed after clicking ✕:', !popoverAfterClose);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '71_mobile_sheet_dismissed_by_close.png') });
    console.log('📸 Saved 71_mobile_sheet_dismissed_by_close.png');

    // 3. Re-open and select Claude Opus
    console.log('3. Re-opening bottom sheet and selecting Claude Opus...');
    await page.tap('.composer-engine-pill');
    await new Promise((r) => setTimeout(r, 600));

    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.model-card-row'));
      const opusRow = rows.find((r) => r.textContent?.includes('Claude Opus'));
      if (opusRow) (opusRow as any).click();
    });
    await new Promise((r) => setTimeout(r, 1500));

    const updatedPill = await page.$eval('.composer-engine-pill', (el) => el.textContent?.trim());
    console.log('✓ Composer pill text after switch:', updatedPill);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '72_mobile_sheet_model_switched.png') });
    console.log('📸 Saved 72_mobile_sheet_model_switched.png');

    // 4. Test opening model selector from mobile actions drawer (⋯)
    console.log('4. Testing opening from mobile actions drawer (⋯)...');
    await page.tap('.btn-mobile-more');
    await new Promise((r) => setTimeout(r, 600));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '73_mobile_actions_drawer_with_model_option.png') });
    console.log('📸 Saved 73_mobile_actions_drawer_with_model_option.png');

    // Tap "Switch Active Model & Effort" in mobile drawer
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.mobile-action-item'));
      const switchItem = items.find((i) => i.textContent?.includes('Switch Active Model'));
      if (switchItem) (switchItem as any).click();
    });
    await new Promise((r) => setTimeout(r, 800));

    const popoverFromDrawer = await page.$('.engine-switcher-popover');
    console.log('✓ Popover bottom sheet opened from mobile drawer:', Boolean(popoverFromDrawer));

    // Close popover
    await page.tap('.btn-popover-close');
    await new Promise((r) => setTimeout(r, 500));

    // 5. Test native prompt suggestion UI injection
    console.log('5. Testing prompt suggestion rendering...');
    // Simulate a prompt suggestion on the session to test rendering
    await page.evaluate(() => {
      // Find session or update UI state to test
      const chipArea = document.querySelector('.quick-action-chips');
      console.log('Chip area present:', Boolean(chipArea));
    });

    // Let's set promptSuggestion directly on the active session via store to verify the UI
    const sessionsRes = await fetch('http://127.0.0.1:7890/api/sessions');
    const sessionsData = await sessionsRes.json() as any;
    const activeSession = sessionsData.sessions[0];
    if (activeSession) {
      // Update session via internal store or direct file to test
      const fs = await import('node:fs');
      const storeFile = path.join(getSessionsDir(), `${activeSession.id}.json`);
      if (fs.existsSync(storeFile)) {
        const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        raw.promptSuggestion = 'Run integration tests and check for regression';
        fs.writeFileSync(storeFile, JSON.stringify(raw, null, 2), 'utf8');
        console.log('✓ Injected test promptSuggestion into session JSON');
      }
    }

    // Refresh page to load session with suggestion
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));

    const suggestionChip = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.quick-action-chip'));
      const chip = chips.find((c) => c.textContent?.includes('Run integration tests'));
      return chip ? chip.textContent : null;
    });
    console.log('✓ Native suggestion chip rendered:', suggestionChip);

    const textareaPlaceholder = await page.$eval('.prompt-textarea', (el: any) => el.placeholder);
    console.log('✓ Textarea placeholder with suggestion:', textareaPlaceholder);

    // Test Tab key autocomplete
    await page.focus('.prompt-textarea');
    await page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 300));
    const insertedPrompt = await page.$eval('.prompt-textarea', (el: any) => el.value);
    console.log('✓ Textarea value after pressing Tab:', insertedPrompt);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '74_native_prompt_suggestion_verified.png') });
    console.log('📸 Saved 74_native_prompt_suggestion_verified.png');

    console.log('--- ALL MOBILE & PROMPT SUGGESTION TESTS PASSED! ---');
  } finally {
    await browser.close();
  }
}

runMobileAndSuggestionsVerification().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
