'use strict';

const { sleep } = require('./run');
const fs = require('fs');
const path = require('path');

// All mutations go through the rendered UI; no grants, roles or message rows
// are written directly into client/server storage by this acceptance test.
module.exports = async function groupAcceptance(alice, bob) {
  const name = 'Isolated permission group';
  const leaf = text => `Array.from(document.querySelectorAll('*')).filter(x=>x.childElementCount===0&&x.textContent===${JSON.stringify(text)}&&x.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).at(-1)`;
  async function captureConfirmation(client, stage) {
    const directory = process.env.AIRCHAT_E2E_CONFIRM_DIAGNOSTICS;
    if (!directory) return;
    if (!(await client.evaluate("['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)"))) {
      throw Error('Confirmation diagnostics require an isolated loopback fixture');
    }
    // Opt-in local fixture only. Never serialize text, HTML, URLs or storage.
    const snapshot = await client.evaluate(`(()=>{
      const describe=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,role:e.getAttribute('role'),tabindex:e.getAttribute('tabindex'),connected:e.isConnected,rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,visibility:s.visibility,opacity:s.opacity,pointerEvents:s.pointerEvents}};
      const candidates=Array.from(document.querySelectorAll('*')).filter(e=>e.childElementCount===0&&e.textContent==='Подтвердить'&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      return {viewport:{width:innerWidth,height:innerHeight},candidates:candidates.map(leaf=>{const target=leaf.closest('[role=button]')||leaf;const r=target.getBoundingClientRect();const ancestors=[];for(let e=leaf;e&&ancestors.length<12;e=e.parentElement)ancestors.push(describe(e));return {leaf:describe(leaf),target:describe(target),ancestors,hitStack:document.elementsFromPoint(r.left+r.width/2,r.top+r.height/2).map(describe)}})};
    })()`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `confirmation-${stage}.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(directory, `confirmation-${stage}.png`), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  }
  async function hitClick(client, expression, confirmation = false) {
    const hit = `(()=>{const leaf=(${expression});if(!leaf)return null;const e=leaf.closest('[role=button]')||leaf;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const top=document.elementFromPoint(x,y);return top&&(top===e||e.contains(top))?{x,y}:null})()`;
    if (confirmation) await captureConfirmation(client, 'arrival');
    try { await client.wait(hit); }
    catch (error) {
      if (confirmation) await captureConfirmation(client, 'failure');
      throw error;
    }
    const point = await client.evaluate(hit);
    await client.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await client.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
  }
  async function textClick(client, text) {
    await client.wait(`!!(${leaf(text)})`);
    await hitClick(client, leaf(text), text === 'Подтвердить');
    await sleep(250);
  }
  async function labelClick(client, label) {
    const selector = `[aria-label=${JSON.stringify(label)}]`;
    const visible = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`;
    await client.wait(`!!(${visible})`);
    await hitClick(client, visible);
    await sleep(250);
  }
  async function groupMessage(from, to, marker) {
    await from.evaluate(`Array.from(document.querySelectorAll('[placeholder="Сообщение"]')).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).focus()`);
    await from.send('Input.insertText', { text: marker });
    await labelClick(from, 'Отправить сообщение');
    await to.wait(`document.body.innerText.includes(${JSON.stringify(marker)})`);
    await to.wait(`!document.querySelector('[aria-label="Скрыть"]')`);
    await to.wait(`!!(${leaf(marker)})`);
    return to.evaluate(`${leaf(marker)}.closest('[tabindex="0"]')?.innerText`);
  }
  async function openMembers(client) {
    const header = leaf(name).replace('.at(-1)', '.at(0)');
    await client.wait(`!!(${header})`);
    await hitClick(client, header);
    await client.wait(`!!document.querySelector('[placeholder="Поиск участников…"]')`);
  }
  async function memberCard(client, member) {
    await openMembers(client);
    await textClick(client, member);
  }
  async function backToGroup(client) {
    await labelClick(client, 'Назад к группе');
    await client.wait(`!!Array.from(document.querySelectorAll('[placeholder="Сообщение"]')).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`);
  }
  await alice.click('tab_groups');
  await labelClick(alice, 'Создать группу или канал');
  await alice.wait(`!!document.querySelector('[placeholder="Название группы"]')`);
  await alice.evaluate(`document.querySelector('[placeholder="Название группы"]').focus()`);
  await alice.send('Input.insertText', { text: name });
  await textClick(alice, 'Browser Bob');
  await textClick(alice, 'Создать');
  await alice.wait(`!!Array.from(document.querySelectorAll('[placeholder="Сообщение"]')).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`);
  await bob.click('tab_groups');
  await textClick(bob, name);
  await bob.wait(`!!Array.from(document.querySelectorAll('[placeholder="Сообщение"]')).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`);
  if (await bob.evaluate(`document.body.innerText.includes('· сменить')`)) throw Error('Ordinary member unexpectedly has anonymous composer toggle');
  console.log('PASS: ordinary group member has no anonymous composer option');
  await groupMessage(alice, bob, 'Ordinary group baseline marker');
  console.log('PASS: ordinary group message is received before permission changes');

  await memberCard(alice, 'Вы (вы)');
  await textClick(alice, 'Разрешить писать от имени группы');
  await backToGroup(alice);
  await textClick(alice, 'От своего имени · сменить');
  let bubble = await groupMessage(alice, bob, 'Owner anonymous marker');
  if (!bubble?.includes(name) || bubble.includes('Browser Alice')) throw Error('Owner anonymous post has incorrect displayed author');
  console.log('PASS: owner grants self permission and posts as group');

  await memberCard(alice, 'Browser Bob');
  await textClick(alice, 'Назначить администратором');
  await textClick(alice, 'Подтвердить');
  await alice.wait(`!document.body.innerText.includes('Подтвердить')`);
  await openMembers(bob);
  await bob.wait(`${leaf('Browser Bob (вы)')}?.closest('[tabindex="0"]')?.innerText.includes('Админ')`);
  await backToGroup(bob);
  if (await bob.evaluate(`document.body.innerText.includes('· сменить')`)) throw Error('Promotion alone unexpectedly grants anonymous posting');
  console.log('PASS: admin role alone does not grant anonymous posting');

  await textClick(alice, 'Browser Bob');
  await textClick(alice, 'Разрешить писать от имени группы');
  await backToGroup(alice);
  await bob.wait(`document.body.innerText.includes('От своего имени · сменить')`);
  await textClick(bob, 'От своего имени · сменить');
  bubble = await groupMessage(bob, alice, 'Admin anonymous marker');
  if (!bubble?.includes(name) || bubble.includes('Browser Bob')) throw Error('Granted admin post has incorrect displayed author');
  console.log('PASS: owner grants admin permission and receiver displays group attribution');

  await memberCard(alice, 'Browser Bob');
  await textClick(alice, 'Запретить писать от имени группы');
  await backToGroup(alice);
  await bob.wait(`!document.body.innerText.includes('· сменить')`);
  bubble = await groupMessage(bob, alice, 'Admin revoked personal marker');
  if (!bubble?.includes('Browser Bob')) throw Error('Revoked admin did not return to personal attribution');
  console.log('PASS: revocation removes anonymous option and future message is personal');
  const historical = await alice.evaluate(`${leaf('Admin anonymous marker')}.closest('[tabindex="0"]')?.innerText`);
  if (!historical?.includes(name) || historical.includes('Browser Bob')) throw Error('Revocation changed an existing anonymous post author');
  await memberCard(alice, 'Вы (вы)');
  await textClick(alice, 'Запретить писать от имени группы');
  await backToGroup(alice);
  await alice.wait(`!document.body.innerText.includes('· сменить')`);
  bubble = await groupMessage(alice, bob, 'Owner revoked personal marker');
  if (!bubble?.includes('Browser Alice')) throw Error('Owner self revocation did not return to personal attribution');
  console.log('PASS: owner self revocation affects future messages; existing anonymous display is retained');

};
