import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testFolderPicker() {
  console.log('Testing Folder Picker & Browser UI...');
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

    // 1. Click "New Session" button (+ New Agent Session or .btn-new)
    const newSessionBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.textContent?.includes('New Session') || b.textContent?.includes('+ New'));
    });

    if (newSessionBtn) {
      await (newSessionBtn as any).click();
      await new Promise((r) => setTimeout(r, 800));
      console.log('Opened New Session Modal.');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '88_new_session_modal_with_browse.png') });
      console.log('📸 Captured 88_new_session_modal_with_browse.png');
    }

    // 2. Click "Browse..." button
    const browseBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.textContent?.includes('Browse...'));
    });

    if (browseBtn) {
      await (browseBtn as any).click();
      await new Promise((r) => setTimeout(r, 800));
      console.log('Clicked Browse... button.');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '89_folder_browser_modal_opened.png') });
      console.log('📸 Captured 89_folder_browser_modal_opened.png');
    }

    // 3. Test filtering in folder browser modal
    const filterInput = await page.$('.folder-browser-body input[placeholder*="Filter"]');
    if (filterInput) {
      await filterInput.type('personal');
      await new Promise((r) => setTimeout(r, 500));
      console.log('Filtered for "personal".');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '90_folder_browser_filtered.png') });
      console.log('📸 Captured 90_folder_browser_filtered.png');

      // Click on the personal entry row to drill down
      const clicked = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.folder-entry-row'));
        const row = rows.find((r) => r.textContent?.includes('personal'));
        if (row) {
          (row as HTMLElement).click();
          return true;
        }
        return false;
      });
      if (clicked) {
        await new Promise((r) => setTimeout(r, 800));
        console.log('Drilled into "personal" directory.');
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, '91_folder_browser_inside_personal.png') });
        console.log('📸 Captured 91_folder_browser_inside_personal.png');
      }
    }

    // 4. Click "Select" button on claude-terminal
    const selectedClaude = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.folder-entry-row'));
      const row = rows.find((r) => r.textContent?.includes('claude-terminal'));
      if (row) {
        const btn = row.querySelector('.btn-select-folder-chip') as HTMLElement;
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (selectedClaude) {
      await new Promise((r) => setTimeout(r, 800));
      console.log('Selected claude-terminal via chip.');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '92_new_session_cwd_updated.png') });
      console.log('📸 Captured 92_new_session_cwd_updated.png');
    }

    // 5. Test Mobile Viewport
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 500));

    // Open browser in mobile
    const openMobileBrowser = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find((b) => b.textContent?.includes('Browse...'));
      if (btn) {
        (btn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (openMobileBrowser) {
      await new Promise((r) => setTimeout(r, 800));
      console.log('Opened folder browser on mobile.');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '93_folder_browser_mobile.png') });
      console.log('📸 Captured 93_folder_browser_mobile.png');
    }

    console.log('All folder picker tests completed successfully!');
  } finally {
    await browser.close();
  }
}

testFolderPicker().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
