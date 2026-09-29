import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { screenshotDir } from './lib/test-paths.js';

const SCREENSHOT_DIR = screenshotDir();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testSlashCommands() {
  console.log('Testing Agent-Specific Slash Commands Suggestions...');
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

    // Select the first session (Claude Code session)
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.session-card')) as HTMLElement[];
      const claudeCard = cards.find(c => c.textContent?.includes('CLAUDE') || c.textContent?.includes('Claude')) || cards[0];
      if (claudeCard) claudeCard.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    // 1. Type '/' into the prompt textarea
    console.log('Typing / to trigger slash command menu...');
    const textarea = await page.$('.prompt-textarea');
    if (textarea) {
      await textarea.click();
      await page.keyboard.type('/');
      await new Promise((r) => setTimeout(r, 800));

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '111_claude_slash_commands.png') });
      console.log('Saved 111_claude_slash_commands.png');

      // 2. Type 'co' to filter to /compact and /cost
      console.log('Typing co to filter commands...');
      await page.keyboard.type('co');
      await new Promise((r) => setTimeout(r, 600));

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '112_filtered_slash_commands.png') });
      console.log('Saved 112_filtered_slash_commands.png');
    }

    // 3. Select Google Antigravity session
    console.log('Selecting Google Antigravity session...');
    const switched = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.session-card')) as HTMLElement[];
      const geminiCard = cards.find(c => c.textContent?.includes('GOOGLE') || c.textContent?.includes('Google') || c.textContent?.includes('Claude Terminal View Mode'));
      if (geminiCard) {
        geminiCard.click();
        return true;
      }
      return false;
    });
    console.log('Clicked Google card:', switched);
    await new Promise((r) => setTimeout(r, 1500));

    // Type '/' in Antigravity session
    const antTextarea = await page.$('.prompt-textarea');
    if (antTextarea) {
      await antTextarea.click();
      await page.keyboard.type('/');
      await new Promise((r) => setTimeout(r, 800));

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '113_antigravity_slash_commands.png') });
      console.log('Saved 113_antigravity_slash_commands.png');
    }

    // 4. Test Mobile view
    console.log('Testing Mobile View...');
    const mobilePage = await browser.newPage();
    await mobilePage.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
    await mobilePage.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));

    await mobilePage.evaluate(() => {
      const card = document.querySelector('.session-card') as HTMLElement;
      if (card) card.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    const mobileSlashBtn = await mobilePage.$('.btn-slash-trigger');
    if (mobileSlashBtn) {
      await mobileSlashBtn.click();
      await new Promise((r) => setTimeout(r, 800));
      await mobilePage.screenshot({ path: path.join(SCREENSHOT_DIR, '114_mobile_slash_commands.png') });
      console.log('Saved 114_mobile_slash_commands.png');
    }

    console.log('All slash command tests finished successfully!');
  } catch (err) {
    console.error('Puppeteer error:', err);
  } finally {
    await browser.close();
  }
}

testSlashCommands();
