#!/usr/bin/env node
/**
 * Бюджет загрузки веб-клиента (AC-22).
 *
 * На 19 сентября main-бандл весил ~6,4 МиБ несжатого JS. Для мессенджера на
 * нестабильной сети это надо держать под контролем, а не узнавать постфактум:
 * скрипт считает сырой и gzip-размер каждого JS из `expo export` и падает,
 * если суммарный размер стартовых скриптов (тех, что index.html грузит сам)
 * вырос за бюджет. Бюджет — текущее значение с небольшим запасом: снижать его
 * по мере разнесения редких экранов, повышать только осознанно.
 *
 *   node scripts/web-bundle-budget.js [dist] [--json]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Байты. Меняются вместе с комментарием о причине.
const BUDGET = {
  initialRaw: 7.0 * 1024 * 1024,
  initialGzip: 1.9 * 1024 * 1024,
};

function measure(dist) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const initial = new Set(
    [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1].replace(/^\//, ''))
  );
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const buf = fs.readFileSync(full);
        const rel = path.relative(dist, full).split(path.sep).join('/');
        files.push({
          file: rel,
          raw: buf.length,
          gzip: zlib.gzipSync(buf, { level: 9 }).length,
          initial: initial.has(rel),
        });
      }
    }
  };
  walk(dist);
  const sum = (list, key) => list.reduce((acc, f) => acc + f[key], 0);
  const start = files.filter((f) => f.initial);
  return {
    files: files.sort((a, b) => b.raw - a.raw),
    initialRaw: sum(start, 'raw'),
    initialGzip: sum(start, 'gzip'),
    totalRaw: sum(files, 'raw'),
  };
}

function check(result, budget = BUDGET) {
  const over = [];
  if (result.initialRaw > budget.initialRaw) over.push(`стартовый JS ${mib(result.initialRaw)} > ${mib(budget.initialRaw)}`);
  if (result.initialGzip > budget.initialGzip) over.push(`стартовый JS (gzip) ${mib(result.initialGzip)} > ${mib(budget.initialGzip)}`);
  return over;
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} МиБ`;

if (require.main === module) {
  const args = process.argv.slice(2);
  const dist = path.resolve(args.find((a) => !a.startsWith('--')) || 'dist');
  const result = measure(dist);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const f of result.files.slice(0, 8)) {
      console.log(`${f.initial ? '*' : ' '} ${mib(f.raw).padStart(10)}  gzip ${mib(f.gzip).padStart(10)}  ${f.file}`);
    }
    console.log(`стартовый JS: ${mib(result.initialRaw)} (gzip ${mib(result.initialGzip)}); всего JS ${mib(result.totalRaw)}`);
  }
  const over = check(result);
  if (over.length) {
    console.error('Бюджет веб-загрузки превышен:\n  ' + over.join('\n  '));
    process.exit(1);
  }
}

module.exports = { measure, check, BUDGET };
