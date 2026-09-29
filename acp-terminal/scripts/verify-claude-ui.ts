import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function verifyClaudeUI() {
  console.log('🚀 Verifying Claude in Web UI...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,850'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 850 });

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    // 1. Capture session conversation with Claude
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '49_claude_session_conversation.png') });
    console.log('📸 Captured 49_claude_session_conversation.png');

    // 2. Click the model pill/selector in the session header
    const modelPill = await page.$('.model-dropdown-trigger') || await page.$('.model-pill') || await page.$('button[title*="model"]');
    if (modelPill) {
      await modelPill.click();
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '50_claude_model_picker_dropdown.png') });
      console.log('📸 Captured 50_claude_model_picker_dropdown.png');
    }

    // 3. Open Subscriptions & Usage modal
    const subBtn = await page.$('.btn-subscriptions-nav');
    if (subBtn) {
      await subBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '51_claude_subscriptions_usage.png') });
      console.log('📸 Captured 51_claude_subscriptions_usage.png');

      // Click Vendor Usage & Costs tab
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button.filter-tab'));
        const tab = buttons.find((b) => b.textContent?.includes('Vendor Usage'));
        if (tab) (tab as HTMLElement).click();
      });
      await new Promise((r) => setTimeout(r, 1000));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '52_claude_usage_and_costs.png') });
      console.log('📸 Captured 52_claude_usage_and_costs.png');
    }

    console.log('✅ UI Verification complete!');
  } finally {
    await browser.close();
  }
}

verifyClaudeUI().catch((err) => {
  console.error('Puppeteer verification failed:', err);
  process.exit(1);
});
