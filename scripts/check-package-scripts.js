#!/usr/bin/env node
/**
 * Каждая команда из package.json ссылается только на существующие файлы (AC-05).
 *
 * До v4.32.721 двадцать команд вызывали shell-скрипты, которых в репозитории
 * уже не было, и `npm run build:release` падал на первом шаге. Проверка
 * запускается в CI, поэтому мёртвая команда больше не доживёт до релиза.
 *
 * Смотрим на пути вида `scripts/x.sh`, `e2e/y.js`, `./z.js` и на `cd dir`:
 * этого достаточно для команд, которые здесь пишут, и не требует разбирать
 * shell по-настоящему.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function check(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const problems = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    let cwd = pkgDir;
    for (const part of command.split(/&&|;|\|\|/)) {
      const cd = part.trim().match(/^cd\s+(\S+)/);
      if (cd) {
        cwd = path.resolve(cwd, cd[1]);
        if (!fs.existsSync(cwd)) problems.push(`${name}: нет каталога ${path.relative(root, cwd)}`);
        continue;
      }
      const refs = part.match(/(?:^|[\s'"=])((?:\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:sh|js|cjs|mjs|ts))(?=$|[\s'"])/g) || [];
      for (const raw of refs) {
        const ref = raw.trim().replace(/^['"=]/, '');
        if (!ref.includes('/') && !/^node\s|bash\s/.test(part.trim())) continue;
        const target = path.resolve(cwd, ref);
        if (!fs.existsSync(target)) problems.push(`${name}: нет файла ${path.relative(root, target)}`);
      }
    }
  }
  return problems;
}

if (require.main === module) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['.', 'signaling-server', 'server/cloud-vault'];
  const problems = dirs.flatMap((dir) => check(path.resolve(root, dir)).map((p) => `${dir}: ${p}`));
  if (problems.length) {
    console.error('Команды package.json ссылаются на отсутствующие файлы:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`package.json: все команды разрешают свои файлы (${dirs.join(', ')})`);
}

module.exports = { check };
