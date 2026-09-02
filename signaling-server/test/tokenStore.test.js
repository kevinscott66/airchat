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
