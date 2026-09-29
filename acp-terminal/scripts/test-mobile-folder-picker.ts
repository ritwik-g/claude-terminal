import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testMobileFolderPicker() {
  console.log('Testing Mobile Folder Picker & Browser UI (iPhone 14 Pro: 393x852)...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=393,852'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));

    // Open new session modal on mobile (via drawer or top button)
    const opened = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const newBtn = btns.find((b) => b.textContent?.includes('+') || b.textContent?.includes('New'));
      if (newBtn) {
        newBtn.click();
        return true;
      }
      return false;
    });

    console.log('Opened new session on mobile:', opened);
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '94_mobile_new_session_modal.png') });
    console.log('📸 Captured 94_mobile_new_session_modal.png');

    // Click Browse... on mobile
    const clickedBrowse = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const browseBtn = btns.find((b) => b.textContent?.includes('Browse...'));
      if (browseBtn) {
        browseBtn.click();
        return true;
      }
      return false;
    });

    console.log('Clicked Browse... on mobile:', clickedBrowse);
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '95_mobile_folder_browser_opened.png') });
    console.log('📸 Captured 95_mobile_folder_browser_opened.png');
  } finally {
    await browser.close();
  }
}

testMobileFolderPicker().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
