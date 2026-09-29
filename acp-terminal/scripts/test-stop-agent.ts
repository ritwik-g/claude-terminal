import puppeteer from 'puppeteer-core';
import path from 'node:path';

const SCREENSHOT_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testFullFlow() {
  console.log('Testing Full Stop & Resume Flow...');
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

    // Click on the first session card
    await page.evaluate(() => {
      const card = document.querySelector('.session-card') as HTMLElement;
      if (card) card.click();
    });
    await new Promise((r) => setTimeout(r, 1000));

    // Print all buttons in .header-actions
    let headerButtons = await page.evaluate(() => {
      const ha = document.querySelector('.header-actions');
      if (!ha) return [];
      return Array.from(ha.querySelectorAll('button')).map((b) => ({
        text: b.textContent?.trim(),
        className: b.className,
      }));
    });
    console.log('Initial Header Actions:', headerButtons);

    // Save running screenshot
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '108_agent_running_desktop.png') });
    console.log('Saved 108_agent_running_desktop.png');

    // Click Stop Agent
    const stopBtn = await page.$('.btn-stop-agent');
    if (stopBtn) {
      console.log('Clicking Stop Agent button...');
      await stopBtn.click();
      await new Promise((r) => setTimeout(r, 1500));

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '109_agent_stopped_clean.png') });
      console.log('Saved 109_agent_stopped_clean.png');

      // Click Resume Agent
      const resumeBtn = await page.$('.btn-start-agent');
      if (resumeBtn) {
        console.log('Clicking Resume Agent button...');
        await resumeBtn.click();
        await new Promise((r) => setTimeout(r, 1500));

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '110_agent_resumed_clean.png') });
        console.log('Saved 110_agent_resumed_clean.png');
      }
    }

    console.log('Full flow test completed!');
  } catch (err) {
    console.error('Error in full flow:', err);
  } finally {
    await browser.close();
  }
}

testFullFlow();
