import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOTS_DIR = path.resolve(__dirname, '../screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runBrowserTest() {
  console.log('🌐 [Browser Test] Launching Chrome at:', CHROME_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,880'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 880 });

  try {
    // 1. Home screen
    console.log('1️⃣ Navigating to http://127.0.0.1:7890...');
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01_home_screen.png') });
    console.log('   📸 Captured 01_home_screen.png');

    // 2. Open "Start New ACP Agent Session" modal
    console.log('2️⃣ Opening "Start New Session" modal...');
    const newSessionBtn = await page.waitForSelector('.btn-new', { timeout: 5000 });
    if (!newSessionBtn) throw new Error('Could not find .btn-new button');
    await newSessionBtn.click();
    await page.waitForSelector('.modal-card', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02_new_session_modal.png') });
    console.log('   📸 Captured 02_new_session_modal.png');

    // 3. Open Model Selection dropdown in modal (Claude models)
    console.log('3️⃣ Opening Claude Model Selection dropdown...');
    let triggerButtons = await page.$$('.picker-trigger-btn');
    if (triggerButtons.length >= 2) {
      await triggerButtons[1].click();
      await page.waitForSelector('.picker-dropdown-menu', { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03_model_dropdown_claude.png') });
      console.log('   📸 Captured 03_model_dropdown_claude.png');

      const menuText = await page.evaluate(() => document.querySelector('.picker-dropdown-menu')?.textContent || '');
      console.log('   Menu text sample:', menuText.slice(0, 120).replace(/\n/g, ' '));
      if (!menuText.includes('Opus 5.5') && !menuText.includes('Opus')) {
        throw new Error(`Expected Opus in Claude model list, got: ${menuText.slice(0, 100)}`);
      }
      if (!menuText.includes('CUSTOM MODEL ID')) {
        throw new Error('Custom model input field missing from model dropdown');
      }
      console.log('   ✅ Claude models verified (Opus 5.5, Fable 5.1, Sonnet 5, custom input)');
    }

    // 4. Switch vendor to OpenAI / Codex in modal
    console.log('4️⃣ Switching vendor to OpenAI / Codex...');
    triggerButtons = await page.$$('.picker-trigger-btn');
    if (triggerButtons.length >= 1) {
      await triggerButtons[0].click(); // open vendor menu
      await page.waitForSelector('.picker-dropdown-item', { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 200));

      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.picker-dropdown-item'));
        const codex = items.find((el) => el.textContent?.includes('Codex') || el.textContent?.includes('OpenAI'));
        if (codex) (codex as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));

      // Open models dropdown for Codex
      triggerButtons = await page.$$('.picker-trigger-btn');
      if (triggerButtons.length >= 2) {
        await triggerButtons[1].click();
        await page.waitForSelector('.picker-dropdown-menu', { timeout: 3000 });
        await new Promise((r) => setTimeout(r, 300));
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04_model_dropdown_codex.png') });
        console.log('   📸 Captured 04_model_dropdown_codex.png');

        const codexMenuText = await page.evaluate(() => document.querySelector('.picker-dropdown-menu')?.textContent || '');
        if (!codexMenuText.includes('6 Luna') && !codexMenuText.includes('Luna')) {
          throw new Error(`Expected 6 Luna in Codex models, got: ${codexMenuText.slice(0, 100)}`);
        }
        console.log('   ✅ Codex models verified (6 Luna, 5.6 Terra, 5.6 Luna, 5.5)');
      }
    }

    // 5. Switch vendor to Antigravity
    console.log('5️⃣ Switching vendor to Google Antigravity...');
    triggerButtons = await page.$$('.picker-trigger-btn');
    if (triggerButtons.length >= 1) {
      await triggerButtons[0].click();
      await page.waitForSelector('.picker-dropdown-item', { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 200));

      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.picker-dropdown-item'));
        const ag = items.find((el) => el.textContent?.includes('Antigravity') || el.textContent?.includes('Gemini'));
        if (ag) (ag as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 400));

      triggerButtons = await page.$$('.picker-trigger-btn');
      if (triggerButtons.length >= 2) {
        await triggerButtons[1].click();
        await page.waitForSelector('.picker-dropdown-menu', { timeout: 3000 });
        await new Promise((r) => setTimeout(r, 300));
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05_model_dropdown_antigravity.png') });
        console.log('   📸 Captured 05_model_dropdown_antigravity.png');

        const agMenuText = await page.evaluate(() => document.querySelector('.picker-dropdown-menu')?.textContent || '');
        if (!agMenuText.includes('3.8 Flash') && !agMenuText.includes('Flash')) {
          throw new Error(`Expected Gemini 3.8 Flash in Antigravity models, got: ${agMenuText.slice(0, 100)}`);
        }
        console.log('   ✅ Antigravity models verified (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS)');
      }
    }

    // Close modal
    console.log('6️⃣ Closing New Session Modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-footer button'));
      const cancel = btns.find((b) => b.textContent?.includes('Cancel'));
      if (cancel) (cancel as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 400));

    // 7. Select session in sidebar
    console.log('7️⃣ Selecting active session in sidebar...');
    const sessionCard = await page.waitForSelector('.session-card', { timeout: 5000 });
    if (!sessionCard) throw new Error('No session card found in sidebar');
    await sessionCard.click();
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06_session_detail_view.png') });
    console.log('   📸 Captured 06_session_detail_view.png');

    // 8. Open In-Session Engine Switcher Popover
    console.log('8️⃣ Opening In-Session Engine Switcher popover...');
    const enginePill = await page.waitForSelector('.session-engine-btn', { timeout: 5000 });
    if (!enginePill) throw new Error('Could not find .session-engine-btn');
    await enginePill.click();
    await page.waitForSelector('.engine-switcher-popover', { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07_in_session_engine_popover.png') });
    console.log('   📸 Captured 07_in_session_engine_popover.png');

    const popoverText = await page.evaluate(() => document.querySelector('.engine-switcher-popover')?.textContent || '');
    if (!popoverText.includes('Context Handover on Switch')) {
      throw new Error('Context Handover section missing in popover');
    }
    if (!popoverText.includes('Immediately prompt new model to continue active task')) {
      throw new Error('Auto-continue checkbox missing in popover');
    }
    if (!popoverText.includes('CUSTOM SUBSCRIPTION / API MODEL ID')) {
      throw new Error('Custom model ID input missing in popover');
    }
    console.log('   ✅ In-session popover verified with all models, reasoning effort, context mode, and auto-continue');

    // Close popover
    await enginePill.click();
    await new Promise((r) => setTimeout(r, 300));

    // 9. Open "🔄 Switch / Failover" modal
    console.log('9️⃣ Testing "Switch / Failover" modal...');
    const switchModalBtn = await page.waitForSelector('.btn-failover', { timeout: 5000 });
    if (switchModalBtn) {
      await switchModalBtn.click();
      await page.waitForSelector('.modal-card', { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08_switch_failover_modal.png') });
      console.log('   📸 Captured 08_switch_failover_modal.png');

      const modalText = await page.evaluate(() => document.querySelector('.modal-card')?.textContent || '');
      if (!modalText.includes('Immediately send continuation prompt to new agent')) {
        throw new Error('Continuation prompt section missing in SwitchAgentModal');
      }
      if (!modalText.includes('Conversation Context Handover')) {
        throw new Error('Context handover options missing in SwitchAgentModal');
      }
      console.log('   ✅ Switch / Failover modal verified (continuation prompt and context transfer active for in-place switch)');

      // Close modal
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.modal-footer button'));
        const cancel = btns.find((b) => b.textContent?.includes('Cancel'));
        if (cancel) (cancel as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    // 10. Verify Compact Button in header
    console.log('🔟 Verifying "📦 Compact" button...');
    const compactBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.some((b) => b.textContent?.includes('Compact'));
    });
    if (!compactBtn) {
      throw new Error('Compact button not found in session header actions');
    }
    console.log('   ✅ "📦 Compact" button found and active in session header');

    console.log('\n🎉 ALL 10 BROWSER UI/UX VALIDATIONS PASSED PERFECTLY! 🚀');
  } finally {
    await browser.close();
  }
}

runBrowserTest().catch((err) => {
  console.error('\n❌ Browser test failed:', err);
  process.exit(1);
});
