/**
 * Определение страны по IP без обращения наружу.
 *
 * Зачем вообще своя таблица. Страна сессии раньше бралась только из заголовка
 * `cf-ipcountry`, который ставит Cloudflare. Перед vault.dobropalm.tech
 * Cloudflare не стоит — DNS-запись указывает прямо на origin, — поэтому
 * заголовка нет ни в одном запросе, и список «Активные сессии» показывал
 * «Регион не определён» для каждого устройства.
 *
 * Почему не внешний API. Мессенджер обещает, что сервер видит минимум. Отдавать
 * IP пользователя стороннему геосервису — ровно то, чего обещание не допускает:
 * появляется третья сторона, знающая, кто и откуда подключается. Сервер и так
 * видит адрес соединения, поэтому разрешение страны на нём самом ничего нового
 * не раскрывает.
 *
 * Откуда данные. Файлы delegated-*-extended-latest пяти RIR — открытые,
 * без лицензионного ключа и без регистрации. `tools/build-geoip.js` собирает
 * из них компактную таблицу в CLOUD_VAULT_DIR. Файла может не быть: тогда
 * lookup честно отвечает null, а список сессий выглядит ровно как до этой
 * правки, без падений.
 */
const fs = require('fs');
const path = require('path');

const MAGIC = 'AGC1';
const HEADER_BYTES = 12;

let cache = null;

function emptyTable() {
  return {
    v4Starts: new Uint32Array(0),
    v4Ends: new Uint32Array(0),
    v4Cc: Buffer.alloc(0),
    v6Starts: new BigUint64Array(0),
    v6Ends: new BigUint64Array(0),
    v6Cc: Buffer.alloc(0),
  };
}

function tablePath(dir) {
  return path.join(dir, 'geoip-country.bin');
}

/**
 * Разбор файла таблицы. Любая неожиданность — короткий файл, чужая сигнатура,
 * счётчики, не сходящиеся с размером — означает пустую таблицу, а не исключение:
 * геоданные украшают экран сессий, ронять из-за них синхронизацию нельзя.
 */
function parseTable(buf) {
  if (buf.length < HEADER_BYTES || buf.toString('latin1', 0, 4) !== MAGIC) return emptyTable();
  const v4Count = buf.readUInt32BE(4);
  const v6Count = buf.readUInt32BE(8);
  const expected = HEADER_BYTES + v4Count * 10 + v6Count * 18;
  if (!Number.isSafeInteger(v4Count) || !Number.isSafeInteger(v6Count) || buf.length !== expected) {
    return emptyTable();
  }
  const v4Starts = new Uint32Array(v4Count);
  const v4Ends = new Uint32Array(v4Count);
  const v4Cc = Buffer.alloc(v4Count * 2);
  let off = HEADER_BYTES;
  for (let i = 0; i < v4Count; i += 1) {
    v4Starts[i] = buf.readUInt32BE(off);
    v4Ends[i] = buf.readUInt32BE(off + 4);
    v4Cc[i * 2] = buf[off + 8];
    v4Cc[i * 2 + 1] = buf[off + 9];
    off += 10;
  }
  const v6Starts = new BigUint64Array(v6Count);
  const v6Ends = new BigUint64Array(v6Count);
  const v6Cc = Buffer.alloc(v6Count * 2);
  for (let i = 0; i < v6Count; i += 1) {
    v6Starts[i] = buf.readBigUInt64BE(off);
    v6Ends[i] = buf.readBigUInt64BE(off + 8);
    v6Cc[i * 2] = buf[off + 16];
    v6Cc[i * 2 + 1] = buf[off + 17];
    off += 18;
  }
  return { v4Starts, v4Ends, v4Cc, v6Starts, v6Ends, v6Cc };
}

function loadTable(dir) {
  if (cache && cache.dir === dir) return cache.table;
  let table = emptyTable();
  try {
    table = parseTable(fs.readFileSync(tablePath(dir)));
  } catch {
    // Файла нет или он нечитаем — работаем без геоданных.
  }
  cache = { dir, table };
  return table;
}

/** Сбросить кеш таблицы. Нужен тестам и перезагрузке после обновления файла. */
function resetGeoipCache() {
  cache = null;
}

/**
 * IPv4 в 32-битное число. Возвращает null на всём, что не четыре октета 0..255,
 * включая записи с ведущими нулями: «010.0.0.1» разные библиотеки читают
 * по-разному (десятично или восьмерично), и такой адрес лучше не угадывать.
 */
function ipv4ToInt(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/**
 * Верхние 64 бита IPv6. Выделения RIR не мельче /64 — по этим битам таблица и
 * построена, младшая половина адреса на страну не влияет.
 */
function ipv6ToTop64(text) {
  const zone = text.indexOf('%');
  const addr = zone === -1 ? text : text.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(addr) || (addr.match(/::/g) || []).length > 1) return null;
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups = [];
  const push = (parts) => {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.includes('.')) {
        // Хвост вида ::ffff:1.2.3.4 — последние две группы записаны как IPv4.
        if (i !== parts.length - 1) return false;
        const v4 = ipv4ToInt(part);
        if (v4 === null) return false;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
      groups.push(parseInt(part, 16));
    }
    return true;
  };
  if (!push(headParts)) return null;
  const headLen = groups.length;
  const tailStart = groups.length;
  if (!push(tailParts)) return null;
  const tailLen = groups.length - tailStart;
  if (tail === null) {
    if (groups.length !== 8) return null;
  } else {
    if (headLen + tailLen > 7) return null;
    groups.splice(headLen, 0, ...new Array(8 - headLen - tailLen).fill(0));
  }
  let top = 0n;
  for (let i = 0; i < 4; i += 1) top = (top << 16n) | BigInt(groups[i]);
  return top;
}

/** Индекс последнего диапазона, чьё начало не больше value, или -1. */
function findRange(starts, value) {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function ccAt(buf, index) {
  const cc = buf.toString('latin1', index * 2, index * 2 + 2);
  return /^[A-Z]{2}$/.test(cc) ? cc : null;
}

/**
 * Код страны по адресу, или null. Адреса приходят из `req.ip`, а тот за Nginx
 * может выглядеть как «::ffff:203.0.113.7» — такую форму разворачиваем в IPv4,
 * иначе IPv6-ветка искала бы её среди настоящих IPv6-выделений.
 */
function lookupCountry(ip, dir) {
  if (typeof ip !== 'string') return null;
  const raw = ip.trim();
  if (!raw) return null;
  const table = loadTable(dir);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  const plain = mapped ? mapped[1] : raw;
  const v4 = ipv4ToInt(plain);
  if (v4 !== null) {
    const idx = findRange(table.v4Starts, v4);
    if (idx === -1 || table.v4Ends[idx] < v4) return null;
    return ccAt(table.v4Cc, idx);
  }
  const top = ipv6ToTop64(raw);
  if (top === null) return null;
  const idx = findRange(table.v6Starts, top);
  if (idx === -1 || table.v6Ends[idx] < top) return null;
  return ccAt(table.v6Cc, idx);
}

module.exports = { MAGIC, HEADER_BYTES, lookupCountry, resetGeoipCache, tablePath, ipv4ToInt, ipv6ToTop64 };
