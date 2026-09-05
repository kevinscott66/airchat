#!/usr/bin/env node
/**
 * Сборка таблицы «IP → страна» из открытых файлов RIR.
 *
 * Запускается вручную или по таймеру: `node tools/build-geoip.js`. Результат —
 * geoip-country.bin в CLOUD_VAULT_DIR (по умолчанию ./data), который читает
 * geoip.js. Файл рантайм-артефакт, в репозитории его нет.
 *
 * Источник — delegated-*-extended-latest пяти RIR. Это публичная статистика
 * распределения адресов, без ключей и регистрации; формат построчный:
 * registry|cc|type|start|value|date|status|...
 * Для ipv4 value — количество адресов, для ipv6 — длина префикса.
 *
 * Скачивание идёт по одному источнику за раз и с явным таймаутом: файлы
 * лежат на чужих ftp-зеркалах, и зависший запрос не должен превращаться в
 * бесконечно висящий деплой. Частичный результат не записывается — если хоть
 * один RIR недоступен, старый файл остаётся нетронутым: неполная таблица тихо
 * показывала бы часть устройств без страны, и понять, что она неполная, было
 * бы неоткуда.
 */
const fs = require('fs');
const path = require('path');
const { MAGIC, HEADER_BYTES } = require('../geoip');

/**
 * По одному списку зеркал на каждый реестр: сначала сам реестр, затем зеркало
 * на ftp.ripe.net, где лежат копии всех пяти. Первая же сборка на сервере
 * оборвалась на середине десятимегабайтного файла APNIC — одного адреса на
 * реестр мало, когда качаешь с чужого ftp через полмира.
 */
const SOURCES = [
  ['https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest'],
  [
    'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
    'https://ftp.ripe.net/pub/stats/arin/delegated-arin-extended-latest',
  ],
  [
    'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
    'https://ftp.ripe.net/pub/stats/apnic/delegated-apnic-extended-latest',
  ],
  [
    'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
    'https://ftp.ripe.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  ],
  [
    'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
    'https://ftp.ripe.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
  ],
];

const FETCH_TIMEOUT_MS = 120_000;
const ATTEMPTS_PER_URL = 2;
const dataDir = process.env.CLOUD_VAULT_DIR || path.join(__dirname, '..', 'data');

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function ipv4ToInt(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipv6Top64(prefix) {
  const [head, tail] = prefix.includes('::') ? prefix.split('::') : [prefix, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups = headParts.map((p) => parseInt(p, 16));
  if (tail !== null) {
    const pad = 8 - headParts.length - tailParts.length;
    if (pad < 0) return null;
    for (let i = 0; i < pad; i += 1) groups.push(0);
    for (const p of tailParts) groups.push(parseInt(p, 16));
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  let top = 0n;
  for (let i = 0; i < 4; i += 1) top = (top << 16n) | BigInt(groups[i]);
  return top;
}

function parseDelegated(text, v4, v6) {
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const f = line.split('|');
    if (f.length < 7) continue;
    const cc = f[1];
    const type = f[2];
    const status = f[6];
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    if (status !== 'allocated' && status !== 'assigned') continue;
    if (type === 'ipv4') {
      const start = ipv4ToInt(f[3]);
      const count = Number(f[4]);
      if (start === null || !Number.isSafeInteger(count) || count <= 0) continue;
      const end = start + count - 1;
      if (end > 0xffffffff) continue;
      v4.push({ start, end, cc });
    } else if (type === 'ipv6') {
      const start = ipv6Top64(f[3]);
      const len = Number(f[4]);
      if (start === null || !Number.isInteger(len) || len < 1 || len > 128) continue;
      // Префиксы длиннее /64 в этих файлах встречаются как единичные записи:
      // ниже /64 таблица не различает, вся такая запись сводится к одному /64.
      const span = len >= 64 ? 1n : 1n << BigInt(64 - len);
      v6.push({ start, end: start + span - 1n, cc });
    }
  }
}

/** Сортировка по началу и склейка соседних диапазонов одной страны. */
function normalize(ranges, one) {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && last.cc === r.cc && r.start <= last.end + one) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    // Перекрытие разных стран: побеждает диапазон, который начался раньше —
    // усечь позднего честнее, чем потерять раннего.
    if (last && r.start <= last.end) {
      if (r.end <= last.end) continue;
      out.push({ start: last.end + one, end: r.end, cc: r.cc });
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

async function main() {
  const v4 = [];
  const v6 = [];
  for (const mirrors of SOURCES) {
    let text = null;
    let lastError = null;
    for (const url of mirrors) {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_URL && text === null; attempt += 1) {
        process.stdout.write(`fetch ${url} (${attempt}) … `);
        try {
          text = await fetchText(url);
          process.stdout.write('ok\n');
        } catch (e) {
          lastError = e;
          process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      if (text !== null) break;
    }
    if (text === null) throw lastError ?? new Error(`не скачан ни один адрес: ${mirrors[0]}`);
    parseDelegated(text, v4, v6);
    process.stdout.write(`  parsed: v4=${v4.length} v6=${v6.length}\n`);
  }
  const n4 = normalize(v4, 1);
  const n6 = normalize(v6, 1n);
  const buf = Buffer.alloc(HEADER_BYTES + n4.length * 10 + n6.length * 18);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt32BE(n4.length, 4);
  buf.writeUInt32BE(n6.length, 8);
  let off = HEADER_BYTES;
  for (const r of n4) {
    buf.writeUInt32BE(r.start, off);
    buf.writeUInt32BE(r.end, off + 4);
    buf.write(r.cc, off + 8, 2, 'latin1');
    off += 10;
  }
  for (const r of n6) {
    buf.writeBigUInt64BE(r.start, off);
    buf.writeBigUInt64BE(r.end, off + 8);
    buf.write(r.cc, off + 16, 2, 'latin1');
    off += 18;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'geoip-country.bin');
  const tmp = `${target}.tmp`;
  // Запись через временный файл: сервер читает таблицу на лету, и застать её
  // наполовину переписанной он не должен.
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, target);
  process.stdout.write(`written ${target}: v4=${n4.length} v6=${n6.length} ${buf.length} bytes\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
