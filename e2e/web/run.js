#!/usr/bin/env node
/**
 * Web smoke E2E over the exported bundle (dist/).
 *
 * Serves dist/ on a local port, drives headless Chrome over the DevTools
 * protocol (no extra npm dependencies: Node 22 has a global WebSocket) and
 * checks the first screen a new user sees:
 *   - the app boots without uncaught exceptions and renders text;
 *   - every button has a role and an accessible name;
 *   - no horizontal overflow at phone width (390px);
 *   - the restore path opens a text field;
 *   - nothing creates an account or writes to production servers.
 *
 * Usage: node e2e/web/run.js [distDir]   (CHROME_PATH overrides the browser)
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIST = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'dist'));
const WIDTH = 390;
const HEIGHT = 844;
const BOOT_TIMEOUT_MS = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function serve(root) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html'); // SPA fallback
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchChrome(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-e2e-'));
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited with ${code}`)));
  });
  return {
    wsUrl,
    close() {
      proc.kill('SIGKILL');
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, on: (fn) => listeners.push(fn), close: () => ws.close() });
    ws.onerror = () => reject(new Error('CDP connection failed'));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`e2e:web: ${DIST}/index.html not found — run "npm run web:export" first`);
    process.exit(1);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('e2e:web: Chrome not found (set CHROME_PATH)');
    process.exit(1);
  }

  const server = await serve(DIST);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await launchChrome(chromePath);
  const cdp = await connect(chrome.wsUrl);
  const failures = [];
  const fail = (msg) => failures.push(msg);

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => cdp.send(method, params, sessionId);
    const evaluate = async (expression) => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };

    const exceptions = [];
    const writes = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const { method, url } = msg.params.request;
        if (method !== 'GET' && method !== 'OPTIONS' && !url.startsWith(base)) writes.push(`${method} ${url}`);
      }
    });

    await s('Runtime.enable');
    await s('Network.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
    await s('Page.navigate', { url: base });

    // Wait until React has rendered something interactive.
    const started = Date.now();
    let booted = false;
    while (Date.now() - started < BOOT_TIMEOUT_MS) {
      booted = await evaluate(
        "document.body.innerText.trim().length > 20 && document.querySelectorAll('[role=button],button').length > 0",
      ).catch(() => false);
      if (booted) break;
      await sleep(250);
    }
    await sleep(1000); // let entrance animations settle
    if (!booted) fail(`first screen did not render within ${BOOT_TIMEOUT_MS / 1000}s`);

    if (booted) {
      const report = await evaluate(`(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim();
        const buttons = [...document.querySelectorAll('[role=button],button')].filter(visible);
        const unnamed = buttons.filter((b) => !name(b)).map((b) => b.outerHTML.slice(0, 120));
        // Pressable elements rendered without a role (cursor:pointer but no role).
        const roleless = [...document.querySelectorAll('div[tabindex="0"]')]
          .filter((el) => visible(el) && !el.getAttribute('role') && getComputedStyle(el).cursor === 'pointer')
          .map((el) => (el.innerText || el.outerHTML).trim().slice(0, 60));
        return {
          buttons: buttons.map(name),
          unnamed,
          roleless,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      })()`);

      if (report.unnamed.length) fail(`buttons without accessible name: ${report.unnamed.join(' | ')}`);
      if (report.roleless.length) fail(`clickable elements without role: ${report.roleless.join(' | ')}`);
      if (report.scrollWidth > report.innerWidth + 1) {
        fail(`horizontal overflow at ${WIDTH}px: scrollWidth ${report.scrollWidth} > ${report.innerWidth}`);
      }
      console.log(`e2e:web: first screen buttons: ${report.buttons.join(' · ')}`);

      // Restore path: the restore button must lead to a text field.
      const clicked = await evaluate(`(() => {
        const b = [...document.querySelectorAll('[role=button],button')]
          .find((el) => /восстанов|restore|уже есть|have an account/i.test(el.getAttribute('aria-label') || el.innerText || ''));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!clicked) {
        fail('no restore / "already have an account" button on the first screen');
      } else {
        let hasField = false;
        for (let i = 0; i < 20 && !hasField; i++) {
          await sleep(250);
          hasField = await evaluate("document.querySelectorAll('input,textarea').length > 0");
        }
        if (!hasField) fail('restore path did not show a text field');
      }
    }

    if (exceptions.length) fail(`uncaught exceptions: ${exceptions.slice(0, 3).join(' | ')}`);
    if (writes.length) fail(`unexpected writes to external servers: ${writes.join(', ')}`);
  } finally {
    cdp.close();
    chrome.close();
    server.close();
  }

  if (failures.length) {
    console.error('e2e:web: FAIL');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('e2e:web: OK');
}

main().catch((err) => {
  console.error(`e2e:web: ${err.stack || err}`);
  process.exit(1);
});
