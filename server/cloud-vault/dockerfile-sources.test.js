/**
 * Каждый локальный модуль сервера доехал до образа.
 *
 * Dockerfile перечисляет исходники поимённо — так тесты не уезжают в прод.
 * Обратная сторона в 543-м вышла дорого: рядом с `index.js` появился
 * `reserved-usernames.js`, строку COPY никто не дописал, образ собрался молча,
 * и контейнер упал уже в проде на `Cannot find module`. При этом машина
 * отрапортовала «started», а `flyctl deploy` завершился нулём — единственным
 * признаком была строка «app is not listening» в середине вывода.
 *
 * Поэтому проверка здесь, а не в глазах человека: разбираем require'ы всех
 * файлов, которые попадают в образ, и требуем, чтобы каждый локальный модуль
 * тоже был в COPY.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const DIR = __dirname;

/**
 * Файлы из строк `COPY a.js b.js ./` — то, что реально едет в образ.
 *
 * Смотрим все строки COPY, а не первую подходящую: `package.json` тоже
 * содержит подстроку `.js`, и поиск «первой строки с .js» находил именно её,
 * после чего список исходников выходил пустым и проверка молча проходила.
 * Отсюда же и требование непустоты ниже.
 */
function copiedFiles() {
  const dockerfile = fs.readFileSync(path.join(DIR, 'Dockerfile'), 'utf8');
  const out = [];
  for (const line of dockerfile.split('\n')) {
    if (!line.startsWith('COPY')) continue;
    for (const token of line.replace(/^COPY\s+/, '').split(/\s+/)) {
      if (token.endsWith('.js')) out.push(token);
    }
  }
  assert.ok(out.includes('index.js'), 'в Dockerfile нет COPY с index.js — проверять нечего');
  return out;
}

/** Локальные зависимости файла: './x' → 'x.js'. Пакеты нас не касаются. */
function localRequires(file) {
  const source = fs.readFileSync(path.join(DIR, file), 'utf8');
  const out = [];
  const re = /require\(['"](\.[^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const target = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
    out.push(path.basename(target));
  }
  return out;
}

test('в образ попадает каждый модуль, который сервер требует', () => {
  const copied = copiedFiles();
  const missing = [];
  const seen = new Set();
  const queue = [...copied];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of localRequires(file)) {
      if (!copied.includes(dep)) missing.push(`${file} → ${dep}`);
      else queue.push(dep);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `эти модули не дописаны в COPY и упадут в проде:\n${missing.join('\n')}`,
  );
});
