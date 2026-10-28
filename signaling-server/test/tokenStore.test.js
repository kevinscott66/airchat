'use strict';

/**
 * Дисковое хранилище токенов. Смысл всей затеи в одном предложении: токен
 * обязан пережить перезапуск ретранслятора, потому что второй раз его никто
 * не пришлёт до следующего запуска приложения.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMemoryTokenRegistry,
  createSqliteTokenRegistry,
  createTokenStore,
} = require('../tokenStore');

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-push-'));
  return path.join(dir, name);
}

test('токен переживает перезапуск процесса', () => {
  const file = tempDb('tokens.db');
  const first = createSqliteTokenRegistry({ path: file });
  first.set('peer', 'device-token', 'android', 10);
  first.close();

  const second = createSqliteTokenRegistry({ path: file });
  const entry = second.get('peer');
  assert.equal(entry.token, 'device-token');
  assert.equal(entry.platform, 'android');
  assert.equal(entry.ts, 10);
  second.close();
});

test('старая подпись не откатывает токен и на диске', () => {
  const store = createSqliteTokenRegistry({ path: ':memory:' });
  assert.equal(store.set('peer', 'new', 'ios', 20), true);
  // Перехваченный запрос пятиминутной давности внутри окна повтора.
  assert.equal(store.set('peer', 'old', 'ios', 19), false);
  assert.equal(store.get('peer').token, 'new');
  store.close();
});

test('протухший токен не отдаётся и удаляется', () => {
  let clock = 1000;
  const store = createSqliteTokenRegistry({ path: ':memory:', ttlMs: 100, now: () => clock });
  store.set('peer', 'token', 'android', 1);
  clock += 101;
  assert.equal(store.get('peer'), null);
  assert.equal(store.size, 0);
  store.close();
});

test('переполнение сначала чистит протухшие, потом отказывает', () => {
  let clock = 1000;
  const store = createSqliteTokenRegistry({ path: ':memory:', ttlMs: 100, maxTokens: 2, now: () => clock });
  store.set('a', 'ta', 'android', 1);
  store.set('b', 'tb', 'android', 1);
  assert.equal(store.set('c', 'tc', 'android', 1), false);
  clock += 101;
  // Место освободилось само: старые записи уходят под новую, а не наоборот.
  assert.equal(store.set('c', 'tc', 'android', 1), true);
  assert.equal(store.get('c').token, 'tc');
  store.close();
});

test('удаление протухшего токена доходит до диска', () => {
  const file = tempDb('stale.db');
  const first = createSqliteTokenRegistry({ path: file });
  first.set('peer', 'token', 'ios', 1);
  assert.equal(first.delete('peer'), true);
  assert.equal(first.delete('peer'), false);
  first.close();

  const second = createSqliteTokenRegistry({ path: file });
  assert.equal(second.get('peer'), null);
  second.close();
});

test('без PUSH_TOKEN_DB хранилище остаётся в памяти', () => {
  const store = createTokenStore({ env: {} });
  assert.equal(store.persistent, false);
  store.set('peer', 'token', 'android', 1);
  assert.equal(store.get('peer').token, 'token');
});

test('с PUSH_TOKEN_DB хранилище дисковое', () => {
  const file = tempDb('env.db');
  const store = createTokenStore({ env: { PUSH_TOKEN_DB: file } });
  assert.equal(store.persistent, true);
  store.set('peer', 'token', 'ios', 1);
  store.close();
  assert.ok(fs.existsSync(file));
});

test('нерабочий путь не роняет ретранслятор, а отступает в память', () => {
  const lines = [];
  // Каталога не существует: сигналинг обязан подняться и без push.
  const store = createTokenStore({
    env: { PUSH_TOKEN_DB: '/nonexistent-airchat-dir/tokens.db' },
    log: (event) => lines.push(event),
  });
  assert.equal(store.persistent, false);
  assert.ok(lines.includes('push_tokens_disk_failed'));
});

test('память и диск ведут себя одинаково', () => {
  for (const store of [
    createMemoryTokenRegistry({ ttlMs: 100, now: () => 1000 }),
    createSqliteTokenRegistry({ path: ':memory:', ttlMs: 100, now: () => 1000 }),
  ]) {
    assert.equal(store.get('нет такого'), null);
    assert.equal(store.set('peer', 't', 'android', 5), true);
    assert.equal(store.set('peer', 't', 'android', 5), false);
    assert.equal(store.size, 1);
    assert.deepEqual(
      { token: store.get('peer').token, platform: store.get('peer').platform, ts: store.get('peer').ts },
      { token: 't', platform: 'android', ts: 5 }
    );
    store.close();
  }
});

test('stale delivery removes only the registration that was actually sent', () => {
  for (const store of [createMemoryTokenRegistry(), createSqliteTokenRegistry()]) {
    store.set('peer', 'old', 'android', 1);
    const sent = store.get('peer');
    store.set('peer', 'new', 'android', 2);
    assert.equal(store.deleteIfCurrent('peer', sent), false);
    assert.equal(store.get('peer').token, 'new');
    // Timestamp also matters when the provider token stayed the same.
    const beforeRenewal = store.get('peer');
    store.set('peer', 'new', 'android', 3);
    assert.equal(store.deleteIfCurrent('peer', beforeRenewal), false);
    assert.equal(store.deleteIfCurrent('peer', store.get('peer')), true);
    assert.equal(store.get('peer'), null);
    store.close();
  }
});

test('device slots are bounded and independent, including revocation replay protection', () => {
  for (const store of [createMemoryTokenRegistry({ maxDevices: 2 }), createSqliteTokenRegistry({ maxDevices: 2 })]) {
    assert.equal(store.set('peer', 'android', 'android', 1, 'phone'), true);
    assert.equal(store.set('peer', 'browser', 'web', 1, 'browser'), true);
    assert.equal(store.set('peer', 'extra', 'ios', 1, 'extra'), false);
    assert.equal(store.set('peer', 'rotated', 'android', 2, 'phone'), true);
    assert.equal(store.list('peer').length, 2);
    assert.equal(store.revoke('peer', 'phone', 3), true);
    assert.equal(store.get('peer', 'phone'), null);
    assert.equal(store.set('peer', 'replayed', 'android', 2, 'phone'), false);
    assert.equal(store.get('peer', 'browser').token, 'browser');
    store.close();
  }
});

test('legacy SQLite schema migrates once and preserves its registration', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = tempDb('legacy.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE push_tokens(peer_id TEXT PRIMARY KEY, token TEXT NOT NULL,
    platform TEXT NOT NULL, updated_at INTEGER NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX push_tokens_updated_at ON push_tokens(updated_at);`);
  db.prepare('INSERT INTO push_tokens VALUES (?, ?, ?, ?, ?)').run('peer', 'old', 'ios', Date.now(), 1);
  db.close();
  const store = createSqliteTokenRegistry({ path: file });
  assert.equal(store.get('peer').token, 'old');
  assert.equal(store.set('peer', 'new', 'android', 2, 'phone'), true);
  assert.equal(store.list('peer').length, 2);
  store.delete('peer');
  store.close();
  const reopened = createSqliteTokenRegistry({ path: file });
  assert.equal(reopened.get('peer'), null);
  assert.equal(reopened.get('peer', 'phone').token, 'new');
  reopened.close();
});

for (const [name, create] of [['memory', createMemoryTokenRegistry], ['SQLite', createSqliteTokenRegistry]]) {
  test(`${name}: absent-device revoke blocks delayed enrollment and newer revoke refreshes marker`, () => {
    let clock = 1000;
    const store = create({ now: () => clock, ttlMs: 1, maxDevices: 1 });
    assert.equal(store.revoke('peer', 'phone', 20), true);
    assert.equal(store.set('peer', 'delayed', 'android', 19, 'phone'), false);
    clock += 100;
    assert.equal(store.revoke('peer', 'phone', 30), true);
    assert.equal(store.set('peer', 'delayed', 'android', 25, 'phone'), false);
    clock += 600000;
    // Inclusive freshness boundary: token TTL and quota sweeps cannot drop the marker early.
    assert.equal(store.set('peer', 'other', 'ios', 40, 'other'), false);
    assert.equal(store.set('peer', 'delayed', 'android', 25, 'phone'), false);
    assert.deepEqual(store.list('peer'), []);
    clock += 1;
    assert.equal(store.set('peer', 'fresh', 'ios', 50, 'other'), true);
    store.close();
  });
  test(`${name}: absent revoke fails explicitly when bounded storage is full`, () => {
    const store = create({ maxTokens: 1 });
    store.set('existing', 'token', 'ios', 1, 'phone');
    assert.equal(store.revoke('peer', 'absent', 20), false);
    assert.equal(store.get('existing', 'phone').token, 'token');
    store.close();
  });
}
