/* Robust verification: every phase is isolated so one failure does not hide the rest. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const EXE = '/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome';
const PORT = Number(process.env.FD_PORT || 8790);

const harness = path.join(__dirname, 'harness-server.mjs');
const shot = (name) => path.join(__dirname, 'artifacts', name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const err = [];
function check(name, pass, detail) { out.push((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' [' + String(detail).slice(0, 130) + ']')); }
async function phase(name, fn) { try { await fn(); } catch (e) { out.push('SKIP ' + name + ' -> ' + e.message.split('\n')[0]); } }

(async () => {
  let URL_BASE = `http://127.0.0.1:${PORT}`;
  let mcpDoubleUrl = '';   // filled from the harness handshake line
  const child = spawn('node', [harness], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_THINK_MS: '800', NODE_OPTIONS: '--no-warnings' },
  });
  child.stderr.on('data', (d) => err.push('SRV ' + String(d).slice(0, 160)));
  child.stdout.on('data', (d) => {
    const hit = /HARNESS_READY (\d+) (\d+)/.exec(String(d));
    if (hit) {
      URL_BASE = `http://127.0.0.1:${hit[1]}`;
      mcpDoubleUrl = `http://127.0.0.1:${hit[2]}/mcp`;
    }
  });
  await wait(4000);
  if (!mcpDoubleUrl) throw new Error('harness did not report its ports (HARNESS_READY)');

  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => err.push('PAGEERROR ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') err.push(m.type().slice(0, 4).toUpperCase() + ' ' + m.text().slice(0, 150)); });

  const email = 'nas.' + Date.now() + '@example.com';

  await phase('gate', async () => {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await wait(1500);
    const g = await page.evaluate(() => ({
      open: document.getElementById('fdAuth').classList.contains('fd-open'),
      locked: document.getElementById('messageInput').readOnly,
      sendOff: document.getElementById('sendButton').disabled,
    }));
    check('signed-out: auth modal open', g.open);
    check('signed-out: composer locked', g.locked === true && g.sendOff === true);
    await page.evaluate(() => document.querySelector('.prompt-card').click());
    await wait(300);
    check('signed-out: prompt card sends nothing', await page.evaluate(() => !document.querySelector('#messages .message')));
  });

  await phase('signup', async () => {
    await page.click('[data-mode="signup"]');
    await page.fill('#fdAuthForm input[name="name"]', 'Nas');
    await page.fill('#fdAuthForm input[name="email"]', email);
    await page.fill('#fdAuthForm input[name="password"]', 'Sup3rSecret!');
    await page.click('#fdAuthSubmit');
    await wait(900);
    check('signup: modal closed', await page.evaluate(() => !document.getElementById('fdAuth').classList.contains('fd-open')));
    check('signup: composer unlocked', await page.evaluate(() => !document.getElementById('messageInput').readOnly));
    check('signup: name shown in header', await page.evaluate(() => /Nas/.test(document.getElementById('fdAccount').textContent)));
  });

  await phase('send', async () => {
    await page.evaluate(() => document.querySelector('.prompt-card[data-prompt^="Check Japan"]').click());
    await wait(150);
    await wait(150);
    const m = await page.evaluate(() => ({
      welcome: getComputedStyle(document.getElementById('welcome')).display,
      prompts: getComputedStyle(document.getElementById('quickPrompts')).display,
      user: !!document.querySelector('#messages .message.user-message'),
      typing: !!document.querySelector('#fdTyping'), bubbleCount: document.querySelectorAll('#messages .message').length,
      assistantCount: document.querySelectorAll('#messages .message.assistant-message').length,
      areaScroll: document.getElementById('chatArea').scrollTop,
    }));
    check('send: welcome hidden', m.welcome === 'none', m.welcome);
    check('send: quick prompts hidden', m.prompts === 'none', m.prompts);
    check('send: user bubble shown', m.user);
    check('send: thinking indicator while model waits', m.typing === true && m.assistantCount === 0 && m.user === true, JSON.stringify(m));
    await page.waitForFunction(() => {
      const l = document.querySelectorAll('#messages .message.assistant-message');
      return l.length && l[l.length - 1].textContent.trim().length > 0;
    }, null, { timeout: 12000 });
    await wait(600);
    const b = await page.evaluate(() => {
      const l = document.querySelectorAll('#messages .message.assistant-message');
      const n = l[l.length - 1], a = document.getElementById('chatArea');
      return { strong: !!n.querySelector('strong'), li: n.querySelectorAll('li').length, raw: /\*\*/.test(n.innerText), typingGone: !document.getElementById('fdTyping'), scrolled: a.scrollHeight > a.clientHeight ? a.scrollTop > 0 : true, streamCls: n.className.includes('fd-streaming') };
    });
    check('reply: markdown bold rendered', b.strong);
    check('reply: markdown list rendered', b.li >= 2, 'li=' + b.li);
    check('reply: no stray ** visible', !b.raw);
    check('reply: typing indicator removed', b.typingGone);
    check('reply: auto-scroll to bottom', b.scrolled);
    check('reply: streaming marker cleaned', !b.streamCls);
  });

  await phase('files', async () => {
    await page.setInputFiles('#fileInput', [{ name: 'passport-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }]);
    await wait(900);
    check('attach: chip renders filename', await page.evaluate(() => /passport-scan.pdf/.test((document.getElementById('fdFileChips') || {}).textContent || '')));
    await page.fill('#messageInput', 'Read my passport scan');
    check('attach: send enabled with text', await page.evaluate(() => !document.getElementById('sendButton').disabled));
    await page.keyboard.press('Enter');
    await wait(1800);
    check('attach: chips cleared after send', await page.evaluate(() => !((document.getElementById('fdFileChips') || {}).textContent || '').trim()));
    check('attach: user bubble carries file chip', await page.evaluate(() => /passport-scan.pdf/.test(document.getElementById('messages').innerText)));
    check('attach: Enter did not add newline', await page.evaluate(() => !document.getElementById('messageInput').value.includes('\n')));
    const grew = await page.evaluate(async () => {
      const i = document.getElementById('messageInput'), before = i.offsetHeight;
      i.value = Array.from({ length: 8 }, (_, k) => 'line ' + k).join('\n');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      return before < i.offsetHeight;
    });
    check('composer: auto-resize grows textarea', grew);
  });

  await phase('history', async () => {
    await page.reload({ waitUntil: 'load' });
    await wait(2000);
    const h = await page.evaluate(() => ({ bubbles: document.querySelectorAll('#messages .message').length, modal: document.getElementById('fdAuth').classList.contains('fd-open') }));
    check('reload: session kept, no modal', !h.modal);
    check('reload: history restored from server', h.bubbles >= 4, 'bubbles=' + h.bubbles);
    await page.click('#newChatButton');
    await wait(400);
    check('new chat: cleared + welcome again', await page.evaluate(() => document.querySelectorAll('#messages .message').length === 0 && getComputedStyle(document.getElementById('welcome')).display !== 'none'));
  });

  await phase('chip-fallback', async () => {
    // Older markup used .chip: it must also trigger a send.
    await page.evaluate(() => {
      const host = document.querySelector('#quickPrompts') || document.body;
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.setAttribute('data-prompt', 'eSIM for Turkey');
      chip.textContent = 'eSIM for Turkey';
      host.appendChild(chip);
    });
    await wait(400);
    const before = await page.evaluate(() => document.querySelectorAll('#messages .message').length);
    await page.evaluate(() => document.querySelector('.chip').click());
    await wait(700);
    const after = await page.evaluate(() => ({
      total: document.querySelectorAll('#messages .message').length,
      userSaid: Array.from(document.querySelectorAll('#messages .message.user-message')).map((n) => n.textContent).join('|'),
    }));
    check('chip fallback: legacy .chip[data-prompt] sends too', after.total > before && /eSIM for Turkey/.test(after.userSaid), before + '->' + after.total);
    await page.evaluate(() => { const c = document.querySelector('.chip'); if (c) c.remove(); });
  });

  await phase('menu', async () => {
    await page.click('#fdMenuCaret');
    await wait(300);
    const m = await page.evaluate(() => {
      const el = document.getElementById('fdMenu'), cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { hidden: el.hidden, items: Array.from(el.querySelectorAll('.fd-menu-item .fd-menu-label')).map((b) => b.textContent.trim()), icons: Array.from(el.querySelectorAll('.fd-menu-item .fd-menu-icon')).map((b) => b.textContent.trim()), bg: cs.backgroundColor, radius: cs.borderRadius, border: cs.borderColor };
    });
    const want = ['File Manager', 'Tools & MCP', 'Images', 'Database', 'R2 Storage', 'Settings', 'Logout'];
    check('menu: opens', !m.hidden);
    check('menu: items match spec order', JSON.stringify(m.items) === JSON.stringify(want), m.items.join(','));
    check('menu: icons match spec', JSON.stringify(m.icons) === JSON.stringify(['📁', '🛠️', '🖼️', '🗄️', '☁️', '⚙️', '🚪']), m.icons.join(''));
    check('menu: dark theme tokens', m.bg === 'rgb(10, 10, 10)' && m.radius === '16px' && m.border === 'rgb(38, 38, 38)', m.bg + ' ' + m.radius + ' ' + m.border);
    await page.mouse.click(30, 300);
    await wait(300);
    check('menu: click outside closes', await page.evaluate(() => document.getElementById('fdMenu').hidden));
  });

  async function panelOf(index) {
    await page.click('#fdMenuCaret'); await wait(250);
    await page.click(`#fdMenu .fd-menu-item:nth-child(${index})`); await wait(1400);
  }
  async function closePanel() { await page.click('#fdPanelClose'); await wait(350); }

  await phase('panel-files', async () => {
    await page.setInputFiles('#fileInput', [{ name: 'visa-checklist.txt', mimeType: 'text/plain', buffer: Buffer.from('checklist: passport, photo, funds') }]);
    await wait(1200);
    await page.evaluate(() => document.getElementById('messageInput').value = 'notes on my checklist');
    await page.keyboard.press('Enter');
    await wait(2500);
    await panelOf(1);
    const p = await page.evaluate(() => ({ open: document.getElementById('fdPanel').classList.contains('fd-open'), title: document.getElementById('fdPanelTitle').textContent, rows: document.querySelectorAll('#fdPanelBody .fd-row').length, search: !!document.querySelector('#fdPanelBody input[type="search"]'), behind: !!document.getElementById('chatForm') }));
    check('files panel: opens, chat untouched behind', p.open && p.behind && /File Manager/.test(p.title), p.title);
    check('files panel: lists uploaded file + search', p.rows >= 1 && p.search, 'rows=' + p.rows);
    await closePanel();
  });

  await phase('panel-tools', async () => {
    await panelOf(2);
    check('tools panel: 5 toggles', await page.evaluate(() => document.querySelectorAll('#fdPanelBody .fd-switch').length === 5));
    await page.click('#fdPanelBody .fd-switch');
    await wait(500);
    check('tools panel: toggle persisted to D1 settings', await page.evaluate(async () => {
      const r = await fetch('/api/tools', { credentials: 'same-origin' });
      const j = await r.json();
      return j.tools && j.tools.web_search === false;
    }));
    await page.fill('#fdPanelBody input[name="name"]', 'Visa MCP');
    await page.fill('#fdPanelBody input[name="url"]', mcpDoubleUrl);
    await page.fill('#fdPanelBody input[name="key"]', 'sk-test');
    await page.click('#fdPanelBody .fd-btn--primary');
    await wait(1000);
    check('mcp: server added', await page.evaluate((url) => document.getElementById('fdPanelBody').textContent.includes(url), mcpDoubleUrl));
    await page.click('#fdPanelBody .fd-mini');
    await wait(1000);
    check('mcp: test connection reports Connected', await page.evaluate(() => /Connected/.test(document.getElementById('fdPanelBody').textContent)));
    await closePanel();
  });

  await phase('panel-images', async () => {
    await panelOf(3);
    await page.fill('#fdPanelBody textarea', 'a red dragon over Dhaka');
    await page.click('#fdPanelBody .fd-btn--primary');
    await wait(1400);
    check('images: generate + gallery thumb', await page.evaluate(() => document.querySelectorAll('#fdPanelBody .fd-thumb img').length > 0));
    await closePanel();
  });

  await phase('panel-db', async () => {
    await panelOf(4);
    check('database: user stats shown', await page.evaluate(() => document.querySelectorAll('#fdPanelBody .fd-stat').length >= 4));
    await closePanel();
  });

  await phase('panel-storage', async () => {
    await panelOf(5);
    const s = await page.evaluate(() => ({ bar: !!document.querySelector('#fdPanelBody .fd-progress span'), text: document.getElementById('fdPanelBody').textContent }));
    check('storage: progress bar + objects', s.bar && /used/.test(s.text));
    await closePanel();
  });

  await phase('panel-settings', async () => {
    await panelOf(6);
    const before = await page.evaluate(() => getComputedStyle(document.getElementById('messages')).fontSize);
    await page.selectOption('#fdPanelBody select', 'large');
    await wait(500);
    const after = await page.evaluate(() => getComputedStyle(document.getElementById('messages')).fontSize);
    check('settings: font size applies', before !== after, before + '->' + after);
    check('settings: danger zone present', await page.evaluate(() => {
      const t = document.getElementById('fdPanelBody').textContent;
      return /Clear all chats/.test(t) && /Delete account/.test(t);
    }));
    await closePanel();
  });

  await phase('logout', async () => {
    await page.click('#fdMenuCaret'); await wait(250);
    await page.click('#fdMenu .fd-menu-item:last-child');
    await wait(900);
    check('logout: gate returns + composer locked', await page.evaluate(() =>
      document.getElementById('fdAuth').classList.contains('fd-open') && document.getElementById('messageInput').readOnly));
  });

  await phase('mobile', async () => {
    const mob = await ctx.newPage();
    await mob.setViewportSize({ width: 390, height: 780 });
    await mob.goto(URL_BASE, { waitUntil: 'load' });
    await wait(1200);
    await mob.evaluate((mail) => fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mail, password: 'Sup3rSecret!' }) }), email);
    await mob.reload({ waitUntil: 'load' });
    await wait(2200);
    await mob.click('#fdMenuCaret'); await wait(500);
    const sheet = await mob.evaluate(() => {
      const m = document.getElementById('fdMenu'), r = m.getBoundingClientRect();
      return { cls: m.className, w: Math.round(r.width), left: Math.round(r.left), vw: window.innerWidth, bottom: Math.round(r.bottom), vh: window.innerHeight, font: getComputedStyle(m).fontSize };
    });
    check('mobile: menu is full-width bottom sheet', /fd-menu--sheet/.test(sheet.cls) && sheet.left === 0 && sheet.w === sheet.vw && Math.abs(sheet.bottom - sheet.vh) < 2, JSON.stringify(sheet));
    await mob.click('#fdMenu .fd-menu-item:nth-child(1)'); await wait(1200);
    const box = await mob.evaluate(() => { const r = document.getElementById('fdPanel').getBoundingClientRect(); return { w: Math.round(r.width), vw: window.innerWidth }; });
    check('mobile: panel full width', box.w === box.vw, JSON.stringify(box));
    await mob.screenshot({ path: path.join(__dirname, 'artifacts', 'mobile.png') });
    await mob.close();
  });

  await page.goto(URL_BASE, { waitUntil: 'load' });
  await wait(1200);
  await page.evaluate((mail) => fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mail, password: 'Sup3rSecret!' }) }), email);
  await page.reload({ waitUntil: 'load' });
  await wait(2200);
  await page.evaluate(() => document.querySelector('.prompt-card').click());
  await wait(2500);
  await page.screenshot({ path: path.join(__dirname, 'artifacts', 'desktop.png') });

  console.log(out.join('\n'));
  console.log('SUMMARY: ' + out.filter((r) => r.startsWith('PASS')).length + ' pass, ' + out.filter((r) => r.startsWith('FAIL')).length + ' fail, ' + out.filter((r) => r.startsWith('SKIP')).length + ' skipped');
  console.log('DIAGNOSTICS: ' + (err.length ? err.slice(0, 10).join(' || ') : 'clean'));
  await browser.close();
  child.kill('SIGKILL');
})().catch((e) => { console.log(out.join('\n'), '\nFATAL', e.message); process.exit(2); });
