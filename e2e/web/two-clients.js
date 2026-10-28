#!/usr/bin/env node
'use strict';

// Isolated real browser/backend acceptance. Never points a fixture identity at production.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const {
  execFileSync,
  spawn
} = require('node:child_process');
const {
  findChrome,
  serve,
  launchChrome,
  connect,
  sleep
} = require('./run');
const {
  createSignalingServer
} = require('../../signaling-server');
const source = path.resolve(process.argv[2] || 'dist');
const accountsOnly = process.argv.includes('--accounts-only');
const envFile = path.join(__dirname, '../../.env');
const sourceVaultUrl = process.env.AIRCHAT_TEST_VAULT_SOURCE_URL || (fs.existsSync(envFile) ? require('node:util').parseEnv(fs.readFileSync(envFile, 'utf8')).EXPO_PUBLIC_CLOUD_VAULT_URL : '');
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-browser-pair-'));
  const browsers = [],
    proxies = [],
    sockets = new Set(),
    blocked = new Set();
  let vault, signaling, syncDb, staticServer, relay;
  const responses = {};
  try {
    process.env.CLOUD_VAULT_DIR = path.join(dir, 'vault');
    process.env.SYNC_DB_FILE = path.join(dir, 'sync.sqlite');
    const service = require('../../server/cloud-vault');
    syncDb = service.syncDb;
    vault = service.app.listen(0, '127.0.0.1');
    await new Promise(r => vault.once('listening', r));
    signaling = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      env: {},
      log: () => {}
    });
    const signalPort = await signaling.listen();
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], {
      stdio: 'ignore'
    });
    async function proxy(port, label) {
      const server = https.createServer({
        key: fs.readFileSync(path.join(dir, 'key')),
        cert: fs.readFileSync(path.join(dir, 'cert'))
      }, (req, res) => {
        const upstream = http.request({
          hostname: '127.0.0.1',
          port,
          path: req.url,
          method: req.method,
          headers: req.headers
        }, r => {
          responses[`${label}:${req.method}:${r.statusCode}`] = (responses[`${label}:${req.method}:${r.statusCode}`] || 0) + 1;
          if (r.statusCode >= 400) {
            let failure = '';
            r.on('data', part => {
              if (failure.length < 2048) failure += part;
            });
            r.on('end', () => {
              try {
                const code = JSON.parse(failure).error;
                if (/^[a-z_]+$/.test(code)) console.error(`Local ${label} rejected request: ${r.statusCode} ${code}`);
              } catch {}
            });
          }
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
      });
      server.on('upgrade', (req, socket, head) => {
        sockets.add(socket);
        const upstream = net.connect(port, '127.0.0.1', () => {
          upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
          upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      proxies.push(server);
      return `https://127.0.0.1:${server.address().port}`;
    }
    const vaultUrl = await proxy(vault.address().port, 'vault'),
      signalUrl = await proxy(signalPort, 'signaling');
    let relayUrl = 'https://127.0.0.1:9';
    if (!accountsOnly) {
      if (!process.env.NTFY_BIN) throw Error('NTFY_BIN must point to a local ntfy server executable');
      const reservation = net.createServer();
      await new Promise(r => reservation.listen(0, '127.0.0.1', r));
      const relayPort = reservation.address().port;
      await new Promise(r => reservation.close(r));
      relayUrl = await proxy(relayPort, 'relay');
      const relayConfig = path.join(dir, 'ntfy.yml');
      fs.writeFileSync(relayConfig, '{}\n');
      relay = spawn(process.env.NTFY_BIN, ['serve', '--config', relayConfig, '--listen-http', `127.0.0.1:${relayPort}`, '--base-url', relayUrl, '--attachment-cache-dir', path.join(dir, 'attachments'), '--cache-file', path.join(dir, 'ntfy.sqlite')], {
        stdio: 'ignore',
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NTFY_')))
      });
      relay.on('error', () => {});
      let relayReady = false;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${relayPort}/v1/health`);
          if (r.ok) {
            relayReady = true;
            break;
          }
        } catch {}
        await sleep(100);
      }
      if (!relayReady) throw Error('Local ntfy startup failed');
    }
    const dist = path.join(dir, 'web');
    fs.cpSync(source, dist, {
      recursive: true
    });
    // Replace URL literals only in the disposable export. Existing production source is unchanged.
    function rewrite(folder) {
      for (const f of fs.readdirSync(folder, {
        withFileTypes: true
      })) {
        const p = path.join(folder, f.name);
        if (f.isDirectory()) rewrite(p);else if (p.endsWith('.js')) {
          let s = fs.readFileSync(p, 'utf8');
          if (sourceVaultUrl) s = s.split(sourceVaultUrl.replace(/\/$/, '')).join(vaultUrl);
          s = s.replace(/https:\/\/signaling\.dobropalm\.tech/g, signalUrl).replace(/https:\/\/[^\s'"`<>\\]+\/cloud-vault/g, vaultUrl).replace(/https:\/\/ntfy\.sh/g, relayUrl).replace(/wss:\/\/ntfy\.sh/g, relayUrl.replace('https:', 'wss:'));
          fs.writeFileSync(p, s);
        }
      }
    }
    rewrite(dist);
    staticServer = await serve(dist);
    const base = `http://127.0.0.1:${staticServer.address().port}/`;
    async function client(name) {
      const chrome = await launchChrome(findChrome(), ['--ignore-certificate-errors', '--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
      const cdp = await connect(chrome.wsUrl);
      browsers.push({
        chrome,
        cdp
      });
      const {
        targetId
      } = await cdp.send('Target.createTarget', {
        url: 'about:blank'
      });
      const {
        sessionId
      } = await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true
      });
      const send = (m, p) => cdp.send(m, p, sessionId);
      const downloadEvents = [];
      cdp.on(msg => {
        if (msg.method === 'Browser.downloadWillBegin') downloadEvents.push({
          event: 'begin',
          filename: msg.params.suggestedFilename
        });
        if (msg.method === 'Browser.downloadProgress') downloadEvents.push({
          event: 'progress',
          state: msg.params.state,
          received: msg.params.receivedBytes
        });
      });
      cdp.on(msg => {
        if (msg.sessionId === sessionId && msg.method === 'Fetch.requestPaused') {
          const u = new URL(msg.params.request.url);
          const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
          if (!local) blocked.add(u.hostname);
          void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
            requestId: msg.params.requestId,
            ...(!local ? {
              errorReason: 'BlockedByClient'
            } : {})
          }).catch(() => {});
        }
      });
      await send('Fetch.enable', {
        patterns: [{
          urlPattern: 'http*'
        }]
      });
      await send('Runtime.enable');
      await send('Page.navigate', {
        url: base
      });
      const evaluate = async expression => {
        const r = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          userGesture: true,
          awaitPromise: true
        });
        if (r.exceptionDetails) throw Error(`browser evaluation failed: ${expression.slice(0, 180)}`);
        return r.result.value;
      };
      const wait = async expression => {
        for (let i = 0; i < 120; i++) {
          if (await evaluate(expression).catch(() => false)) return;
          await sleep(250);
        }
        throw Error(`UI wait failed: ${expression}`);
      };
      const click = async id => {
        await wait(`(()=>{const e=document.querySelector('[data-testid="${id}"]');return e?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'})()`);
        const hitExpression = `(()=>{const e=document.querySelector('[data-testid="${id}"]');if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return hit&&(hit===e||e.contains(hit))?{x,y}:null})()`;
        await wait(hitExpression);
        const point = await evaluate(hitExpression);
        await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
        await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
      };
      await wait(`!!document.querySelector('[aria-label="Создать новый аккаунт"]')`);
      await evaluate(`document.querySelector('[aria-label="Создать новый аккаунт"]').click()`);
      await click('btn_seed_confirmed');
      await click('btn_seed_verify_later');
      await wait(`!!document.querySelector('[data-testid="login_username_input"]')`);
      await evaluate(`document.querySelector('[data-testid="login_username_input"]').focus()`);
      await send('Input.insertText', {
        text: name
      });
      await click('btn_login');
      await sleep(7000);
      await wait(`document.body.innerText.includes('${name}')`);
      await evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Профиль').click()`);
      await sleep(1000);
      await cdp.send('Browser.grantPermissions', {
        origin: base,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
      });
      await click('user_did');
      await sleep(300);
      const did = await evaluate('navigator.clipboard.readText()');
      if (!did.startsWith('https://')) throw Error('Profile did copy failed');
      const fill = async (id, text) => {
        await wait(`document.querySelector('[data-testid="${id}"]')?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})`);
        await evaluate(`(()=>{const field=document.querySelector('[data-testid="${id}"]');field.focus();field.select();})()`);
        await send('Input.insertText', { text });
        await wait(`document.querySelector('[data-testid="${id}"]')?.value===${JSON.stringify(text)}`);
      };
      return {
        downloadEvents,
        browserSend: (method, params) => cdp.send(method, params),
        send,
        evaluate,
        wait,
        click,
        fill,
        did
      };
    }
    const alice = await client('Browser Alice'),
      bob = await client('Browser Bob');
    console.log('PASS: two isolated fresh accounts created through UI');
    for (const self of [alice, bob]) {
      await self.click('tab_settings');
      await self.wait(`Array.from(document.querySelectorAll('*')).some(x=>x.childElementCount===0&&x.textContent==='Безопасность')`);
      await self.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Безопасность').click()`);
      await self.wait(`Array.from(document.querySelectorAll('*')).some(x=>x.childElementCount===0&&x.textContent==='Активные сессии')`);
      await self.evaluate(`Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&x.textContent==='Активные сессии').at(-1).click()`);
      await self.wait(`document.body.innerText.includes('Это устройство')`).catch(async error => {
        console.error('Session panel:', await self.evaluate(`document.body.innerText.slice(-1600)`));
        throw error;
      });
      if (!(await self.evaluate(`/Chrome|AirChat web|Неизвестный браузер/.test(document.body.innerText)`))) throw Error('Current session browser name missing');
      console.log('PASS: active sessions displays browser session and current-device badge');
      await self.evaluate(`Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&x.textContent==='Закрыть').at(-1).click()`);
      await self.click('tab_profile');
    }
    const devices = syncDb.db.prepare('SELECT COUNT(DISTINCT device_id) AS n, COUNT(DISTINCT account_id) AS accounts FROM sync_devices').get();
    if (devices.n !== 2 || devices.accounts !== 2) throw Error('Expected two distinct registered browser devices/accounts');
    console.log('PASS: server persisted two distinct device IDs and account IDs');
    if (accountsOnly) {
      console.log('Accounts/session checks only; messaging not tested');
      return;
    }
    for (const [self, other, name] of [[alice, bob, 'Browser Bob'], [bob, alice, 'Browser Alice']]) {
      await self.click('profile_plaque_contacts');
      await self.click('contacts_add');
      await self.fill('contacts_add_id_input', other.did);
      await self.fill('contacts_add_name_input', name);
      await self.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Готово').click()`);
      await sleep(1500);
      await self.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='${name}').click()`);
      await sleep(1000);
    }
    if (process.argv.includes('--groups-only')) { await require('./group-acceptance')(alice, bob); return; }
    await alice.evaluate(`document.querySelector('[placeholder="Сообщение"]').focus()`);
    await alice.send('Input.insertText', {
      text: 'Isolated browser message one'
    });
    await alice.evaluate(`document.querySelector('[aria-label="Отправить сообщение"]').click()`);
    await bob.wait(`document.body.innerText.includes('Isolated browser message one')`);
    await bob.wait(`!document.querySelector('[aria-label="Скрыть"]')`);
    await bob.wait(`document.body.innerText.includes('Isolated browser message one')`);
    console.log('PASS: two fresh accounts, reciprocal contacts, message received in second browser');
    async function message(from, to, text) {
      await from.evaluate(`document.querySelector('[placeholder="Сообщение"]').focus()`);
      await from.send('Input.insertText', {
        text
      });
      await from.evaluate(`document.querySelector('[aria-label="Отправить сообщение"]').click()`);
      await to.wait(`document.body.innerText.includes(${JSON.stringify(text)})`);
      await to.wait(`!document.querySelector('[aria-label="Скрыть"]')`);
      await to.wait(`document.body.innerText.includes(${JSON.stringify(text)})`);
    }
    const inertMarkup = '<img id="airchat-xss-fixture" src="data:image/png;base64,invalid" onerror="window.airchatE2eXss=1"><script>window.airchatE2eXss=1</script>';
    async function assertInert(client) {
      if (!(await client.evaluate(`!window.airchatE2eXss && !document.getElementById('airchat-xss-fixture') && !Array.from(document.scripts).some(s=>s.textContent.includes('airchatE2eXss'))`))) throw Error('HTML fixture created markup or executed');
    }
    async function postInertNews() {
      await alice.click('tab_feed'); await bob.click('tab_feed');
    await alice.wait(`!Array.from(document.querySelectorAll('[data-testid="loading_overlay"]')).some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`);
    await alice.click('btn_new_post');
    await alice.fill('feed_post_input', inertMarkup);
    await alice.click('btn_publish_post');
    await bob.wait(`document.body.innerText.includes(${JSON.stringify(inertMarkup)})`).catch(async error => { console.error('News sender UI:', await alice.evaluate(`document.body.innerText.slice(-1200)`)); console.error('News receiver fixture text:', await bob.evaluate(`Array.from(document.querySelectorAll('*')).filter(e=>e.childElementCount===0&&e.textContent.includes('airchat-xss-fixture')&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(e=>e.textContent)`)); throw error; });
    await bob.wait(`!document.querySelector('[aria-label="Скрыть"]')`);
    await bob.wait(`document.body.innerText.includes(${JSON.stringify(inertMarkup)})`);
    await assertInert(bob);
    console.log('PASS: HTML-shaped news post rendered literally without injected nodes or execution');
    }
    if (process.argv.includes('--news-security-only')) { await postInertNews(); return; }
    await message(alice, bob, inertMarkup);
    await assertInert(bob);
    console.log('PASS: HTML-shaped direct message rendered literally without injected nodes or execution');
    await message(bob, alice, 'Isolated reciprocal reply');
    console.log('PASS: reciprocal first-send delivery');
    await bob.send('Page.reload', {});
    await bob.wait(`document.body.innerText.includes('Browser Bob')`);
    await bob.click('tab_chat');
    await bob.wait(`document.body.innerText.includes('Browser Alice')`);
    await bob.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Browser Alice').click()`);
    await bob.wait(`document.body.innerText.includes('Isolated browser message one')`);
    await bob.wait(`document.body.innerText.includes('Isolated reciprocal reply')`);
    await message(alice, bob, 'Isolated message after reload');
    console.log('PASS: reload preserves account/history and receives new message');
    const viewportFailures = [];
    for (const [width, height] of [[1043, 988], [390, 640], [700, 400]]) {
      await bob.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      });
      await sleep(700);
      const layout = await bob.evaluate(`(()=>{const c=document.querySelector('[placeholder="Сообщение"]')?.getBoundingClientRect();const t=document.querySelector('[data-testid="tab_profile"]')?.getBoundingClientRect();const m=Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&x.textContent==='Isolated message after reload'&&x.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).at(-1)?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,composerTop:c?.top,composerBottom:c?.bottom,tabsTop:t?.top,messageTop:m?.top,messageBottom:m?.bottom}})()`);
      console.log('Viewport check:', layout);
      if (width === 700 && process.env.AIRCHAT_E2E_SCREENSHOT) {
        const shot = await bob.send('Page.captureScreenshot', {
          format: 'png'
        });
        fs.writeFileSync(path.resolve(process.env.AIRCHAT_E2E_SCREENSHOT), Buffer.from(shot.data, 'base64'));
      }
      if (!(layout.scrollWidth <= width + 1 && layout.composerTop >= 0 && layout.composerBottom <= layout.tabsTop + 1 && layout.messageTop >= 0 && layout.messageBottom <= layout.composerTop + 1)) viewportFailures.push(`${width}x${height}`);
    }
    await bob.send('Emulation.setDeviceMetricsOverride', {
      width: 700,
      height: 240,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(500);
    const historyProbe = await bob.evaluate(`(()=>{let e=Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&x.textContent==='Isolated message after reload'&&x.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).at(-1);while(e){if(e.scrollHeight-e.clientHeight>150&&/auto|scroll/.test(getComputedStyle(e).overflowY)){window.__acceptanceScrollBox=e;e.scrollTop=e.scrollHeight-e.clientHeight;return {height:e.clientHeight,content:e.scrollHeight,offset:e.scrollTop}}e=e.parentElement}return null})()`);
    if (historyProbe) {
      await sleep(300);
      await bob.send('Emulation.setDeviceMetricsOverride', {
        width: 700,
        height: 260,
        deviceScaleFactor: 1,
        mobile: false
      });
      await sleep(500);
      const historyScrollTop = await bob.evaluate(`window.__acceptanceScrollBox.scrollTop`);
      console.log('History offset before/after resize:', historyProbe.offset, historyScrollTop);
      if (historyScrollTop < 120 || Math.abs(historyScrollTop - historyProbe.offset) > 21) throw Error('Resize moved reader away from older messages');
      console.log('PASS: viewport resize preserves reading position away from bottom');
    } else console.log('NOT TESTED: insufficient overflowing history for scroll preservation');
    await bob.send('Emulation.clearDeviceMetricsOverride', {});
    if (viewportFailures.length) console.error('Viewport assertions failed:', viewportFailures.join(', '));else console.log('PASS: composer, latest message and tabs visible across viewport transitions');
    const fixture = path.join(dir, 'airchat-acceptance.txt');
    fs.writeFileSync(fixture, 'AirChat isolated attachment acceptance\n');
    await alice.send('Page.enable');
    await alice.send('Page.setInterceptFileChooserDialog', {
      enabled: true
    });
    await alice.evaluate(`document.querySelector('[aria-label="Прикрепить файл"]').click()`);
    await alice.wait(`Array.from(document.querySelectorAll('*')).some(x=>x.childElementCount===0&&x.textContent==='Файл')`);
    await alice.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Файл').click()`);
    await alice.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Выбрать из файлов').click()`);
    await alice.wait(`!!document.querySelector('input[type=file]')`);
    const dom = await alice.send('DOM.getDocument', {});
    const input = await alice.send('DOM.querySelector', {
      nodeId: dom.root.nodeId,
      selector: 'input[type=file]'
    });
    await alice.send('DOM.setFileInputFiles', {
      nodeId: input.nodeId,
      files: [fixture]
    });
    await bob.wait(`document.body.innerText.includes('airchat-acceptance.txt')`).catch(async error => {
      console.error('Attachment sender UI:', await alice.evaluate(`document.body.innerText.slice(-1200)`));
      throw error;
    });
    await bob.wait(`!document.querySelector('[aria-label="Скрыть"]')`);
    await bob.wait(`document.body.innerText.includes('airchat-acceptance.txt')`);
    console.log('PASS: document uploaded and received in second browser');
    const downloads = path.join(dir, 'downloads');
    fs.mkdirSync(downloads);
    await bob.browserSend('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true
    });
    console.log('Download capability:', await bob.evaluate(`({createURL:typeof URL.createObjectURL,blob:typeof Blob})`));
    const docPoint = await bob.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='airchat-acceptance.txt');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await bob.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...docPoint
    });
    await bob.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...docPoint
    });
    await sleep(1200);
    const targetsAfterDownload = await bob.browserSend('Target.getTargets', {});
    console.log('Download target routes:', targetsAfterDownload.targetInfos.map(t=>{try{const u=new URL(t.url);return {type:t.type,origin:u.origin,ipfs:u.pathname.startsWith('/ipfs/')}}catch{return {type:t.type}}}));
    console.log('Download notices:', await bob.evaluate(`Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&/не удалось|ошибка|нечем открыть|поврежд|недоступ/i.test(x.textContent)).map(x=>x.textContent.slice(0,180))`));
    const downloaded = path.join(downloads, 'airchat-acceptance.txt');
    for (let attempt = 0; attempt < 120 && !fs.existsSync(downloaded); attempt++) await sleep(250);
    if (!fs.existsSync(downloaded) || !fs.readFileSync(downloaded).equals(fs.readFileSync(fixture))) {
      console.error('Download diagnostics:', {
        events: bob.downloadEvents,
        files: fs.readdirSync(downloads)
      });
      console.error('Download UI:', await bob.evaluate(`document.body.innerText.slice(-1800)`));
      throw Error('Document download missing or byte mismatch');
    }
    console.log('PASS: received document downloaded with exact original bytes');
    if (!(responses['relay:PUT:200'] > 0 && responses['relay:GET:200'] > 0)) throw Error('Private document did not use real relay upload/download');
    if (targetsAfterDownload.targetInfos.some(target => {try {return new URL(target.url).pathname.startsWith('/ipfs/');} catch {return false;}})) throw Error('Private document unexpectedly opened an IPFS gateway');
    console.log('PASS: private document uses encrypted relay route without IPFS gateway navigation');

    await alice.click('tab_feed');
    await bob.click('tab_feed');
    await alice.click('btn_new_post');
    await alice.fill('feed_post_input', 'Isolated blue image post');
    const pngData = await alice.evaluate(`(()=>{const c=document.createElement('canvas');c.width=96;c.height=96;const x=c.getContext('2d');x.fillStyle='#0066ff';x.fillRect(0,0,96,96);return c.toDataURL('image/png').split(',')[1]})()`);
    const png = path.join(dir, 'airchat-acceptance.png');
    fs.writeFileSync(png, Buffer.from(pngData, 'base64'));
    await alice.evaluate(`Array.from(document.querySelectorAll('*')).find(x=>x.childElementCount===0&&x.textContent==='Фото').click()`);
    await alice.wait(`!!document.querySelector('input[type=file]')`);
    const imageDom = await alice.send('DOM.getDocument', {});
    const imageInput = await alice.send('DOM.querySelector', {
      nodeId: imageDom.root.nodeId,
      selector: 'input[type=file]'
    });
    await alice.send('DOM.setFileInputFiles', {
      nodeId: imageInput.nodeId,
      files: [png]
    });
    await alice.wait(`document.body.innerText.includes('Выбрано: 1')`);
    await alice.click('btn_publish_post');
    await bob.wait(`document.body.innerText.includes('Isolated blue image post')`);
    await bob.wait(`Array.from(document.images).some(i=>i.complete&&i.naturalWidth===96&&i.naturalHeight===96)`);
    const bluePixel = await bob.evaluate(`(()=>{const i=Array.from(document.images).find(i=>i.complete&&i.naturalWidth===96&&i.naturalHeight===96);const c=document.createElement('canvas');c.width=96;c.height=96;const x=c.getContext('2d');x.drawImage(i,0,0);return Array.from(x.getImageData(48,48,1,1).data)})()`);
    if (bluePixel[0] > 5 || Math.abs(bluePixel[1] - 102) > 5 || bluePixel[2] < 250) throw Error('Received image pixel does not match fixture');
    console.log('PASS: news photo published, received, decoded and pixel checked in second browser');
    await postInertNews();
    await require('./group-acceptance')(alice, bob);
    console.log('External requests denied:', blocked.size);
    if (viewportFailures.length) throw Error('Responsive viewport assertions failed');
  } catch (error) {
    console.error('Local backend HTTP response counts:', responses);
    throw error;
  } finally {
    for (const {
      chrome,
      cdp
    } of browsers) {
      cdp.close();
      await chrome.close();
    }
    for (const socket of sockets) socket.destroy();
    for (const p of proxies) p.closeAllConnections?.();
    for (const p of proxies) p.close();
    staticServer?.closeAllConnections?.();
    staticServer?.close();
    if (signaling) await signaling.close();
    if (vault) {
      vault.closeAllConnections?.();
      await new Promise(r => vault.close(r));
    }
    syncDb?.close();
    if (relay) {
      relay.kill('SIGTERM');
      await Promise.race([new Promise(r => relay.once('exit', r)), sleep(2000)]);
      if (relay.exitCode === null) relay.kill('SIGKILL');
    }
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}
main().then(() => process.exit(0)).catch(e => {
  console.error(e.message);
  process.exit(1);
});
