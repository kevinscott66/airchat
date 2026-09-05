/**
 * Таблица «IP → страна»: разбор файла и поиск.
 *
 * Проверка строится на собранной здесь же маленькой таблице, а не на настоящей:
 * настоящая — рантайм-артефакт, качается из сети и меняется каждый день, и
 * тест, зависящий от неё, начал бы падать от чужих правок в реестрах.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { MAGIC, HEADER_BYTES, lookupCountry, resetGeoipCache, tablePath } = require('./geoip');

function ip4(text) {
  return text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

/** Записать таблицу в свежий каталог и вернуть путь к нему. */
function makeTable(v4, v6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-geoip-'));
  const buf = Buffer.alloc(HEADER_BYTES + v4.length * 10 + v6.length * 18);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt32BE(v4.length, 4);
  buf.writeUInt32BE(v6.length, 8);
  let off = HEADER_BYTES;
  for (const r of v4) {
    buf.writeUInt32BE(r.start, off);
    buf.writeUInt32BE(r.end, off + 4);
    buf.write(r.cc, off + 8, 2, 'latin1');
    off += 10;
  }
  for (const r of v6) {
    buf.writeBigUInt64BE(r.start, off);
    buf.writeBigUInt64BE(r.end, off + 8);
    buf.write(r.cc, off + 16, 2, 'latin1');
    off += 18;
  }
  fs.writeFileSync(tablePath(dir), buf);
  resetGeoipCache();
  return dir;
}

const V4 = [
  { start: ip4('1.0.0.0'), end: ip4('1.0.0.255'), cc: 'AU' },
  { start: ip4('8.8.8.0'), end: ip4('8.8.8.255'), cc: 'US' },
  { start: ip4('77.88.0.0'), end: ip4('77.88.255.255'), cc: 'RU' },
];
// Диапазоны обязаны идти по возрастанию начала — так их пишет сборщик, и на
// этом стоит двоичный поиск. Фикстура тоже отсортирована: перепутанный порядок
// здесь проверял бы не модуль, а собственную опечатку.
const V6 = [
  { start: 0x2001486048600000n, end: 0x2001486048600000n, cc: 'US' },
  { start: 0x2a0206b800000000n, end: 0x2a0206b8ffffffffn, cc: 'RU' },
];

test('адрес внутри диапазона отдаёт страну, снаружи — null', () => {
  const dir = makeTable(V4, V6);
  assert.equal(lookupCountry('8.8.8.8', dir), 'US');
  assert.equal(lookupCountry('77.88.55.242', dir), 'RU');
  assert.equal(lookupCountry('1.0.0.0', dir), 'AU');
  assert.equal(lookupCountry('1.0.0.255', dir), 'AU');
  // Ровно за верхней границей — уже ничьё: findRange находит диапазон, чьё
  // начало не больше адреса, и без проверки конца вернул бы AU на весь 1.x.
  assert.equal(lookupCountry('1.0.1.0', dir), null);
  assert.equal(lookupCountry('9.0.0.1', dir), null);
});

test('IPv4 в оболочке ::ffff: читается как IPv4', () => {
  const dir = makeTable(V4, V6);
  // За Nginx `req.ip` приходит именно в такой форме. Без разворачивания адрес
  // ушёл бы в ветку IPv6 и не нашёлся бы никогда.
  assert.equal(lookupCountry('::ffff:8.8.8.8', dir), 'US');
  assert.equal(lookupCountry('::FFFF:77.88.55.242', dir), 'RU');
});

test('IPv6 ищется по верхним 64 битам', () => {
  const dir = makeTable(V4, V6);
  assert.equal(lookupCountry('2a02:6b8::feed:0ff', dir), 'RU');
  assert.equal(lookupCountry('2a02:6b8:0:1::1', dir), 'RU');
  assert.equal(lookupCountry('2001:4860:4860::8888', dir), 'US');
  assert.equal(lookupCountry('2a03:2880::1', dir), null);
});

test('мусор и локальные адреса не выдумывают страну', () => {
  const dir = makeTable(V4, V6);
  for (const bad of ['', '   ', 'unknown', 'not-an-ip', '8.8.8', '8.8.8.8.8', '256.0.0.1',
    '127.0.0.1', '10.0.0.5', '192.168.1.1', 'fe80::1', '::', null, undefined, 42]) {
    assert.equal(lookupCountry(bad, dir), null, `на ${String(bad)} страна не должна находиться`);
  }
  // Ведущий ноль неоднозначен: часть парсеров читает 010 как восьмеричное.
  // Угадывать нельзя, и «не знаю» здесь безопаснее любого из двух ответов.
  assert.equal(lookupCountry('010.0.0.1', dir), null);
});

test('отсутствующий или испорченный файл не роняет сервер', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-geoip-none-'));
  resetGeoipCache();
  assert.equal(lookupCountry('8.8.8.8', empty), null);

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-geoip-bad-'));
  fs.writeFileSync(tablePath(broken), Buffer.from('не таблица вовсе'));
  resetGeoipCache();
  assert.equal(lookupCountry('8.8.8.8', broken), null);

  // Заголовок обещает больше записей, чем в файле байт: такой файл — обрыв
  // записи на середине, и читать его как валидный значит выдавать случайные
  // страны из соседних байтов.
  const truncated = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-geoip-cut-'));
  const head = Buffer.alloc(HEADER_BYTES + 10);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32BE(9999, 4);
  head.writeUInt32BE(0, 8);
  fs.writeFileSync(tablePath(truncated), head);
  resetGeoipCache();
  assert.equal(lookupCountry('8.8.8.8', truncated), null);
});
