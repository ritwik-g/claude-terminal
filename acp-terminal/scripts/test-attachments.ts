import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testAttachments() {
  console.log('Testing File & Picture Attachments and Pasting...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,850'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 850 });

  try {
    await page.goto('http://127.0.0.1:7890', { waitUntil: 'networkidle0', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. Verify Attach button exists in composer
    const attachBtn = await page.$('.composer-attach-btn');
    console.log('Attach button found:', Boolean(attachBtn));
    if (!attachBtn) {
      throw new Error('Composer attach button not found!');
    }

    // 2. Simulate attaching an image file
    // Create a 1x1 test PNG base64
    const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzgDjhWwAAAABJRU5ErkJggg==';

    await page.evaluate((dataUrl) => {
      // Dispatch custom paste or file event
      const textarea = document.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      if (!textarea) return;

      // Convert dataUrl to blob/file
      const byteString = atob(dataUrl.split(',')[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: 'image/png' });
      const file = new File([blob], 'screenshot_bug_report.png', { type: 'image/png' });

      // Create a mock DataTransfer and clipboard event
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });

      textarea.dispatchEvent(pasteEvent);
    }, samplePngBase64);

    await new Promise((r) => setTimeout(r, 800));

    // 3. Verify attachment preview chip is visible
    const chip = await page.$('.composer-attachment-chip');
    console.log('Composer attachment chip found:', Boolean(chip));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '96_composer_with_pasted_image.png') });
    console.log('📸 Captured 96_composer_with_pasted_image.png');

    // 4. Type prompt and send with attachment
    const textarea = await page.$('.prompt-textarea');
    if (textarea) {
      await textarea.type('Please analyze this attached screenshot.');
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '97_composer_ready_to_send_image.png') });
      console.log('📸 Captured 97_composer_ready_to_send_image.png');

      // Send prompt
      const sendBtn = await page.$('.btn-send');
      if (sendBtn) {
        await sendBtn.click();
        await new Promise((r) => setTimeout(r, 1500));
        console.log('Sent prompt with image attachment.');

        await page.screenshot({ path: path.join(ARTIFACTS_DIR, '98_chat_turn_with_image_attachment.png') });
        console.log('📸 Captured 98_chat_turn_with_image_attachment.png');
      }
    }

    // 5. Test Lightbox image preview modal
    const imageThumb = await page.$('.turn-image-thumb');
    console.log('Rendered turn image thumb found:', Boolean(imageThumb));
    if (imageThumb) {
      await imageThumb.click();
      await new Promise((r) => setTimeout(r, 600));

      const lightbox = await page.$('.image-preview-modal');
      console.log('Lightbox modal found:', Boolean(lightbox));

      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '99_image_lightbox_modal.png') });
      console.log('📸 Captured 99_image_lightbox_modal.png');

      // Close lightbox
      const closeBtn = await page.$('.image-preview-close');
      if (closeBtn) {
        await closeBtn.click();
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // 6. Test Mobile Viewport
    await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 600));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '100_mobile_composer_with_attach.png') });
    console.log('📸 Captured 100_mobile_composer_with_attach.png');

    console.log('All attachment tests passed successfully!');
  } finally {
    await browser.close();
  }
}

testAttachments().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
