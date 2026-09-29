import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/personal/claude-terminal/acp-terminal';
const SCREENSHOT_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testRealImage() {
  console.log('Testing Real Image Attachment & Lightbox Rendering...');
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

    // Create a real visual image using HTML5 Canvas in page and paste it
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 200;
      const ctx = canvas.getContext('2d')!;
      
      // Gradient background
      const grad = ctx.createLinearGradient(0, 0, 400, 200);
      grad.addColorStop(0, '#1e3a8a');
      grad.addColorStop(1, '#065f46');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 400, 200);

      // Text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillText('ACP Terminal UI Bug', 30, 80);
      ctx.fillStyle = '#6ee7b7';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText('Screenshot Attachment Test', 30, 120);

      const dataUrl = canvas.toDataURL('image/png');
      const byteString = atob(dataUrl.split(',')[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: 'image/png' });
      const file = new File([blob], 'system_architecture_diagram.png', { type: 'image/png' });

      const textarea = document.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      const dt = new DataTransfer();
      dt.items.add(file);

      textarea.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }));
    });

    await new Promise((r) => setTimeout(r, 800));

    // Type text prompt
    const textarea = await page.$('.prompt-textarea');
    if (textarea) {
      await textarea.type('Here is the architecture diagram for review.');
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '101_composer_diagram_attached.png') });
      console.log('📸 Captured 101_composer_diagram_attached.png');

      // Click Send
      const sendBtn = await page.$('.btn-send');
      if (sendBtn) {
        await sendBtn.click();
        await new Promise((r) => setTimeout(r, 1200));
        console.log('Sent prompt with diagram.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '102_chat_turn_with_real_image.png') });
        console.log('📸 Captured 102_chat_turn_with_real_image.png');
      }
    }

    // Click on the newly sent image to open lightbox
    const imageContainer = await page.$('.turn-image-container');
    if (imageContainer) {
      await imageContainer.click();
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, '103_image_lightbox_enlarged.png') });
      console.log('📸 Captured 103_image_lightbox_enlarged.png');
    }

    console.log('Real image test completed successfully!');
  } finally {
    await browser.close();
  }
}

testRealImage().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
