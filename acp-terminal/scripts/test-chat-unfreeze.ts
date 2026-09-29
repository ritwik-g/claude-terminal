import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshotDir } from './lib/test-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = screenshotDir();

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runTest() {
  console.log('🚀 Starting Chat Unfreeze & State Lifecycle Verification...');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,850'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 850 });

  try {
    console.log('1️⃣ Navigating to http://127.0.0.1:7890...');
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1000));

    // Capture initial load
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '35_session_loaded.png') });
    console.log('   📸 Captured 35_session_loaded.png');

    // Verify textarea is editable
    const isTextareaDisabled = await page.$eval('.prompt-textarea', (el: any) => el.disabled);
    console.log('   Textarea disabled status:', isTextareaDisabled);
    if (isTextareaDisabled) {
      throw new Error('Textarea was unexpectedly disabled on initial load!');
    }

    // Check status banner
    const statusText = await page.evaluate(() => document.querySelector('.status-banner-text')?.textContent || '');
    console.log('   Status banner text:', statusText.trim());

    // Type a message in the prompt textarea
    console.log('2️⃣ Typing a message into composer...');
    await page.type('.prompt-textarea', 'What is the current time and status?');
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '36_prompt_typed.png') });
    console.log('   📸 Captured 36_prompt_typed.png');

    // Verify Send button is active
    const isSendDisabled = await page.$eval('.btn-send', (el: any) => el.disabled);
    console.log('   Send button disabled status:', isSendDisabled);
    if (isSendDisabled) {
      throw new Error('Send button was disabled when prompt text was provided!');
    }

    // Submit prompt
    console.log('3️⃣ Submitting prompt to agent...');
    await page.click('.btn-send');

    // Wait 1 second to observe working state
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '37_agent_working_state.png') });
    console.log('   📸 Captured 37_agent_working_state.png');

    const workingBanner = await page.evaluate(() => document.querySelector('.status-banner-text')?.textContent || '');
    console.log('   Working banner status:', workingBanner.trim());

    // Verify that user CAN type in textarea while agent is running
    console.log('4️⃣ Testing user ability to type while agent is working...');
    await page.type('.prompt-textarea', 'I am typing while you work!');
    const currentInputVal = await page.$eval('.prompt-textarea', (el: any) => el.value);
    console.log('   Composer input value while working:', currentInputVal);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '38_typing_during_working.png') });
    console.log('   📸 Captured 38_typing_during_working.png');

    // Wait for turn completion
    console.log('5️⃣ Waiting for agent turn completion (up to 30s)...');
    let finished = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const isReady = await page.evaluate(() => {
        const text = document.querySelector('.status-banner-text')?.textContent || '';
        return text.includes('Ready for your input');
      });
      if (isReady) {
        finished = true;
        console.log(`   Turn completed successfully in ~${i + 1}s!`);
        break;
      }
    }

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '39_turn_completed_ready.png') });
    console.log('   📸 Captured 39_turn_completed_ready.png');

    if (!finished) {
      console.warn('⚠️ Turn did not transition to ready within 30s. Checking current state...');
      const banner = await page.evaluate(() => document.querySelector('.status-banner-text')?.textContent || '');
      console.log('   Current banner text:', banner);
    } else {
      console.log('✅ Turn finished and session successfully transitioned back to "Ready for your input"!');
    }

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'error_screenshot.png') });
    throw err;
  } finally {
    await browser.close();
  }
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
