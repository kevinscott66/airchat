'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { trustProxyEnabled, trustProxyMode, isLoopbackAddress, clientAddressFrom } = require('../wire');

test('без доверия прокси заголовок клиента ничего не решает (v4.32.617)', () => {
  const headers = { 'x-forwarded-for': '1.2.3.4', 'fly-client-ip': '5.6.7.8' };
  assert.equal(clientAddressFrom(headers, '203.0.113.9', false), '203.0.113.9');
  // И это состояние по умолчанию: голый порт наружу верит только сокету.
  assert.equal(trustProxyEnabled({}), false);
  assert.equal(trustProxyEnabled({ TRUST_PROXY: '' }), false);
  assert.equal(trustProxyEnabled({ TRUST_PROXY: '1' }), true);
  assert.equal(trustProxyEnabled({ TRUST_PROXY: 'true' }), true);
});

test('с доверием берётся последний участок цепочки, а не первый (v4.32.617)', () => {
  // Слева — то, что прислал сам клиент; справа прокси дописал настоящий адрес.
  const headers = { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' };
  assert.equal(clientAddressFrom(headers, '203.0.113.9', true), '198.51.100.7');
  // Проверка не пустая: подделанный первый участок наружу не выходит.
  assert.notEqual(clientAddressFrom(headers, '203.0.113.9', true), '1.2.3.4');
});

test('Fly-Client-IP старше цепочки (v4.32.617)', () => {
  const headers = { 'fly-client-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' };
  assert.equal(clientAddressFrom(headers, '203.0.113.9', true), '198.51.100.7');
});

test('мусор вместо адреса — адрес сокета (v4.32.617)', () => {
  const bad = { 'x-forwarded-for': 'not an address' };
  assert.equal(clientAddressFrom(bad, '203.0.113.9', true), '203.0.113.9');
  const tooLong = { 'fly-client-ip': '9'.repeat(200) };
  assert.equal(clientAddressFrom(tooLong, '203.0.113.9', true), '203.0.113.9');
  // Ни заголовков, ни адреса сокета — но и пустой строки в ответе быть не должно.
  assert.equal(clientAddressFrom(undefined, undefined, true), 'unknown');
});

test('TRUST_PROXY=1 вне Fly — режим локального прокси, Fly-Client-IP не читается (v4.32.721)', () => {
  assert.equal(trustProxyMode({ TRUST_PROXY: '1' }), 'loopback');
  assert.equal(trustProxyMode({ TRUST_PROXY: '1', FLY_APP_NAME: 'airchat-signaling' }), 'fly');
  assert.equal(trustProxyMode({ TRUST_PROXY: 'nginx' }), 'loopback');
  assert.equal(trustProxyMode({ TRUST_PROXY: 'fly' }), 'fly');
  assert.equal(trustProxyMode({}), 'off');
  // nginx не переписывает Fly-Client-IP: клиент подставил бы любой адрес.
  const spoofed = { 'fly-client-ip': '5.6.7.8', 'x-forwarded-for': '1.2.3.4, 198.51.100.7' };
  assert.equal(clientAddressFrom(spoofed, '127.0.0.1', 'loopback'), '198.51.100.7');
  assert.equal(clientAddressFrom(spoofed, '::ffff:127.0.0.1', 'loopback'), '198.51.100.7');
});

test('в режиме loopback заголовки от внешнего адреса игнорируются (v4.32.721)', () => {
  // Кто-то обошёл nginx и пришёл прямо на порт — ему не верим.
  const headers = { 'x-forwarded-for': '10.0.0.1' };
  assert.equal(clientAddressFrom(headers, '203.0.113.9', 'loopback'), '203.0.113.9');
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('127.0.0.1.evil'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
});
