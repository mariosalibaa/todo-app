// posts a real line on mario-cash and removes it again — run only against the local hub
// resolve playwright from wa-contacts's node_modules (this file lives in D:\vscode\todo, which has none)
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire('D:/vscode/wa-contacts/package.json');
const { chromium } = require('playwright');
// firebase-admin lives under D:\vscode\todo\node_modules — this file's own createRequire (not
// wa-contacts's) resolves it, and the service account is read from the todo project too
const requireTodo = createRequire('D:/vscode/todo/package.json');
const admin = requireTodo('firebase-admin');
const TEAM_ID = process.env.TEAM_ID || 'team';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync('D:/vscode/todo/firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();

const shot1 = path.join(os.tmpdir(), 'site-e2e-1.png');
const shot2 = path.join(os.tmpdir(), 'site-e2e-2.png');

const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 420, height: 800 } });
await page.goto('http://127.0.0.1:8081/site');
await page.waitForSelector('#feed');
await page.waitForFunction(() => !document.getElementById('text').disabled, null, { timeout: 15000 });
await page.fill('#text', 'test post — delete me 12$');
await page.click('button.send');
// check the LAST post's line (not the first — old history in the thread has its own already-settled line)
await page.waitForFunction(() => {
  const last = [...document.querySelectorAll('.post')].slice(-1)[0];
  const line = last && last.querySelector('.line');
  return line && !/reading/.test(line.textContent);
}, null, { timeout: 30000 });
console.log(await page.evaluate(() => [...document.querySelectorAll('.post')].slice(-1)[0].innerText));
const postId = await page.evaluate(() => [...document.querySelectorAll('.post')].slice(-1)[0].dataset.id);
await page.screenshot({ path: shot1 });

// phone width: composer above the bottom edge, feed doesn't scroll horizontally
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(300);
const layout = await page.evaluate(() => {
  const composer = document.querySelector('.composer');
  const feed = document.querySelector('.feed');
  const cRect = composer.getBoundingClientRect();
  return {
    composerBottom: cRect.bottom, viewportHeight: window.innerHeight,
    feedScrollWidth: feed.scrollWidth, feedClientWidth: feed.clientWidth,
    bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth
  };
});
console.log('phone layout:', JSON.stringify(layout));
await page.screenshot({ path: shot2 });
await b.close();

// clean up: the tx it wrote on mario-cash, then the post doc itself — leave nothing behind
try {
  const r = await fetch(`http://127.0.0.1:8081/api/accounting/accounts/mario-cash/tx/site-${postId}`, { method: 'DELETE' });
  console.log('tx delete:', r.status);
} catch (e) { console.error('tx delete failed', e.message); }
try {
  await db.collection('workspaces').doc(TEAM_ID).collection('site').doc('general').collection('posts').doc(postId).delete();
  console.log('post doc deleted:', postId);
} catch (e) { console.error('post doc delete failed', e.message); }
for (const f of [shot1, shot2]) { try { fs.unlinkSync(f); } catch {} }
