import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ARTIFACTS_DIR = '/Users/ritwikg/.gemini/antigravity/brain/d8dbf9a3-2cc2-4640-80bf-e5859d219b95';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testApprovalUI() {
  console.log('1. Creating mock session to trigger a permission request...');
  const res = await fetch('http://127.0.0.1:7890/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'mock',
      cwd: '/Users/ritwikg/personal/claude-terminal/acp-terminal',
      title: 'Permission Approval Verification',
    }),
  });

  const data = await res.json();
  const sessionId = data.session.id;
  console.log('Created session ID:', sessionId);

  // Send a prompt that requires permission in mock agent
  console.log('2. Sending prompt requiring permission...');
  await fetch(`http://127.0.0.1:7890/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Please run the test command which requires approval permission.',
    }),
  });

  // Wait a moment for agent to request permission
  let sessionBlocked = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const checkRes = await fetch(`http://127.0.0.1:7890/api/sessions/${sessionId}`);
    const checkData = await checkRes.json();
    if (checkData.session?.pendingPermission && checkData.session?.state === 'blocked') {
      console.log('Agent is now BLOCKED on permission:', checkData.session.pendingPermission.title);
      sessionBlocked = true;
      break;
    }
  }

  if (!sessionBlocked) {
    console.warn('Session did not enter blocked state in time');
  }

  console.log('3. Launching browser to capture approval banner in UI...');
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

    // Click the blocked session in sidebar if not already active
    const sessionCard = await page.evaluateHandle((sid: string) => {
      const cards = Array.from(document.querySelectorAll('.session-card'));
      return cards.find((c) => c.textContent?.includes('Permission Approval Verification'));
    }, sessionId);

    if (sessionCard) {
      await (sessionCard as any).click();
      await new Promise((r) => setTimeout(r, 800));
    }

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '53_approval_surfacing_in_ui.png') });
    console.log('📸 Captured 53_approval_surfacing_in_ui.png');

    // Click Approve execution
    const approveBtn = await page.$('.btn-approve');
    if (approveBtn) {
      console.log('4. Clicking [Approve execution] button...');
      await approveBtn.click();
      await new Promise((r) => setTimeout(r, 1500));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '54_approval_granted_and_resumed.png') });
      console.log('📸 Captured 54_approval_granted_and_resumed.png');
    }
  } finally {
    await browser.close();
  }
}

testApprovalUI().catch((err) => {
  console.error('Error in testApprovalUI:', err);
  process.exit(1);
});
